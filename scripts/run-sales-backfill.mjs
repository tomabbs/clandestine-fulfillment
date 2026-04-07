/**
 * Sales backfill script with chunk-level audit log.
 *
 * Two processing modes:
 *   Mode A (full scan): cursor-based walk from coverage_start_date to now.
 *                        For connections with status pending/running/failed.
 *   Mode B (retry):     process only failed/missing chunks from the audit log.
 *                        For connections with status partial.
 *
 * Every API call writes a row to bandcamp_sales_backfill_log. A connection
 * is only marked "completed" when every expected chunk has a terminal-good
 * log entry AND a cross-check of SUM(sales_inserted) vs actual DB rows passes.
 *
 * Usage: node scripts/run-sales-backfill.mjs
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BC_CLIENT_ID = process.env.BANDCAMP_CLIENT_ID;
const BC_CLIENT_SECRET = process.env.BANDCAMP_CLIENT_SECRET;
if (!url || !key || !BC_CLIENT_ID || !BC_CLIENT_SECRET) {
  console.error("Missing env vars");
  process.exit(1);
}
const sb = createClient(url, key);

// ── Configurable constants (tune empirically, don't hardcode into logic) ──
const DELAY_MS = 3000;
const RETRY_WAIT_429 = 60_000;
const RETRY_WAIT_SERVER = 30_000;
const RETRY_WAIT_NETWORK = 15_000;
const RETRY_WAIT_TOKEN = 30_000;
const MAX_CHUNK_RETRIES = 3;
const SKIP_AHEAD_THRESHOLD = 6;

let accessToken = null;
let tokenExpiresAt = 0;

// ── OAuth token management ──────────────────────────────────────────────────

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 300_000) return accessToken;

  let creds = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await sb
      .from("bandcamp_credentials")
      .select("id, refresh_token, access_token, token_expires_at")
      .limit(1)
      .single();
    if (data) { creds = data; break; }
    console.log(`  WARNING: Credentials query returned null (attempt ${attempt + 1}/3, error: ${error?.message ?? "none"}), retrying in 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!creds) throw new Error("CREDENTIALS_UNAVAILABLE: Failed to read credentials after 3 attempts");

  if (creds.access_token && creds.token_expires_at) {
    const exp = new Date(creds.token_expires_at).getTime();
    if (Date.now() < exp - 300_000) {
      accessToken = creds.access_token;
      tokenExpiresAt = exp;
      return accessToken;
    }
  }

  console.log("  Refreshing OAuth token...");
  const res = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BC_CLIENT_ID,
      client_secret: BC_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
    }),
  });

  if (res.status === 429) {
    const wait = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    console.log(`  OAuth rate limited (429). Waiting ${wait}s...`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return ensureToken();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TOKEN_REFRESH_FAILED: ${res.status} ${text}`);
  }

  const parsed = await res.json();
  accessToken = parsed.access_token;
  tokenExpiresAt = Date.now() + parsed.expires_in * 1000;

  await sb.from("bandcamp_credentials").update({
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    token_expires_at: new Date(tokenExpiresAt).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", creds.id);

  console.log("  Token refreshed (valid for " + Math.round(parsed.expires_in / 60) + "m)");
  return accessToken;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Keep in sync with safeBigint in bandcamp-sales-backfill.ts and import-sales-csv.mjs
function safeBigint(val) {
  if (val == null) return null;
  const s = String(val);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

async function insertRows(workspaceId, connectionId, items) {
  const validItems = items.filter(item => {
    const txId = safeBigint(item.bandcamp_transaction_id);
    const txItemId = safeBigint(item.bandcamp_transaction_item_id);
    return txId !== null && txItemId !== null;
  });
  const skipped = items.length - validItems.length;
  if (skipped > 0) process.stdout.write(`[${skipped} payout/transfer records skipped] `);

  let inserted = 0;
  const batchSize = 100;
  // Keep in sync with insertSalesRows in bandcamp-sales-backfill.ts
  for (let i = 0; i < validItems.length; i += batchSize) {
    const batch = validItems.slice(i, i + batchSize);
    const rows = batch.map(item => ({
      workspace_id: workspaceId,
      connection_id: connectionId,
      bandcamp_transaction_id: safeBigint(item.bandcamp_transaction_id),
      bandcamp_transaction_item_id: safeBigint(item.bandcamp_transaction_item_id),
      bandcamp_related_transaction_id: safeBigint(item.bandcamp_related_transaction_id),
      sale_date: new Date(item.date).toISOString(),
      item_type: item.item_type ?? null,
      item_name: item.item_name ?? null,
      artist: item.artist ?? null,
      album_title: null,
      package: item.package ?? null,
      option_name: item.option ?? null,
      sku: item.sku ?? null,
      catalog_number: item.catalog_number ?? null,
      upc: item.upc ?? null,
      isrc: item.isrc ?? null,
      item_url: item.item_url ?? null,
      currency: item.currency ?? null,
      item_price: item.item_price ?? null,
      quantity: item.quantity ?? null,
      sub_total: item.sub_total ?? null,
      shipping: item.shipping ?? null,
      tax: null,
      seller_tax: item.seller_tax ?? null,
      marketplace_tax: item.marketplace_tax ?? null,
      tax_rate: item.tax_rate ?? null,
      transaction_fee: item.transaction_fee ?? null,
      fee_type: item.fee_type ?? null,
      item_total: item.item_total ?? null,
      amount_received: item.amount_you_received ?? null,
      net_amount: item.net_amount ?? null,
      additional_fan_contribution: item.additional_fan_contribution ?? null,
      discount_code: item.discount_code ?? null,
      collection_society_share: item.collection_society_share ?? null,
      buyer_name: item.buyer_name ?? null,
      buyer_email: item.buyer_email ?? null,
      buyer_phone: item.buyer_phone ?? null,
      buyer_note: item.buyer_note ?? null,
      ship_to_name: item.ship_to_name ?? null,
      ship_to_street: item.ship_to_street ?? null,
      ship_to_street_2: item.ship_to_street_2 ?? null,
      ship_to_city: item.ship_to_city ?? null,
      ship_to_state: item.ship_to_state ?? null,
      ship_to_zip: item.ship_to_zip ?? null,
      ship_to_country: item.ship_to_country ?? null,
      ship_to_country_code: item.ship_to_country_code ?? null,
      ship_date: item.ship_date ? new Date(item.ship_date).toISOString() : null,
      ship_notes: item.ship_notes ?? null,
      ship_from_country_name: item.ship_from_country_name ?? null,
      paid_to: item.paid_to ?? null,
      payment_state: item.payment_state ?? null,
      referer: item.referer ?? null,
      referer_url: item.referer_url ?? null,
      country: item.country ?? null,
      country_code: item.country_code ?? null,
      region_or_state: item.region_or_state ?? null,
      city: item.city ?? null,
      paypal_transaction_id: item.paypal_transaction_id ?? null,
    }));
    const { error } = await sb.from("bandcamp_sales").upsert(rows, {
      onConflict: "workspace_id,bandcamp_transaction_id,bandcamp_transaction_item_id",
      ignoreDuplicates: true,
    });
    if (!error) inserted += batch.length;
  }
  return inserted;
}

// ── Audit log helpers ───────────────────────────────────────────────────────

async function getNextAttempt(connectionId, chunkStart) {
  const { data } = await sb
    .from("bandcamp_sales_backfill_log")
    .select("attempt_number")
    .eq("connection_id", connectionId)
    .eq("chunk_start", chunkStart)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .single();
  return (data?.attempt_number ?? 0) + 1;
}

async function logChunk(workspaceId, connectionId, chunkStart, chunkEnd, status, salesReturned, salesInserted, httpStatus, errorMessage, startedAt) {
  const attempt = await getNextAttempt(connectionId, chunkStart);
  const now = new Date();
  await sb.from("bandcamp_sales_backfill_log").insert({
    workspace_id: workspaceId,
    connection_id: connectionId,
    chunk_start: chunkStart,
    chunk_end: chunkEnd,
    status,
    sales_returned: salesReturned,
    sales_inserted: salesInserted,
    http_status: httpStatus,
    error_message: errorMessage,
    attempt_number: attempt,
    started_at: startedAt.toISOString(),
    finished_at: now.toISOString(),
    duration_ms: now.getTime() - startedAt.getTime(),
  });
}

function buildExpectedChunks(coverageStart, now) {
  const chunks = [];
  let cursor = new Date(coverageStart);
  cursor.setDate(1);
  while (cursor < now) {
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + 1);
    chunks.push({
      start: cursor.toISOString().slice(0, 10),
      end: (end > now ? now : end).toISOString().slice(0, 10),
    });
    cursor = end;
  }
  return chunks;
}

async function getLatestAttempts(connectionId) {
  const allRows = [];
  let offset = 0;
  while (true) {
    const { data } = await sb
      .from("bandcamp_sales_backfill_log")
      .select("chunk_start, status, sales_inserted, error_message, attempt_number")
      .eq("connection_id", connectionId)
      .order("attempt_number", { ascending: false })
      .range(offset, offset + 999);
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  const map = new Map();
  for (const row of allRows) {
    const key = row.chunk_start;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

// ── Core chunk processor (shared between Mode A and Mode B) ─────────────────

async function processChunk(conn, startStr, endStr) {
  const chunkStartedAt = new Date();
  let retries = 0;

  while (retries < MAX_CHUNK_RETRIES) {
    try {
      const token = await ensureToken();
      const res = await fetch("https://bandcamp.com/api/sales/4/sales_report", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ band_id: conn.band_id, start_time: startStr, end_time: endStr }),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
        process.stdout.write(`429 (waiting ${retryAfter}s)... `);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        retries++;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, res.status, `Connection-level auth error: ${res.status}`, chunkStartedAt);
        return { status: "connection_failed", httpStatus: res.status };
      }

      if (res.status >= 500) {
        retries++;
        if (retries >= MAX_CHUNK_RETRIES) {
          await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, res.status, `Server error after ${MAX_CHUNK_RETRIES} retries: ${res.status}`, chunkStartedAt);
          return { status: "chunk_failed", inserted: 0 };
        }
        process.stdout.write(`${res.status} (retry ${retries}/${MAX_CHUNK_RETRIES})... `);
        await new Promise(r => setTimeout(r, RETRY_WAIT_SERVER));
        continue;
      }

      if (!res.ok) {
        await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, res.status, `Unexpected HTTP ${res.status}`, chunkStartedAt);
        return { status: "chunk_failed", inserted: 0 };
      }

      const data = await res.json();
      if (data.error) {
        await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, 200, `API error: ${data.error_message}`, chunkStartedAt);
        return { status: "chunk_failed", inserted: 0 };
      }

      const items = data.report ?? [];
      const inserted = await insertRows(conn.workspace_id, conn.id, items);
      await logChunk(conn.workspace_id, conn.id, startStr, endStr, "success", items.length, inserted, 200, null, chunkStartedAt);
      return { status: "success", inserted, salesReturned: items.length };
    } catch (err) {
      const msg = err.message ?? String(err);

      if (msg.includes("CREDENTIALS_UNAVAILABLE") || msg.includes("TOKEN_REFRESH_FAILED")) {
        accessToken = null;
        tokenExpiresAt = 0;
        retries++;
        if (retries >= MAX_CHUNK_RETRIES) {
          await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, null, `Token error after ${MAX_CHUNK_RETRIES} retries: ${msg}`, chunkStartedAt);
          return { status: "connection_failed", httpStatus: null };
        }
        process.stdout.write(`token error (retry ${retries}/${MAX_CHUNK_RETRIES})... `);
        await new Promise(r => setTimeout(r, RETRY_WAIT_TOKEN));
        continue;
      }

      if (msg.includes("fetch failed") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) {
        retries++;
        if (retries >= MAX_CHUNK_RETRIES) {
          await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, null, `Network error after ${MAX_CHUNK_RETRIES} retries: ${msg}`, chunkStartedAt);
          return { status: "chunk_failed", inserted: 0 };
        }
        process.stdout.write(`network error (retry ${retries}/${MAX_CHUNK_RETRIES})... `);
        await new Promise(r => setTimeout(r, RETRY_WAIT_NETWORK));
        continue;
      }

      await logChunk(conn.workspace_id, conn.id, startStr, endStr, "failed", 0, 0, null, msg.slice(0, 500), chunkStartedAt);
      return { status: "chunk_failed", inserted: 0 };
    }
  }

  return { status: "chunk_failed", inserted: 0 };
}

// ── Completion verification ─────────────────────────────────────────────────

async function verifyCompletion(conn, coverageStart) {
  const now = new Date();
  const expected = buildExpectedChunks(coverageStart, now);
  const latestAttempts = await getLatestAttempts(conn.id);

  let covered = 0;
  let failed = 0;
  let missing = 0;
  const failedChunks = [];

  for (const chunk of expected) {
    const log = latestAttempts.get(chunk.start);
    if (!log) {
      missing++;
    } else if (log.status === "success" || log.status === "skipped") {
      covered++;
    } else {
      failed++;
      failedChunks.push({ start: chunk.start, error: log.error_message });
    }
  }

  const { count: actualSales } = await sb
    .from("bandcamp_sales")
    .select("*", { count: "exact", head: true })
    .eq("connection_id", conn.id);

  const { data: logSum } = await sb
    .from("bandcamp_sales_backfill_log")
    .select("sales_inserted")
    .eq("connection_id", conn.id)
    .eq("status", "success");

  const expectedFromLog = (logSum ?? []).reduce((s, r) => s + (r.sales_inserted ?? 0), 0);
  const salesMismatch = Math.abs((actualSales ?? 0) - expectedFromLog) > 10;

  const gaps = failed + missing;
  const coveragePct = expected.length > 0 ? Math.round((covered / expected.length) * 100) : 0;

  return { expected: expected.length, covered, failed, missing, gaps, failedChunks, coveragePct, actualSales: actualSales ?? 0, salesMismatch };
}

function printAuditSummary(connName, verification) {
  const { expected, covered, failed, missing, gaps, failedChunks, coveragePct, actualSales, salesMismatch } = verification;
  const status = gaps === 0 && !salesMismatch ? "COMPLETED" : "PARTIAL";
  console.log(`\n  ${connName} — ${status}`);
  console.log(`    Chunks: ${covered}/${expected} covered (${coveragePct}%)`);
  if (failed > 0) console.log(`    Failed:  ${failed} (${failedChunks.map(f => f.start).join(", ")})`);
  if (missing > 0) console.log(`    Missing: ${missing} (never attempted)`);
  console.log(`    Sales in DB: ${actualSales.toLocaleString()}`);
  if (salesMismatch) console.log(`    WARNING: sales count mismatch between log and DB`);
  if (gaps > 0) console.log(`    -> Re-run to retry ${gaps} gap(s)`);
}

// ── Mode A: Full cursor-based scan ──────────────────────────────────────────

async function modeAFullScan(conn, state, coverageStart) {
  let cursor = state.last_processed_date
    ? new Date(state.last_processed_date)
    : new Date(coverageStart);
  cursor.setDate(1); // always align to 1st of month
  const now = new Date();
  let connInserted = 0;
  let consecutiveEmpty = 0;

  while (cursor < now) {
    if (consecutiveEmpty >= SKIP_AHEAD_THRESHOLD) {
      const jumpTo = new Date(cursor);
      jumpTo.setFullYear(jumpTo.getFullYear() + 1);
      jumpTo.setMonth(0, 1);
      if (jumpTo < now) {
        const skipStart = cursor.toISOString().slice(0, 10);
        const skipEnd = jumpTo.toISOString().slice(0, 10);
        console.log(`  >> ${consecutiveEmpty} empty months — skipping to ${skipEnd}`);
        await logChunk(conn.workspace_id, conn.id, skipStart, skipEnd, "skipped", 0, 0, null, `Skip-ahead: ${consecutiveEmpty} consecutive empty months`, new Date());
        cursor = jumpTo;
        consecutiveEmpty = 0;
        await sb.from("bandcamp_sales_backfill_state").update({
          last_processed_date: cursor.toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("connection_id", conn.id);
        continue;
      }
    }

    const chunkEnd = new Date(cursor);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    const effectiveEnd = chunkEnd > now ? now : chunkEnd;

    const startStr = cursor.toISOString().slice(0, 10);
    const endStr = effectiveEnd.toISOString().slice(0, 10);
    process.stdout.write(`  ${startStr} -> ${endStr} ... `);

    const result = await processChunk(conn, startStr, endStr);

    if (result.status === "connection_failed") {
      console.log(`CONNECTION FAILED (${result.httpStatus})`);
      await sb.from("bandcamp_sales_backfill_state").update({
        status: "failed",
        last_error: `Connection-level failure: HTTP ${result.httpStatus}`,
        updated_at: new Date().toISOString(),
      }).eq("connection_id", conn.id);
      return { connInserted, aborted: true };
    }

    if (result.status === "chunk_failed") {
      console.log("FAILED (logged, continuing)");
      consecutiveEmpty = 0;
    } else {
      const salesCount = result.salesReturned ?? 0;
      console.log(`${salesCount} sales (${result.inserted} new)`);
      connInserted += result.inserted;
      if (salesCount === 0) consecutiveEmpty++;
      else consecutiveEmpty = 0;
    }

    await sb.from("bandcamp_sales_backfill_state").update({
      last_processed_date: effectiveEnd.toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("connection_id", conn.id);

    cursor = effectiveEnd;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  return { connInserted, aborted: false };
}

// ── Mode B: Retry failed + fill missing chunks ─────────────────────────────

async function modeBRetryGaps(conn, coverageStart) {
  const now = new Date();
  const expected = buildExpectedChunks(coverageStart, now);
  const latestAttempts = await getLatestAttempts(conn.id);

  const gaps = [];
  for (const chunk of expected) {
    const log = latestAttempts.get(chunk.start);
    if (!log || log.status === "failed") {
      gaps.push(chunk);
    }
  }

  if (gaps.length === 0) {
    console.log("  No gaps found");
    return { connInserted: 0 };
  }

  console.log(`  ${gaps.length} gap(s) to retry`);
  let connInserted = 0;

  for (const gap of gaps) {
    process.stdout.write(`  ${gap.start} -> ${gap.end} ... `);
    const result = await processChunk(conn, gap.start, gap.end);

    if (result.status === "connection_failed") {
      console.log(`CONNECTION FAILED (${result.httpStatus})`);
      await sb.from("bandcamp_sales_backfill_state").update({
        status: "failed",
        last_error: `Connection-level failure: HTTP ${result.httpStatus}`,
        updated_at: new Date().toISOString(),
      }).eq("connection_id", conn.id);
      return { connInserted, aborted: true };
    }

    if (result.status === "chunk_failed") {
      console.log("STILL FAILED (logged)");
    } else {
      const salesCount = result.salesReturned ?? 0;
      console.log(`${salesCount} sales (${result.inserted} new)`);
      connInserted += result.inserted;
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  return { connInserted, aborted: false };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=================================================");
  console.log("  SALES BACKFILL WITH AUDIT LOG");
  console.log("  " + new Date().toISOString());
  console.log("=================================================\n");

  // Pause the cron
  const { data: wsSettings } = await sb.from("workspaces").select("id, bandcamp_scraper_settings").single();
  if (wsSettings) {
    const s = wsSettings.bandcamp_scraper_settings ?? {};
    s.pause_sales_backfill_cron = true;
    await sb.from("workspaces").update({ bandcamp_scraper_settings: s }).eq("id", wsSettings.id);
    console.log("Cron PAUSED\n");
  }

  const { data: connections } = await sb
    .from("bandcamp_connections")
    .select("id, band_id, band_name, workspace_id, created_at")
    .eq("is_active", true)
    .order("band_name");

  console.log(`Found ${connections.length} active connections\n`);

  let totalInserted = 0;
  const summaries = [];

  for (const conn of connections) {
    console.log(`\n-- ${conn.band_name} --`);

    let { data: state } = await sb
      .from("bandcamp_sales_backfill_state")
      .select("*")
      .eq("connection_id", conn.id)
      .single();

    if (!state) {
      await sb.from("bandcamp_sales_backfill_state").insert({
        connection_id: conn.id,
        workspace_id: conn.workspace_id,
        status: "running",
        total_transactions: 0,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      state = { status: "pending", last_processed_date: null, total_transactions: 0, coverage_start_date: null };
    }

    const coverageStart = state.coverage_start_date ?? conn.created_at?.slice(0, 10) ?? "2010-01-01";

    if (state.status === "completed") {
      const { count: existingSales } = await sb
        .from("bandcamp_sales")
        .select("*", { count: "exact", head: true })
        .eq("connection_id", conn.id);
      console.log(`  Already completed with ${existingSales} sales, skipping`);
      summaries.push({ name: conn.band_name, status: "completed", sales: existingSales ?? 0, coverage: 100, gaps: 0 });
      continue;
    }

    await sb.from("bandcamp_sales_backfill_state").update({
      status: "running",
      updated_at: new Date().toISOString(),
    }).eq("connection_id", conn.id);

    let result;
    if (state.status === "partial") {
      console.log("  Mode B: retrying gaps only");
      result = await modeBRetryGaps(conn, coverageStart);
    } else {
      console.log("  Mode A: full scan from", state.last_processed_date?.slice(0, 10) ?? coverageStart);
      result = await modeAFullScan(conn, state, coverageStart);
    }

    totalInserted += result.connInserted;

    if (result.aborted) {
      summaries.push({ name: conn.band_name, status: "failed", sales: 0, coverage: 0, gaps: -1 });
      continue;
    }

    const verification = await verifyCompletion(conn, coverageStart);
    printAuditSummary(conn.band_name, verification);

    const finalStatus = verification.gaps === 0 && !verification.salesMismatch ? "completed" : "partial";
    await sb.from("bandcamp_sales_backfill_state").update({
      status: finalStatus,
      total_transactions: verification.actualSales,
      ...(finalStatus === "completed" ? { completed_at: new Date().toISOString() } : {}),
      last_error: verification.gaps > 0 ? `${verification.failed} failed + ${verification.missing} missing chunks` : null,
      updated_at: new Date().toISOString(),
    }).eq("connection_id", conn.id);

    summaries.push({
      name: conn.band_name,
      status: finalStatus,
      sales: verification.actualSales,
      coverage: verification.coveragePct,
      gaps: verification.gaps,
    });
  }

  // Unpause the cron
  if (wsSettings) {
    const s = wsSettings.bandcamp_scraper_settings ?? {};
    delete s.pause_sales_backfill_cron;
    await sb.from("workspaces").update({ bandcamp_scraper_settings: s }).eq("id", wsSettings.id);
    console.log("\nCron UNPAUSED");
  }

  // Final summary
  console.log("\n=================================================");
  console.log("  FINAL AUDIT SUMMARY");
  console.log("=================================================");
  console.log(`\n  ${"Connection".padEnd(30)} ${"Status".padEnd(12)} ${"Sales".padStart(8)} ${"Coverage".padStart(9)} ${"Gaps".padStart(6)}`);
  console.log("  " + "-".repeat(70));
  for (const s of summaries) {
    console.log(`  ${s.name.padEnd(30)} ${s.status.padEnd(12)} ${String(s.sales).padStart(8)} ${(s.coverage + "%").padStart(9)} ${String(s.gaps).padStart(6)}`);
  }
  console.log(`\n  Total new sales inserted: ${totalInserted.toLocaleString()}`);
  console.log("=================================================");
}

main().catch(e => { console.error(e); process.exit(1); });
