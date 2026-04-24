/**
 * Phase 4 X-1.b extension — historical webhook burst audit.
 *
 * Question this answers: is the X-1.b enqueue ceiling (27.5 rps @ conc 10,
 * hard cliff at conc 15) a "today problem" or a "future problem at our
 * actual production scale"?
 *
 * Method: read the last 30 days of `webhook_events`, compute per-second
 * arrival rates per (workspace, platform, connection_id), and report:
 *
 *   - p50 / p75 / p95 / p99 / max per-second arrival rate, GLOBALLY
 *   - same percentiles per-platform (shopify, woocommerce, ...)
 *   - same percentiles per-connection (per-shop)
 *   - top 10 burstiest seconds in the window (which connection, when, rate)
 *   - count of seconds that exceeded the X-1.b ceiling (>= 15 events/sec)
 *   - count of seconds that hit the safe headroom (>= 10 events/sec)
 *
 * Also analyzes burst CLUSTERING — a 60-second sliding window arrival
 * count, since Trigger.dev's penalty-box duration is suspected to be
 * minute-scale rather than second-scale.
 *
 * Output: JSON + human-readable summary.
 *
 * Why this is safe / read-only:
 *   - SELECT only on `webhook_events`. No mutations. No side effects.
 *   - Operates on a single workspace at a time (default: all workspaces).
 *
 * Usage:
 *   pnpm tsx scripts/_phase4-x1b-historical-burst-audit.ts                         # last 30 days, all workspaces
 *   pnpm tsx scripts/_phase4-x1b-historical-burst-audit.ts --days=7
 *   pnpm tsx scripts/_phase4-x1b-historical-burst-audit.ts --workspace-id=...
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  days: number;
  workspaceId: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { days: 30, workspaceId: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--days=")) out.days = Math.max(1, Number.parseInt(a.slice("--days=".length), 10) || 30);
    else if (a.startsWith("--workspace-id=")) out.workspaceId = a.slice("--workspace-id=".length);
  }
  return out;
}

interface WebhookRow {
  created_at: string;
  workspace_id: string | null;
  platform: string;
  // `connection_id` lives inside `metadata.connection_id` per route handler;
  // we extract it client-side after the query (the column does not exist as
  // a top-level field on `webhook_events`).
  connection_id: string | null;
  external_webhook_id: string;
}

function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

interface BurstStats {
  active_second_count: number;
  total_events: number;
  rps_p50: number;
  rps_p75: number;
  rps_p95: number;
  rps_p99: number;
  rps_max: number;
  seconds_above_safe_headroom_10: number;
  seconds_above_x1b_ceiling_15: number;
  seconds_above_penalty_box_20: number;
  worst_seconds_top_10: { ts: string; rps: number; key: string }[];
}

function computeBurstStats(rows: WebhookRow[], keyFn: (r: WebhookRow) => string): BurstStats {
  // Bucket: second granularity, per key
  const perSecondPerKey = new Map<string, Map<string, number>>(); // key → { ts_second → count }
  for (const r of rows) {
    const key = keyFn(r);
    const ts = r.created_at;
    const tsSecond = ts.slice(0, 19); // YYYY-MM-DDTHH:MM:SS
    let inner = perSecondPerKey.get(key);
    if (!inner) {
      inner = new Map();
      perSecondPerKey.set(key, inner);
    }
    inner.set(tsSecond, (inner.get(tsSecond) ?? 0) + 1);
  }
  // Flatten to array of (key, ts_second, count) for percentile computation
  const flat: { key: string; ts: string; rps: number }[] = [];
  for (const [key, inner] of perSecondPerKey) {
    for (const [ts, count] of inner) flat.push({ key, ts, rps: count });
  }
  const rpsAsc = flat.map((f) => f.rps).sort((a, b) => a - b);
  const above10 = flat.filter((f) => f.rps >= 10).length;
  const above15 = flat.filter((f) => f.rps >= 15).length;
  const above20 = flat.filter((f) => f.rps >= 20).length;
  const top10 = [...flat].sort((a, b) => b.rps - a.rps).slice(0, 10);
  return {
    active_second_count: flat.length,
    total_events: rows.length,
    rps_p50: pct(rpsAsc, 50),
    rps_p75: pct(rpsAsc, 75),
    rps_p95: pct(rpsAsc, 95),
    rps_p99: pct(rpsAsc, 99),
    rps_max: rpsAsc[rpsAsc.length - 1] ?? 0,
    seconds_above_safe_headroom_10: above10,
    seconds_above_x1b_ceiling_15: above15,
    seconds_above_penalty_box_20: above20,
    worst_seconds_top_10: top10,
  };
}

interface SlidingWindowStats {
  window_seconds: number;
  worst_window_count: number;
  worst_window_starts_at: string | null;
  worst_window_key: string | null;
  windows_above_ceiling_in_window: number; // count of windows where event count exceeds (window_seconds * 27.5)
}

function computeSlidingWindow(rows: WebhookRow[], windowSec: number, keyFn: (r: WebhookRow) => string): SlidingWindowStats {
  const ceilingForWindow = windowSec * 27.5;
  // Sort all events by time, group by key
  const eventsByKey = new Map<string, number[]>(); // key → sorted array of unix timestamps
  for (const r of rows) {
    const key = keyFn(r);
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t)) continue;
    let arr = eventsByKey.get(key);
    if (!arr) {
      arr = [];
      eventsByKey.set(key, arr);
    }
    arr.push(t);
  }
  let worstCount = 0;
  let worstStartsAt: string | null = null;
  let worstKey: string | null = null;
  let windowsAboveCeiling = 0;
  for (const [key, ts] of eventsByKey) {
    ts.sort((a, b) => a - b);
    let left = 0;
    for (let right = 0; right < ts.length; right++) {
      while (ts[right] - ts[left] > windowSec * 1000) left++;
      const count = right - left + 1;
      if (count > worstCount) {
        worstCount = count;
        worstStartsAt = new Date(ts[left]).toISOString();
        worstKey = key;
      }
      if (count > ceilingForWindow) windowsAboveCeiling++;
    }
  }
  return {
    window_seconds: windowSec,
    worst_window_count: worstCount,
    worst_window_starts_at: worstStartsAt,
    worst_window_key: worstKey,
    windows_above_ceiling_in_window: windowsAboveCeiling,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createServiceRoleClient();
  const sinceIso = new Date(Date.now() - args.days * 86400_000).toISOString();

  console.log("Phase 4 X-1.b extension — historical webhook burst audit");
  console.log("─".repeat(72));
  console.log(`  window_days   : ${args.days}`);
  console.log(`  since         : ${sinceIso}`);
  console.log(`  workspace_id  : ${args.workspaceId ?? "(all)"}`);
  console.log("─".repeat(72));

  // Pull webhook_events in chunks (PostgREST page size 1000 default).
  // Connection identity lives in `metadata.connection_id` because the
  // table schema does not carry a top-level connection column. We project
  // it client-side after the page lands.
  const rows: WebhookRow[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    let q = sb
      .from("webhook_events")
      .select("created_at, workspace_id, platform, external_webhook_id, metadata")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
    const { data, error } = await q;
    if (error) {
      console.error("Query failed:", error);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const raw of data) {
      const r = raw as { created_at: string; workspace_id: string | null; platform: string; external_webhook_id: string; metadata: { connection_id?: string } | null };
      rows.push({
        created_at: r.created_at,
        workspace_id: r.workspace_id,
        platform: r.platform,
        connection_id: (r.metadata && typeof r.metadata.connection_id === "string" ? r.metadata.connection_id : null),
        external_webhook_id: r.external_webhook_id,
      });
    }
    if (data.length < PAGE) break;
    offset += PAGE;
    if (offset % 10000 === 0) console.log(`  …loaded ${offset} rows so far`);
  }
  console.log(`  loaded ${rows.length} webhook_events rows`);

  // Exclude probe traffic (phase4-burst-* and phase4-x1b-probe-*) — those
  // rows should already be reaped by the cleanup scripts but defend against
  // any that leaked into the window.
  const probeRows = rows.filter((r) =>
    r.external_webhook_id.startsWith("phase4-burst-") ||
    r.external_webhook_id.startsWith("phase4-x1b-probe-"),
  );
  const realRows = rows.filter((r) =>
    !r.external_webhook_id.startsWith("phase4-burst-") &&
    !r.external_webhook_id.startsWith("phase4-x1b-probe-"),
  );
  console.log(`  excluded ${probeRows.length} probe rows; ${realRows.length} real production rows remain`);
  console.log();

  if (realRows.length === 0) {
    console.log("No real-production webhook_events in window — nothing to analyze.");
    return;
  }

  const keyByConnection = (r: WebhookRow) => `${r.platform}:${r.connection_id ?? "(null)"}`;
  const keyByPlatform = (r: WebhookRow) => r.platform;
  const keyByGlobal = (_r: WebhookRow) => "(global)";

  const globalStats = computeBurstStats(realRows, keyByGlobal);
  const platformStats = computeBurstStats(realRows, keyByPlatform);
  const connectionStats = computeBurstStats(realRows, keyByConnection);

  // Per-connection breakdown for the report
  const perConnectionTopBursts = new Map<string, number>();
  for (const w of connectionStats.worst_seconds_top_10) {
    perConnectionTopBursts.set(w.key, Math.max(perConnectionTopBursts.get(w.key) ?? 0, w.rps));
  }

  const sw60 = computeSlidingWindow(realRows, 60, keyByConnection);
  const sw300 = computeSlidingWindow(realRows, 300, keyByConnection);

  const report = {
    audit_id: `historical-burst-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    generated_at: new Date().toISOString(),
    window: { days: args.days, since: sinceIso },
    workspace_filter: args.workspaceId,
    total_events: realRows.length,
    by_global: globalStats,
    by_platform: platformStats,
    by_connection: connectionStats,
    sliding_window_60s: sw60,
    sliding_window_300s: sw300,
    interpretation: {
      x1b_ceiling_rps: 27.5,
      x1b_concurrency_inflection: 15,
      x1b_penalty_box_concurrency: 20,
      single_second_above_ceiling_seen: connectionStats.seconds_above_x1b_ceiling_15 > 0,
      single_second_in_penalty_box_seen: connectionStats.seconds_above_penalty_box_20 > 0,
      verdict_text:
        connectionStats.seconds_above_penalty_box_20 > 0
          ? "URGENT: Production traffic has hit the penalty-box concurrency in the historical window. Phase 4 mitigations are not theoretical."
          : connectionStats.seconds_above_x1b_ceiling_15 > 0
            ? "WARNING: Production traffic has crossed the X-1.b ceiling in the historical window. Real but rare. Phase 4 mitigations recommended within current planning horizon."
            : connectionStats.seconds_above_safe_headroom_10 > 0
              ? "WATCHFUL: Production traffic has reached safe-headroom-warning level (≥10 rps in a single second). Headroom is bounded but not yet breached. Phase 4 mitigations can be planned conservatively."
              : "GREEN: Production traffic has never approached the X-1.b ceiling in the historical window. Phase 4 enqueue mitigations are theoretical at current scale; defer to Edge migration alone for F-7 close.",
    },
  };

  await mkdir("reports/phase4-burst", { recursive: true });
  const outFile = `reports/phase4-burst/${report.audit_id}.json`;
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");

  console.log("Per-connection burst stats:");
  console.log(`  active seconds            : ${connectionStats.active_second_count}`);
  console.log(`  total events              : ${connectionStats.total_events}`);
  console.log(`  rps p50/p75/p95/p99/max   : ${connectionStats.rps_p50} / ${connectionStats.rps_p75} / ${connectionStats.rps_p95} / ${connectionStats.rps_p99} / ${connectionStats.rps_max}`);
  console.log(`  seconds ≥10 rps (warn)    : ${connectionStats.seconds_above_safe_headroom_10}`);
  console.log(`  seconds ≥15 rps (X-1.b)   : ${connectionStats.seconds_above_x1b_ceiling_15}`);
  console.log(`  seconds ≥20 rps (penalty) : ${connectionStats.seconds_above_penalty_box_20}`);
  console.log();
  console.log("Top 10 burstiest seconds (per-connection):");
  for (const w of connectionStats.worst_seconds_top_10) {
    console.log(`  ${w.ts}Z  rps=${w.rps}  key=${w.key}`);
  }
  console.log();
  console.log("Sliding 60s window (per-connection):");
  console.log(`  worst window count        : ${sw60.worst_window_count} events in 60s @ ${sw60.worst_window_starts_at} on ${sw60.worst_window_key}`);
  console.log(`  windows above 60s ceiling (1650 events) : ${sw60.windows_above_ceiling_in_window}`);
  console.log();
  console.log("Sliding 300s (5-min) window (per-connection):");
  console.log(`  worst window count        : ${sw300.worst_window_count} events in 5min @ ${sw300.worst_window_starts_at} on ${sw300.worst_window_key}`);
  console.log(`  windows above 5-min ceiling (8250 events) : ${sw300.windows_above_ceiling_in_window}`);
  console.log();
  console.log("VERDICT:");
  console.log(`  ${report.interpretation.verdict_text}`);
  console.log();
  console.log(`Report written: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
