/**
 * One-off sales backfill script.
 *
 * Processes ALL connections from their last_processed_date to present.
 * Refreshes the OAuth token ONCE, reuses it for all connections.
 * No cron overhead, no Trigger.dev task scheduling, no time limits.
 *
 * Usage: node scripts/run-sales-backfill.mjs
 *
 * Run this ONCE to complete the initial backfill. After that,
 * the daily bandcamp-sales-sync cron handles ongoing updates.
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

const DELAY_MS = 600;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120;

let accessToken = null;
let tokenExpiresAt = 0;

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken;

  const { data: creds } = await sb
    .from("bandcamp_credentials")
    .select("refresh_token, access_token, token_expires_at")
    .limit(1)
    .single();

  if (creds?.access_token && creds?.token_expires_at) {
    const exp = new Date(creds.token_expires_at).getTime();
    if (Date.now() < exp - 60_000) {
      accessToken = creds.access_token;
      tokenExpiresAt = exp;
      console.log("  Using cached token (expires in " + Math.round((exp - Date.now()) / 60000) + "m)");
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const parsed = await res.json();
  accessToken = parsed.access_token;
  tokenExpiresAt = Date.now() + parsed.expires_in * 1000;

  await sb.from("bandcamp_credentials").update({
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    token_expires_at: new Date(tokenExpiresAt).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("refresh_token", creds.refresh_token);

  console.log("  Token refreshed (valid for " + Math.round(parsed.expires_in / 60) + "m)");
  return accessToken;
}

async function generateReport(bandId, startDate, endDate, token) {
  const res = await fetch("https://bandcamp.com/api/sales/4/generate_sales_report", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ band_id: bandId, start_time: startDate, end_time: endDate, format: "json" }),
  });
  if (!res.ok) throw new Error(`generate_sales_report failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`generate_sales_report error: ${data.error_message}`);
  return data.token;
}

async function pollReport(reportToken, token) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const res = await fetch("https://bandcamp.com/api/sales/4/fetch_sales_report", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: reportToken }),
    });
    if (!res.ok) throw new Error(`fetch_sales_report failed: ${res.status}`);
    const data = await res.json();
    if (data.error && data.error_message === "Report hasn't generated yet") {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    if (data.error) throw new Error(`fetch_sales_report error: ${data.error_message}`);
    return data.url;
  }
  throw new Error("Report poll timed out");
}

function safeBigint(val) {
  if (val == null) return null;
  const s = String(val);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null; // Non-numeric (e.g. "t878373461" payout records)
}

async function insertRows(workspaceId, connectionId, items) {
  // Filter out items with non-numeric transaction IDs (payouts, transfers)
  const validItems = items.filter(item => {
    const txId = safeBigint(item.bandcamp_transaction_id);
    const txItemId = safeBigint(item.bandcamp_transaction_item_id);
    return txId !== null && txItemId !== null;
  });
  const skipped = items.length - validItems.length;
  if (skipped > 0) process.stdout.write(`[${skipped} payout/transfer records skipped] `);

  let inserted = 0;
  const batchSize = 100;
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

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  ONE-OFF SALES BACKFILL");
  console.log("  " + new Date().toISOString());
  console.log("═══════════════════════════════════════════════\n");

  const { data: connections } = await sb
    .from("bandcamp_connections")
    .select("id, band_id, band_name, workspace_id")
    .eq("is_active", true)
    .order("band_name");

  console.log(`Found ${connections.length} active connections\n`);

  let totalInserted = 0;
  let totalChunks = 0;

  for (const conn of connections) {
    console.log(`\n── ${conn.band_name} ──`);

    // Get or create backfill state
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
      state = { last_processed_date: null, total_transactions: 0 };
    }

    const { count: existingSales } = await sb
      .from("bandcamp_sales")
      .select("*", { count: "exact", head: true })
      .eq("connection_id", conn.id);

    if (state.status === "completed" && (existingSales ?? 0) >= 10) {
      console.log("  Already completed with", existingSales, "sales, skipping");
      continue;
    }

    if (state.status === "completed" && (existingSales ?? 0) < 10) {
      console.log("  Marked completed but only", existingSales, "sales -- re-processing from scratch");
      state.last_processed_date = null;
      state.total_transactions = existingSales ?? 0;
    }

    await sb.from("bandcamp_sales_backfill_state").update({
      status: "running",
      updated_at: new Date().toISOString(),
    }).eq("connection_id", conn.id);

    let cursor = state.last_processed_date
      ? new Date(state.last_processed_date)
      : new Date("2010-01-01");
    const now = new Date();
    let connInserted = 0;

    while (cursor < now) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setFullYear(chunkEnd.getFullYear() + 1);
      const effectiveEnd = chunkEnd > now ? now : chunkEnd;

      const startStr = cursor.toISOString().slice(0, 10);
      const endStr = effectiveEnd.toISOString().slice(0, 10);
      process.stdout.write(`  ${startStr} -> ${endStr} ... `);

      try {
        const token = await ensureToken();
        const reportToken = await generateReport(conn.band_id, startStr, endStr, token);
        await new Promise(r => setTimeout(r, DELAY_MS));

        const reportUrl = await pollReport(reportToken, token);
        const reportRes = await fetch(reportUrl);
        if (!reportRes.ok) throw new Error(`Download failed: ${reportRes.status}`);
        const reportData = await reportRes.json();
        const items = Array.isArray(reportData) ? reportData : reportData.report ?? [];

        const inserted = await insertRows(conn.workspace_id, conn.id, items);
        connInserted += inserted;
        totalInserted += inserted;
        totalChunks++;

        // Update state
        const prevTotal = state.total_transactions ?? 0;
        state.total_transactions = prevTotal + inserted;
        await sb.from("bandcamp_sales_backfill_state").update({
          last_processed_date: effectiveEnd.toISOString(),
          total_transactions: state.total_transactions,
          earliest_sale_date: items.length > 0 ? new Date(items[items.length - 1].date).toISOString() : undefined,
          latest_sale_date: items.length > 0 ? new Date(items[0].date).toISOString() : undefined,
          updated_at: new Date().toISOString(),
        }).eq("connection_id", conn.id);

        console.log(`${items.length} sales (${inserted} new)`);
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        if (err.message.includes("429")) {
          console.log("  Rate limited! Waiting 30 seconds...");
          await new Promise(r => setTimeout(r, 30000));
          continue; // Retry same chunk
        }
        // Other errors: update state and move to next connection
        await sb.from("bandcamp_sales_backfill_state").update({
          status: "failed",
          last_error: String(err).slice(0, 500),
          updated_at: new Date().toISOString(),
        }).eq("connection_id", conn.id);
        break;
      }

      cursor = effectiveEnd;
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // Mark completed if we reached present
    if (cursor >= now) {
      await sb.from("bandcamp_sales_backfill_state").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("connection_id", conn.id);
      console.log(`  COMPLETED: ${connInserted} total sales for ${conn.band_name}`);
    }
  }

  // Cross-reference URLs
  console.log("\n── Cross-referencing album URLs ──");
  // Simple version: match subdomain+album_title from mappings to item_url from sales
  const { data: mappings } = await sb
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_album_title, bandcamp_subdomain")
    .not("bandcamp_album_title", "is", null)
    .not("bandcamp_subdomain", "is", null)
    .is("bandcamp_url", null);

  let urlsMatched = 0;
  if (mappings?.length) {
    const { data: albumSales } = await sb
      .from("bandcamp_sales")
      .select("item_url, item_name")
      .eq("item_type", "album")
      .not("item_url", "is", null)
      .limit(5000);

    const urlLookup = new Map();
    for (const sale of albumSales ?? []) {
      const match = sale.item_url.match(/https?:\/\/([^.]+)\.bandcamp\.com/);
      if (!match) continue;
      const k = match[1].toLowerCase() + "|" + (sale.item_name?.toLowerCase().trim() ?? "");
      if (!urlLookup.has(k)) urlLookup.set(k, sale.item_url);
    }

    for (const m of mappings) {
      const k = (m.bandcamp_subdomain?.toLowerCase() ?? "") + "|" + (m.bandcamp_album_title?.toLowerCase().trim() ?? "");
      const u = urlLookup.get(k);
      if (u) {
        await sb.from("bandcamp_product_mappings").update({
          bandcamp_url: u,
          bandcamp_url_source: "orders_api",
          updated_at: new Date().toISOString(),
        }).eq("id", m.id);
        urlsMatched++;
      }
    }
  }
  console.log(`  Matched ${urlsMatched} URLs from sales to mappings`);

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  DONE: ${totalInserted} sales inserted across ${totalChunks} chunks`);
  console.log("═══════════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exit(1); });
