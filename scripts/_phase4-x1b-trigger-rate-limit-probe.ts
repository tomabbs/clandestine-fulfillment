/**
 * Phase 4 X-1.b probe — empirical characterization of Trigger.dev v4
 * `tasks.trigger()` enqueue rate-limit, as exposed via the
 * `/api/webhooks/client-store` Node ingress route.
 *
 * Run #1 (2026-04-24T11:09Z) showed 77% `enqueue_failed` 503s at 50
 * concurrent × 60s sustained. That tells us "the ceiling is somewhere
 * BELOW 50" but doesn't tell us the actual ceiling, the recovery time,
 * or the sustainable steady-state throughput. This probe answers all
 * three.
 *
 * Method: binary-step concurrency through a fixed ladder, fire a short
 * burst (10s) at each step, wait for the rate-limit bucket to refill
 * (60s), measure outcomes per step. Identifies the **inflection
 * concurrency** where the 503 rate crosses 5%.
 *
 * Why this matters for the Phase 4 architecture decision (X-1.b in
 * `docs/DEFERRED_FOLLOWUPS.md`):
 *
 *   - If ceiling > 30 concurrent: the saturation we saw is only a
 *     concern at extreme bursts. Edge migration (X-1) is sufficient
 *     because Edge cold-start is the dominant latency, not enqueue
 *     contention.
 *
 *   - If ceiling 10-30 concurrent: real-world Shopify multi-shop
 *     bursts (e.g. label-wide inventory edit on 5 shops simultaneously
 *     × 10 SKUs each = 50 webhooks) will trip it. Edge migration
 *     alone won't fix this; we ALSO need batch enqueue / waitUntil()
 *     decoupling (§9.5 deliverable 2).
 *
 *   - If ceiling < 10 concurrent: this is a critical operational
 *     bottleneck regardless of Phase 4. Need urgent mitigation:
 *     either Trigger.dev plan upgrade, batchTrigger(), or
 *     Postgres NOTIFY consumer.
 *
 * Side-effects (per step, ~10s burst at concurrency N):
 *   - ~N × 10 webhook_events rows created
 *   - Cleanup runs automatically after each step (so total leaked rows
 *     after run completion = 0)
 *   - All rows tagged `phase4-x1b-probe-{step}-{seq}` so manual cleanup
 *     is also possible via the standard cleanup script.
 *
 * Total runtime: ~8 steps × (10s burst + 60s recovery + ~5s cleanup)
 *   = ~10 minutes.
 *
 * Usage:
 *   pnpm tsx scripts/_phase4-x1b-trigger-rate-limit-probe.ts          # dry-run preview
 *   pnpm tsx scripts/_phase4-x1b-trigger-rate-limit-probe.ts --apply  # live
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const NORTHERN_SPY_SHOPIFY_CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";
const NORTHERN_SPY_SHOP_DOMAIN = "2b65b8-2.myshopify.com";
const NORTHERN_SPY_DEFAULT_LOCATION_ID = "81496244447";
const NORTHERN_SPY_PROBE_INVENTORY_ITEM_ID = "46765155614943";

const CONCURRENCY_LADDER = [2, 5, 10, 15, 20, 30, 40, 50];
const BURST_SECONDS_PER_STEP = 10;
const RECOVERY_SECONDS_BETWEEN_STEPS = 60;

interface CliArgs {
  apply: boolean;
  ladder: number[];
  burstSeconds: number;
  recoverySeconds: number;
  cleanupBetweenSteps: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    apply: false,
    ladder: CONCURRENCY_LADDER,
    burstSeconds: BURST_SECONDS_PER_STEP,
    recoverySeconds: RECOVERY_SECONDS_BETWEEN_STEPS,
    cleanupBetweenSteps: true,
  };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a === "--no-cleanup") out.cleanupBetweenSteps = false;
    else if (a.startsWith("--ladder=")) {
      out.ladder = a
        .slice("--ladder=".length)
        .split(",")
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (a.startsWith("--burst-seconds=")) {
      out.burstSeconds = Math.max(1, Number.parseInt(a.slice("--burst-seconds=".length), 10) || 10);
    } else if (a.startsWith("--recovery-seconds=")) {
      out.recoverySeconds = Math.max(0, Number.parseInt(a.slice("--recovery-seconds=".length), 10) || 60);
    }
  }
  return out;
}

interface SampleResult {
  startedAt: number;
  latencyMs: number;
  statusCode: number;
  ok: boolean;
  body: string;
  error: string | null;
}

interface StepResult {
  step_index: number;
  concurrency: number;
  duration_sec: number;
  total_requests: number;
  ok_count: number;
  error_count: number;
  status_breakdown: Record<string, number>;
  enqueued_throughput_rps: number; // 200-only req/sec
  total_throughput_rps: number;
  saturation_rate: number; // 503 / total
  ms_to_first_503: number | null;
  enqueued_count_before_first_503: number | null;
  ok_latency_p50: number;
  ok_latency_p95: number;
  err_latency_median: number;
  classification: "below_ceiling" | "at_ceiling" | "above_ceiling";
}

interface ProbeReport {
  run_id: string;
  started_at: string;
  ended_at: string;
  config: {
    targetUrl: string;
    connectionId: string;
    ladder: number[];
    burstSeconds: number;
    recoverySeconds: number;
    cleanupBetweenSteps: boolean;
  };
  steps: StepResult[];
  inflection: {
    last_below_ceiling: number | null; // highest concurrency with <5% 503
    first_above_ceiling: number | null; // lowest concurrency with >5% 503
    estimated_ceiling_rps: number | null; // best-guess sustained 200-only req/sec
    rationale: string;
  };
}

interface HmacContext {
  secret: string;
  url: string;
  shopDomain: string;
  locationId: string;
  inventoryItemId: string;
  runId: string;
  stepIndex: number;
}

function buildPayload(seq: number, ctx: HmacContext): { body: string; eventId: string } {
  const eventId = `phase4-x1b-probe-${ctx.runId}-step${ctx.stepIndex}-${String(seq).padStart(6, "0")}`;
  const body = JSON.stringify({
    inventory_item_id: Number.parseInt(ctx.inventoryItemId, 10),
    location_id: Number.parseInt(ctx.locationId, 10),
    available: 2,
    updated_at: new Date().toISOString(),
    admin_graphql_api_id: `gid://shopify/InventoryLevel/${ctx.inventoryItemId}?inventory_item_id=${ctx.inventoryItemId}`,
    _phase4_x1b_probe: true,
    _phase4_seq: seq,
    _phase4_step: ctx.stepIndex,
    _phase4_run_id: ctx.runId,
  });
  return { body, eventId };
}

function signHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

async function fireOne(seq: number, ctx: HmacContext, harnessStart: number): Promise<SampleResult> {
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
        "User-Agent": "clandestine-phase4-x1b-probe/1.0",
      },
      body,
    });
    const text = await res.text();
    return {
      startedAt,
      latencyMs: performance.now() - t0,
      statusCode: res.status,
      ok: res.ok,
      body: text.slice(0, 200),
      error: null,
    };
  } catch (err) {
    return {
      startedAt,
      latencyMs: performance.now() - t0,
      statusCode: 0,
      ok: false,
      body: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runStep(ctx: HmacContext, concurrency: number, durationSec: number, stepIndex: number): Promise<SampleResult[]> {
  const harnessStart = performance.now();
  const samples: SampleResult[] = [];
  const deadline = harnessStart + durationSec * 1000;
  const inflight = new Set<Promise<void>>();
  let seq = 0;
  const enqueue = () => {
    const mySeq = seq++;
    const p = fireOne(mySeq, { ...ctx, stepIndex }, harnessStart).then((res) => {
      samples.push(res);
      inflight.delete(p);
    });
    inflight.add(p);
  };
  while (performance.now() < deadline) {
    while (inflight.size < concurrency && performance.now() < deadline) enqueue();
    await Promise.race(inflight);
  }
  await Promise.all(inflight);
  return samples;
}

function summarizeStep(stepIndex: number, concurrency: number, durationSec: number, samples: SampleResult[]): StepResult {
  const breakdown: Record<string, number> = {};
  for (const s of samples) {
    const k = String(s.statusCode || "ERR");
    breakdown[k] = (breakdown[k] ?? 0) + 1;
  }
  const ok = samples.filter((s) => s.ok);
  const err = samples.filter((s) => !s.ok);
  const sortedSamples = [...samples].sort((a, b) => a.startedAt - b.startedAt);
  const firstErrIdx = sortedSamples.findIndex((s) => !s.ok);
  const msToFirst503 = firstErrIdx >= 0 ? Math.round(sortedSamples[firstErrIdx].startedAt) : null;
  const enqueuedBeforeFirst503 = firstErrIdx >= 0
    ? sortedSamples.slice(0, firstErrIdx).filter((s) => s.ok).length
    : null;
  const okLat = ok.map((s) => s.latencyMs).sort((a, b) => a - b);
  const errLat = err.map((s) => s.latencyMs).sort((a, b) => a - b);
  const saturationRate = samples.length > 0 ? err.length / samples.length : 0;
  const classification: StepResult["classification"] =
    saturationRate < 0.05 ? "below_ceiling" : saturationRate < 0.5 ? "at_ceiling" : "above_ceiling";
  return {
    step_index: stepIndex,
    concurrency,
    duration_sec: durationSec,
    total_requests: samples.length,
    ok_count: ok.length,
    error_count: err.length,
    status_breakdown: breakdown,
    enqueued_throughput_rps: Math.round((ok.length / durationSec) * 100) / 100,
    total_throughput_rps: Math.round((samples.length / durationSec) * 100) / 100,
    saturation_rate: Math.round(saturationRate * 1000) / 1000,
    ms_to_first_503: msToFirst503,
    enqueued_count_before_first_503: enqueuedBeforeFirst503,
    ok_latency_p50: Math.round(okLat[Math.floor(okLat.length * 0.5)] ?? 0),
    ok_latency_p95: Math.round(okLat[Math.floor(okLat.length * 0.95)] ?? 0),
    err_latency_median: Math.round(errLat[Math.floor(errLat.length * 0.5)] ?? 0),
    classification,
  };
}

async function cleanupStepRows(stepIndex: number, runId: string, sb: ReturnType<typeof createServiceRoleClient>): Promise<number> {
  const pattern = `phase4-x1b-probe-${runId}-step${stepIndex}-%`;
  const { count } = await sb
    .from("webhook_events")
    .select("id", { head: true, count: "exact" })
    .like("external_webhook_id", pattern);
  if (count && count > 0) {
    await sb.from("webhook_events").delete().like("external_webhook_id", pattern);
  }
  return count ?? 0;
}

function inflection(steps: StepResult[]): ProbeReport["inflection"] {
  let lastBelow: number | null = null;
  let firstAbove: number | null = null;
  let estimatedCeilingRps: number | null = null;
  for (const s of steps) {
    if (s.classification === "below_ceiling") {
      lastBelow = s.concurrency;
      // Sustainable steady-state throughput is the throughput we saw at the
      // highest concurrency that still cleared without saturation.
      estimatedCeilingRps = s.enqueued_throughput_rps;
    } else if (firstAbove === null && (s.classification === "at_ceiling" || s.classification === "above_ceiling")) {
      firstAbove = s.concurrency;
      // The 200-only throughput at the inflection is a better estimate of
      // sustainable RPS than at the last-below step (the last-below step
      // may have had spare capacity).
      estimatedCeilingRps = s.enqueued_throughput_rps;
    }
  }
  let rationale: string;
  if (lastBelow === null && firstAbove === null) {
    rationale = "No steps completed — cannot characterize.";
  } else if (lastBelow === null) {
    rationale = `Even the smallest concurrency (${steps[0]?.concurrency}) showed saturation; ceiling is below the ladder floor. Re-run with --ladder=1,2,3,4 to localize.`;
  } else if (firstAbove === null) {
    rationale = `Highest tested concurrency (${lastBelow}) still showed <5% saturation; ceiling is above the ladder ceiling. Re-run with higher concurrency steps to localize.`;
  } else {
    rationale = `Inflection bracket: last clean concurrency = ${lastBelow}, first saturated concurrency = ${firstAbove}. Sustainable enqueue throughput ≈ ${estimatedCeilingRps} req/sec.`;
  }
  return { last_below_ceiling: lastBelow, first_above_ceiling: firstAbove, estimated_ceiling_rps: estimatedCeilingRps, rationale };
}

async function main() {
  const args = parseArgs(process.argv);

  const sb = createServiceRoleClient();
  const { data: conn, error } = await sb
    .from("client_store_connections")
    .select("id, store_url, platform, webhook_secret, do_not_fanout, cutover_state")
    .eq("id", NORTHERN_SPY_SHOPIFY_CONN_ID)
    .single();
  if (error || !conn) {
    console.error("Connection lookup failed:", error);
    process.exit(1);
  }
  if (!conn.webhook_secret) {
    console.error("BLOCKED: connection.webhook_secret is NULL.");
    process.exit(2);
  }

  const targetUrl = `${env().NEXT_PUBLIC_APP_URL}/api/webhooks/client-store?connection_id=${conn.id}&platform=${conn.platform}`;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  const totalEstSec = args.ladder.length * (args.burstSeconds + args.recoverySeconds);
  console.log("Phase 4 X-1.b — Trigger.dev enqueue rate-limit probe");
  console.log("─".repeat(72));
  console.log(`  mode               : ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  ladder             : [${args.ladder.join(", ")}]`);
  console.log(`  burst per step     : ${args.burstSeconds}s`);
  console.log(`  recovery between   : ${args.recoverySeconds}s`);
  console.log(`  estimated runtime  : ~${Math.ceil(totalEstSec / 60)} min`);
  console.log(`  cleanup-per-step   : ${args.cleanupBetweenSteps}`);
  console.log(`  target URL         : ${targetUrl}`);
  console.log(`  run_id             : ${runId}`);
  console.log("─".repeat(72));
  console.log();

  if (!args.apply) {
    console.log("DRY-RUN — re-run with --apply to execute.");
    return;
  }

  const ctxBase: Omit<HmacContext, "stepIndex"> = {
    secret: conn.webhook_secret as string,
    url: targetUrl,
    shopDomain: NORTHERN_SPY_SHOP_DOMAIN,
    locationId: NORTHERN_SPY_DEFAULT_LOCATION_ID,
    inventoryItemId: NORTHERN_SPY_PROBE_INVENTORY_ITEM_ID,
    runId,
  };

  const startedAt = new Date().toISOString();
  const steps: StepResult[] = [];

  for (let i = 0; i < args.ladder.length; i++) {
    const concurrency = args.ladder[i];
    console.log(`[step ${i + 1}/${args.ladder.length}] concurrency=${concurrency}, ${args.burstSeconds}s burst…`);
    const samples = await runStep({ ...ctxBase, stepIndex: i }, concurrency, args.burstSeconds, i);
    const summary = summarizeStep(i, concurrency, args.burstSeconds, samples);
    steps.push(summary);
    console.log(
      `  → ${summary.total_requests} req, ${summary.ok_count} OK / ${summary.error_count} 503, ` +
        `sat=${(summary.saturation_rate * 100).toFixed(1)}%, ` +
        `enqueued_rps=${summary.enqueued_throughput_rps}, ` +
        `ms_to_first_503=${summary.ms_to_first_503 ?? "n/a"}, ` +
        `→ ${summary.classification}`,
    );

    if (args.cleanupBetweenSteps) {
      const cleaned = await cleanupStepRows(i, runId, sb);
      console.log(`  → cleanup: deleted ${cleaned} webhook_events rows`);
    }

    if (i < args.ladder.length - 1) {
      console.log(`  → recovering ${args.recoverySeconds}s before next step…`);
      await new Promise((r) => setTimeout(r, args.recoverySeconds * 1000));
    }
  }

  const endedAt = new Date().toISOString();
  const inflectionResult = inflection(steps);
  const report: ProbeReport = {
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    config: {
      targetUrl,
      connectionId: NORTHERN_SPY_SHOPIFY_CONN_ID,
      ladder: args.ladder,
      burstSeconds: args.burstSeconds,
      recoverySeconds: args.recoverySeconds,
      cleanupBetweenSteps: args.cleanupBetweenSteps,
    },
    steps,
    inflection: inflectionResult,
  };

  await mkdir("reports/phase4-burst", { recursive: true });
  const outFile = `reports/phase4-burst/x1b-probe-${runId}.json`;
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");

  console.log();
  console.log("─".repeat(72));
  console.log("Probe complete.");
  console.log(`  steps                       : ${steps.length}`);
  console.log(`  last clean concurrency      : ${inflectionResult.last_below_ceiling ?? "n/a"}`);
  console.log(`  first saturated concurrency : ${inflectionResult.first_above_ceiling ?? "n/a"}`);
  console.log(`  estimated ceiling RPS       : ${inflectionResult.estimated_ceiling_rps ?? "n/a"}`);
  console.log();
  console.log(`Rationale: ${inflectionResult.rationale}`);
  console.log();
  console.log(`Report written: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
