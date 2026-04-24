/**
 * Phase 4 Sub-pass A — webhook ingress burst-test harness.
 *
 * Purpose: produce the F-7 measurement that decision X-1 (plan §9.5) requires
 * before Phase 4 commits to an Edge / Cloudflare Workers ingress migration.
 * F-7 target: cold-start webhook ingress p95 < 800 ms; pipeline p99 < 5 s
 * (Shopify timeout budget). Two consecutive runs ≥ 24h apart that both fail
 * F-7 are the trigger for building the Phase 4 implementation.
 *
 * What this script does:
 *   1. Builds Shopify-shaped `inventory_levels/update` payloads with stable
 *      structure but unique `X-Shopify-Event-Id` per request, so each burst
 *      request passes HMAC verification AND the dedup gate (it traverses the
 *      FULL ingress pipeline: HMAC → JSON parse → freshness → INSERT
 *      webhook_events → tasks.trigger() → 200).
 *   2. Sends them concurrently against the LIVE production webhook route.
 *   3. Records per-request latency, status code, and response body.
 *   4. Computes p50 / p75 / p95 / p99 / max + cold-start proxy
 *      (first-request latency in each concurrency batch).
 *   5. Writes JSON to reports/phase4-burst/{run_id}.json and prints the
 *      F-7 verdict.
 *
 * Why this is safe to run against prod:
 *   - HMAC-signed with the connection's real `webhook_secret`, so a leaked
 *     burst URL can't be replayed.
 *   - Each request body uses an `inventory_item_id` already present on
 *     the Northern Spy connection AND sets `available` to a value the
 *     downstream `process-client-store-webhook` task will recognize as a
 *     no-op (legacy state + ShipStation-authoritative routing means the
 *     task ignores the row without mutating inventory). Worst case: ~N
 *     extra webhook_events rows + N Trigger task runs, all benign.
 *   - Stable `X-Shopify-Event-Id` prefix `phase4-burst-{run_id}-{seq}`
 *     means rows are easy to find and reap via the companion cleanup
 *     script.
 *   - All requests use realistic timestamps (not stale, not future) so
 *     the freshness check passes — we measure the real path, not a 401
 *     short-circuit.
 *
 * Why this is NOT a load test:
 *   - We're measuring **single-request latency under controlled
 *     concurrency**, NOT throughput-under-saturation. The default
 *     `--concurrency=10 --total=20` is intentionally tiny so the first
 *     run validates the harness without flooding production. Use
 *     `--scale=full` for the actual §9.5 spec (50 concurrent × 60s
 *     sustained).
 *
 * Usage:
 *   pnpm tsx scripts/_phase4-burst-test.ts                                # dry-run
 *   pnpm tsx scripts/_phase4-burst-test.ts --apply                        # smoke (10×20)
 *   pnpm tsx scripts/_phase4-burst-test.ts --apply --scale=full           # spec (50×60s)
 *   pnpm tsx scripts/_phase4-burst-test.ts --apply --concurrency=20 \
 *                                              --total=100                # custom burst
 *   pnpm tsx scripts/_phase4-burst-test.ts --apply --mode=sustained \
 *                                              --concurrency=50 --duration=60
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

// ── Defaults ───────────────────────────────────────────────────────────────

const NORTHERN_SPY_SHOPIFY_CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";
const NORTHERN_SPY_SHOP_DOMAIN = "2b65b8-2.myshopify.com";
const NORTHERN_SPY_DEFAULT_LOCATION_ID = "81496244447";
/** Real inventory_item_id on the Northern Spy connection (verified via
 *  _phase3-verify-northern-spy-connection.ts on 2026-04-24). */
const NORTHERN_SPY_PROBE_INVENTORY_ITEM_ID = "46765155614943"; // CS-NS-078

interface CliArgs {
  apply: boolean;
  connectionId: string;
  shopDomain: string;
  locationId: string;
  inventoryItemId: string;
  mode: "burst" | "sustained";
  concurrency: number;
  total: number;
  durationSec: number;
  warmupDelayMs: number;
  scale: "smoke" | "full" | "custom";
  reportLabel: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    apply: false,
    connectionId: NORTHERN_SPY_SHOPIFY_CONN_ID,
    shopDomain: NORTHERN_SPY_SHOP_DOMAIN,
    locationId: NORTHERN_SPY_DEFAULT_LOCATION_ID,
    inventoryItemId: NORTHERN_SPY_PROBE_INVENTORY_ITEM_ID,
    mode: "burst",
    concurrency: 10,
    total: 20,
    durationSec: 60,
    warmupDelayMs: 30_000,
    scale: "smoke",
    reportLabel: null,
  };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--mode=burst") out.mode = "burst";
    else if (a === "--mode=sustained") out.mode = "sustained";
    else if (a.startsWith("--concurrency=")) {
      out.concurrency = Math.max(1, Number.parseInt(a.slice("--concurrency=".length), 10) || 10);
      out.scale = "custom";
    } else if (a.startsWith("--total=")) {
      out.total = Math.max(1, Number.parseInt(a.slice("--total=".length), 10) || 20);
      out.scale = "custom";
    } else if (a.startsWith("--duration=")) {
      out.durationSec = Math.max(1, Number.parseInt(a.slice("--duration=".length), 10) || 60);
      out.scale = "custom";
    } else if (a.startsWith("--warmup-delay-ms=")) {
      out.warmupDelayMs = Math.max(0, Number.parseInt(a.slice("--warmup-delay-ms=".length), 10) || 0);
    } else if (a.startsWith("--connection-id=")) {
      out.connectionId = a.slice("--connection-id=".length);
    } else if (a.startsWith("--shop-domain=")) {
      out.shopDomain = a.slice("--shop-domain=".length);
    } else if (a.startsWith("--location-id=")) {
      out.locationId = a.slice("--location-id=".length);
    } else if (a.startsWith("--inventory-item-id=")) {
      out.inventoryItemId = a.slice("--inventory-item-id=".length);
    } else if (a.startsWith("--label=")) {
      out.reportLabel = a.slice("--label=".length).replace(/[^a-zA-Z0-9._-]/g, "-");
    } else if (a === "--scale=full") {
      out.scale = "full";
      out.mode = "sustained";
      out.concurrency = 50;
      out.durationSec = 60;
    } else if (a === "--scale=smoke") {
      out.scale = "smoke";
      out.mode = "burst";
      out.concurrency = 10;
      out.total = 20;
    }
  }
  return out;
}

interface SampleResult {
  seq: number;
  startedAt: number; // performance.now() relative to harness start
  latencyMs: number;
  statusCode: number;
  ok: boolean;
  body: string; // truncated
  error: string | null;
  /** The first request to fire after a long idle window is treated as a
   *  cold-start candidate. */
  coldCandidate: boolean;
}

interface BurstStats {
  count: number;
  ok_count: number;
  error_count: number;
  status_breakdown: Record<string, number>;
  p50_ms: number;
  p75_ms: number;
  p90_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
  min_ms: number;
}

interface BurstReport {
  run_id: string;
  started_at: string;
  ended_at: string;
  duration_sec: number;
  config: {
    mode: "burst" | "sustained";
    concurrency: number;
    total: number | null;
    durationSec: number | null;
    targetUrl: string;
    connectionId: string;
    shopDomain: string;
    scale: string;
    warmupDelayMs: number;
  };
  samples: SampleResult[];
  stats_all: BurstStats;
  stats_cold_proxy: BurstStats;
  verdict: {
    f7_cold_p95_pass: boolean;
    f7_cold_p95_threshold_ms: 800;
    shopify_timeout_p99_pass: boolean;
    shopify_timeout_p99_threshold_ms: 5000;
    rationale: string;
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function computeStats(samples: SampleResult[]): BurstStats {
  const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const breakdown: Record<string, number> = {};
  for (const s of samples) {
    const k = String(s.statusCode || "ERR");
    breakdown[k] = (breakdown[k] ?? 0) + 1;
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: samples.length,
    ok_count: samples.filter((s) => s.ok).length,
    error_count: samples.filter((s) => !s.ok).length,
    status_breakdown: breakdown,
    p50_ms: Math.round(percentile(sorted, 50)),
    p75_ms: Math.round(percentile(sorted, 75)),
    p90_ms: Math.round(percentile(sorted, 90)),
    p95_ms: Math.round(percentile(sorted, 95)),
    p99_ms: Math.round(percentile(sorted, 99)),
    max_ms: Math.round(sorted[sorted.length - 1] ?? 0),
    mean_ms: Math.round(sorted.length > 0 ? sum / sorted.length : 0),
    min_ms: Math.round(sorted[0] ?? 0),
  };
}

interface HmacContext {
  secret: string;
  url: string;
  shopDomain: string;
  locationId: string;
  inventoryItemId: string;
  runId: string;
}

function buildPayload(seq: number, ctx: HmacContext): { body: string; eventId: string } {
  const eventId = `phase4-burst-${ctx.runId}-${String(seq).padStart(6, "0")}`;
  // Shopify inventory_levels/update body shape (see Shopify docs).
  // `available` matches what we observed in the verification probe (CS-NS-078=2)
  // so the downstream task computes delta=0 against last_pushed_quantity and
  // exits as a no-op even if it does NOT take the legacy/SS-authoritative path.
  const body = JSON.stringify({
    inventory_item_id: Number.parseInt(ctx.inventoryItemId, 10),
    location_id: Number.parseInt(ctx.locationId, 10),
    available: 2,
    updated_at: new Date().toISOString(),
    admin_graphql_api_id: `gid://shopify/InventoryLevel/${ctx.inventoryItemId}?inventory_item_id=${ctx.inventoryItemId}`,
    // Marker so a human reading the row can tell it's a burst probe.
    _phase4_burst_probe: true,
    _phase4_seq: seq,
    _phase4_run_id: ctx.runId,
  });
  return { body, eventId };
}

function signHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

async function fireOne(
  seq: number,
  ctx: HmacContext,
  coldCandidate: boolean,
  harnessStart: number,
): Promise<SampleResult> {
  const { body, eventId } = buildPayload(seq, ctx);
  const sig = signHmac(body, ctx.secret);
  const startedAt = performance.now() - harnessStart;
  const t0 = performance.now();
  try {
    const res = await fetch(ctx.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-SHA256": sig,
        "X-Shopify-Topic": "inventory_levels/update",
        "X-Shopify-Event-Id": eventId,
        "X-Shopify-Webhook-Id": eventId,
        "X-Shopify-Triggered-At": new Date().toISOString(),
        "X-Shopify-Shop-Domain": ctx.shopDomain,
        "X-Shopify-API-Version": "2026-04",
        "User-Agent": "clandestine-phase4-burst/1.0",
      },
      body,
    });
    const text = await res.text();
    const latencyMs = performance.now() - t0;
    return {
      seq,
      startedAt,
      latencyMs,
      statusCode: res.status,
      ok: res.ok,
      body: text.slice(0, 200),
      error: null,
      coldCandidate,
    };
  } catch (err) {
    const latencyMs = performance.now() - t0;
    return {
      seq,
      startedAt,
      latencyMs,
      statusCode: 0,
      ok: false,
      body: "",
      error: err instanceof Error ? err.message : String(err),
      coldCandidate,
    };
  }
}

async function runBurst(
  ctx: HmacContext,
  args: CliArgs,
  runId: string,
): Promise<{ samples: SampleResult[]; harnessStart: number }> {
  const harnessStart = performance.now();
  const samples: SampleResult[] = [];

  if (args.mode === "burst") {
    let seq = 0;
    while (seq < args.total) {
      const batchSize = Math.min(args.concurrency, args.total - seq);
      const isFirstBatch = seq === 0;
      const batchPromises = Array.from({ length: batchSize }, (_unused, i) =>
        fireOne(seq + i, ctx, isFirstBatch && i < args.concurrency, harnessStart),
      );
      const batchResults = await Promise.all(batchPromises);
      samples.push(...batchResults);
      seq += batchSize;
      // brief pause between batches to let cold lambdas spin down (or stay
      // warm) — without it, a "burst" of 100 with concurrency 10 is 10
      // back-to-back warm batches, not 10 distinct cold-start opportunities.
      if (seq < args.total) await new Promise((r) => setTimeout(r, 250));
    }
  } else {
    // Sustained: maintain `--concurrency` in-flight for `--duration` seconds.
    const deadline = performance.now() + args.durationSec * 1000;
    let seq = 0;
    const inflight = new Set<Promise<void>>();
    let isFirstWave = true;

    const enqueue = () => {
      const mySeq = seq++;
      const p = fireOne(mySeq, ctx, isFirstWave, harnessStart).then((res) => {
        samples.push(res);
        inflight.delete(p);
      });
      inflight.add(p);
    };

    while (performance.now() < deadline) {
      while (inflight.size < args.concurrency && performance.now() < deadline) {
        enqueue();
      }
      isFirstWave = false;
      // Wait for at least one to settle before topping up.
      await Promise.race(inflight);
    }
    // Drain stragglers.
    await Promise.all(inflight);
  }

  return { samples, harnessStart };
}

async function main() {
  const args = parseArgs(process.argv);

  const sb = createServiceRoleClient();
  const { data: conn, error } = await sb
    .from("client_store_connections")
    .select("id, store_url, shopify_verified_domain, platform, webhook_secret, do_not_fanout, cutover_state")
    .eq("id", args.connectionId)
    .single();
  if (error || !conn) {
    console.error("Connection lookup failed:", error);
    process.exit(1);
  }
  if (!conn.webhook_secret) {
    console.error("BLOCKED: connection.webhook_secret is NULL — HMAC will fail. Run the Phase 3 webhook registration script first.");
    process.exit(2);
  }

  const targetUrl = `${env().NEXT_PUBLIC_APP_URL}/api/webhooks/client-store?connection_id=${conn.id}&platform=${conn.platform}`;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}${args.reportLabel ? `-${args.reportLabel}` : ""}`;

  const ctx: HmacContext = {
    secret: conn.webhook_secret as string,
    url: targetUrl,
    shopDomain: args.shopDomain,
    locationId: args.locationId,
    inventoryItemId: args.inventoryItemId,
    runId,
  };

  console.log("Phase 4 Sub-pass A — webhook ingress burst-test harness");
  console.log("─".repeat(72));
  console.log(`  mode               : ${args.apply ? "APPLY (live writes to prod webhook)" : "DRY-RUN"}`);
  console.log(`  scale              : ${args.scale}`);
  console.log(`  burst mode         : ${args.mode}`);
  console.log(`  concurrency        : ${args.concurrency}`);
  if (args.mode === "burst") console.log(`  total requests     : ${args.total}`);
  else console.log(`  duration           : ${args.durationSec} s`);
  console.log(`  warmup delay       : ${args.warmupDelayMs} ms (forces lambda cold-start before run)`);
  console.log(`  target URL         : ${targetUrl}`);
  console.log(`  connection.cutover : ${conn.cutover_state} (do_not_fanout=${conn.do_not_fanout})`);
  console.log(`  run_id             : ${runId}`);
  console.log("─".repeat(72));
  console.log();

  if (!args.apply) {
    console.log("DRY-RUN: would send Shopify-shaped, HMAC-signed inventory_levels/update");
    console.log("payloads to the live webhook route. Re-run with --apply to execute.");
    console.log();
    console.log("Estimated production side-effects of an APPLY run:");
    const totalReq = args.mode === "burst" ? args.total : args.concurrency * Math.ceil(args.durationSec * 2);
    console.log(`  webhook_events rows created : ~${totalReq}`);
    console.log(`  Trigger.dev runs queued     : ~${totalReq} (each likely no-ops via legacy path)`);
    console.log(`  external_webhook_id prefix  : phase4-burst-${runId}-`);
    console.log("Cleanup: DELETE FROM webhook_events WHERE external_webhook_id LIKE 'phase4-burst-%'");
    return;
  }

  if (args.warmupDelayMs > 0) {
    console.log(`Sleeping ${args.warmupDelayMs}ms to give Vercel lambdas time to spin down (force cold-start)…`);
    await new Promise((r) => setTimeout(r, args.warmupDelayMs));
  }

  console.log("Firing burst…");
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const { samples } = await runBurst(ctx, args, runId);
  const wallSec = (performance.now() - t0) / 1000;
  const endedAt = new Date().toISOString();

  const statsAll = computeStats(samples);
  const coldSamples = samples.filter((s) => s.coldCandidate);
  const statsCold = computeStats(coldSamples.length > 0 ? coldSamples : samples.slice(0, 1));

  const f7ColdPass = statsCold.p95_ms < 800;
  const shopifyTimeoutPass = statsAll.p99_ms < 5000;

  const report: BurstReport = {
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_sec: Math.round(wallSec * 1000) / 1000,
    config: {
      mode: args.mode,
      concurrency: args.concurrency,
      total: args.mode === "burst" ? args.total : null,
      durationSec: args.mode === "sustained" ? args.durationSec : null,
      targetUrl,
      connectionId: args.connectionId,
      shopDomain: args.shopDomain,
      scale: args.scale,
      warmupDelayMs: args.warmupDelayMs,
    },
    samples,
    stats_all: statsAll,
    stats_cold_proxy: statsCold,
    verdict: {
      f7_cold_p95_pass: f7ColdPass,
      f7_cold_p95_threshold_ms: 800,
      shopify_timeout_p99_pass: shopifyTimeoutPass,
      shopify_timeout_p99_threshold_ms: 5000,
      rationale: [
        `Cold-start proxy p95 = ${statsCold.p95_ms} ms (threshold 800 ms) → ${f7ColdPass ? "PASS" : "FAIL"}`,
        `Pipeline p99 = ${statsAll.p99_ms} ms (Shopify 5000 ms ceiling) → ${shopifyTimeoutPass ? "PASS" : "FAIL"}`,
      ].join("; "),
    },
  };

  await mkdir("reports/phase4-burst", { recursive: true });
  const outFile = `reports/phase4-burst/${runId}.json`;
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");

  console.log();
  console.log("Burst complete.");
  console.log(`  wall clock         : ${wallSec.toFixed(2)} s`);
  console.log(`  samples            : ${samples.length}`);
  console.log(`  ok / error         : ${statsAll.ok_count} / ${statsAll.error_count}`);
  console.log(`  status breakdown   : ${JSON.stringify(statsAll.status_breakdown)}`);
  console.log();
  console.log("Latency — all samples:");
  console.log(
    `  min=${statsAll.min_ms} mean=${statsAll.mean_ms} p50=${statsAll.p50_ms} p75=${statsAll.p75_ms} p90=${statsAll.p90_ms} p95=${statsAll.p95_ms} p99=${statsAll.p99_ms} max=${statsAll.max_ms} (ms)`,
  );
  console.log(`Latency — cold-start proxy (n=${statsCold.count}):`);
  console.log(
    `  min=${statsCold.min_ms} mean=${statsCold.mean_ms} p50=${statsCold.p50_ms} p75=${statsCold.p75_ms} p95=${statsCold.p95_ms} max=${statsCold.max_ms} (ms)`,
  );
  console.log();
  console.log("F-7 verdict:");
  console.log(`  cold-start p95 < 800 ms (F-7)        : ${f7ColdPass ? "PASS" : "FAIL"} (${statsCold.p95_ms} ms)`);
  console.log(`  pipeline p99 < 5000 ms (Shopify cap) : ${shopifyTimeoutPass ? "PASS" : "FAIL"} (${statsAll.p99_ms} ms)`);
  console.log();
  console.log(`Report written: ${outFile}`);
  console.log();
  console.log("Next:");
  console.log(`  - HOLD ≥ 24h, then rerun with --label=run2 to capture Run #2 of the X-1 gate.`);
  console.log(`  - Optional: cleanup test rows via DELETE FROM webhook_events WHERE external_webhook_id LIKE 'phase4-burst-${runId}-%'`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
