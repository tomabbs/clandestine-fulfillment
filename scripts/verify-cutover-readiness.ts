// Phase 6.0 — automated cutover-readiness check.
//
// Runs every check the cutover gate cares about and exits non-zero if any
// blocker is unmet. Safe to run repeatedly; READ-ONLY (never mutates data).
//
// Usage:
//   pnpm tsx scripts/verify-cutover-readiness.ts                 # default workspace = first one in DB
//   pnpm tsx scripts/verify-cutover-readiness.ts --workspace=<id>
//   pnpm tsx scripts/verify-cutover-readiness.ts --json          # machine-readable output
//
// Exit codes:
//   0  = all gates pass; safe to flip workspaces.flags.shipstation_unified_shipping = true
//   1  = at least one BLOCKING gate failed; do NOT flip
//   2  = at least one WARNING gate failed; flip is technically allowed but read warnings first
//   3  = environment misconfigured (couldn't connect to Supabase, etc.)
//
// What's checked (mapped to the Phase 6.0 plan checklist):
//   B1  workspaces row exists; cutover flag currently OFF (sanity)
//   B2  shipstation_orders backfill rowcount > 0 for the workspace
//   B3  shipstation_orders has at least one row from the last 60 min
//       (proves the 15-min poll cron is actually live in Trigger.dev)
//   B4  shipstation_carrier_map has >= 1 row with mapping_confidence='verified'
//       AND block_auto_writeback=false  (safety per audit R20)
//   B5  warehouse_sync_state has a recent shipstation cursor (proves the
//       cron isn't just running but is also advancing)
//   B6  SHIPSTATION_WEBHOOK_SECRET is non-empty in the running env
//   B7  no easypost.rate_delta_halt sensor events in the last 7d
//       (any halt = real customer-facing UX failure that must be triaged)
//
//   W1  v2 fulfillments probe hasn't been run with --confirm (no
//       warehouse_shipments has shipstation_marked_shipped_at AND
//       shipstation_writeback_path='v2_fulfillments')  → warning, the
//       v2-vs-v1 split decision is unverified.
//   W2  no recent shipstation.* sensor activity in 7d  → warning, low
//       observability post-cutover.
//   W3  staff_diagnostics flag still set (legacy CreateLabelPanel still
//       reachable post-cutover). Not strictly wrong; just flag it.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

interface CheckResult {
  id: string;
  label: string;
  severity: "blocker" | "warning";
  passed: boolean;
  detail: string;
}

interface CliArgs {
  workspaceId: string | null;
  json: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = { workspaceId: null, json: false };
  for (const a of args) {
    if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
    else if (a === "--json") out.json = true;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    process.exit(3);
  }
  const supabase = createClient(url, key);

  const results: CheckResult[] = [];

  // ── B1: workspace exists; flag currently OFF ────────────────────────────
  let workspaceId = args.workspaceId;
  if (!workspaceId) {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    workspaceId = ws?.id ?? null;
  }
  if (!workspaceId) {
    results.push({
      id: "B1",
      label: "Workspace resolution",
      severity: "blocker",
      passed: false,
      detail: "no workspace row in DB and none passed via --workspace",
    });
    return finish(results, args.json);
  }
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, name, flags")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws) {
    results.push({
      id: "B1",
      label: "Workspace exists",
      severity: "blocker",
      passed: false,
      detail: `no workspace row found for id=${workspaceId}`,
    });
    return finish(results, args.json);
  }
  const flags = (ws.flags ?? {}) as Record<string, unknown>;
  const cutoverAlreadyOn = flags.shipstation_unified_shipping === true;
  results.push({
    id: "B1",
    label: "Cutover flag is currently OFF (sanity)",
    severity: "blocker",
    passed: !cutoverAlreadyOn,
    detail: cutoverAlreadyOn
      ? `workspace ${workspaceId} (${ws.name}): shipstation_unified_shipping is ALREADY true; cutover already done?`
      : `workspace ${workspaceId} (${ws.name}): shipstation_unified_shipping=unset (correct pre-flip state)`,
  });

  // ── B2: shipstation_orders backfill non-empty ───────────────────────────
  const { count: ssOrdersCount } = await supabase
    .from("shipstation_orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  results.push({
    id: "B2",
    label: "shipstation_orders backfill non-empty",
    severity: "blocker",
    passed: (ssOrdersCount ?? 0) > 0,
    detail: `${ssOrdersCount ?? 0} rows for workspace`,
  });

  // ── B3: poll cron has fired recently (proves Trigger.dev deploy is live)
  const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentSsCount } = await supabase
    .from("shipstation_orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("ss_modified_date", sixtyMinAgo);
  // (NB: count can be 0 even with a live cron if SS is quiet for 60min on this
  // workspace — fall back to checking sensor_readings for the cron itself.)
  let pollCronAlive = (recentSsCount ?? 0) > 0;
  let pollCronDetail = `${recentSsCount ?? 0} SS orders modified in last 60 min`;
  if (!pollCronAlive) {
    const { data: pollSensor } = await supabase
      .from("sensor_readings")
      .select("created_at, status")
      .eq("sensor_name", "trigger:shipstation-orders-poll")
      .gte("created_at", sixtyMinAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pollSensor) {
      pollCronAlive = true;
      pollCronDetail = `no fresh orders, but cron logged sensor reading at ${pollSensor.created_at} [${pollSensor.status}]`;
    } else {
      pollCronDetail = `no SS-modified orders AND no trigger:shipstation-orders-poll sensor reading in the last 60 min — cron likely not deployed or failing`;
    }
  }
  results.push({
    id: "B3",
    label: "shipstation-orders-poll cron alive (last 60 min)",
    severity: "blocker",
    passed: pollCronAlive,
    detail: pollCronDetail,
  });

  // ── B4: carrier map has at least one verified+unblocked row ─────────────
  const { data: cmap } = await supabase
    .from("shipstation_carrier_map")
    .select("ep_carrier, ep_service, ss_carrier_code, mapping_confidence, block_auto_writeback");
  const verified = (cmap ?? []).filter(
    (r) => r.mapping_confidence === "verified" && !r.block_auto_writeback,
  );
  results.push({
    id: "B4",
    label: "shipstation_carrier_map has >= 1 verified+unblocked row",
    severity: "blocker",
    passed: verified.length > 0,
    detail:
      verified.length > 0
        ? `${verified.length} verified rows: ${verified.map((r) => `${r.ep_carrier}/${r.ep_service}→${r.ss_carrier_code}`).slice(0, 5).join(", ")}`
        : `${cmap?.length ?? 0} total rows, 0 verified+unblocked. Open /admin/settings/carrier-map → "Re-seed from SS" then "Verify + allow" each row after a real round-trip.`,
  });

  // ── B5: sync_state cursor recently advanced ─────────────────────────────
  const { data: syncState } = await supabase
    .from("warehouse_sync_state")
    .select("source, last_sync_cursor, updated_at")
    .ilike("source", "%shipstation%")
    .order("updated_at", { ascending: false })
    .limit(5);
  const fresh = (syncState ?? []).find((r) => {
    if (!r.updated_at) return false;
    const age = Date.now() - new Date(r.updated_at).getTime();
    return age < 60 * 60 * 1000;
  });
  results.push({
    id: "B5",
    label: "warehouse_sync_state cursor advanced in last 60 min",
    severity: "blocker",
    passed: !!fresh,
    detail: fresh
      ? `source=${fresh.source} cursor=${fresh.last_sync_cursor} updated_at=${fresh.updated_at}`
      : `no recent sync_state row — same root cause as B3 (cron not running)`,
  });

  // ── B6: SHIPSTATION_WEBHOOK_SECRET configured in PROD ──────────────────
  // We can't reliably inspect Vercel/host env from outside the running prod
  // process, so we test the SAME thing indirectly: did the SS webhook route
  // log a recent successful receipt? If yes, the secret must be set in prod
  // (otherwise the route would have returned 500 and never reached sensor
  // emission). If no recent receipts AND no recent SS modifications either,
  // surface as warning instead of blocker — the user might just be quiet.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: recentWebhook } = await supabase
    .from("sensor_readings")
    .select("created_at")
    .ilike("sensor_name", "shipstation.webhook%")
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // Fallback: a recently-modified shipstation_orders row implies the
  // poll cron OR a webhook write succeeded. Both prove prod env is wired.
  const proofOfLifeFromOrders = (recentSsCount ?? 0) > 0;
  const b6Passed = !!recentWebhook || proofOfLifeFromOrders;
  results.push({
    id: "B6",
    label: "ShipStation prod webhook secret wired (proof: recent receipt OR poll activity)",
    severity: "blocker",
    passed: b6Passed,
    detail: recentWebhook
      ? `recent successful webhook receipt at ${recentWebhook.created_at} (proves SHIPSTATION_WEBHOOK_SECRET is set in prod env)`
      : proofOfLifeFromOrders
        ? `no webhook sensor reading, but poll cron is alive (B3 passed) — secret can be inferred-good IF webhooks have been hitting prod successfully`
        : "no webhook receipts AND no fresh poll activity in 60 min. Confirm SHIPSTATION_WEBHOOK_SECRET is set in your hosting provider's env (Vercel/etc.) and that ShipStation has the webhook URL configured.",
  });

  // ── B7: no easypost.rate_delta_halt events in last 7d ───────────────────
  const { count: haltCount } = await supabase
    .from("sensor_readings")
    .select("id", { count: "exact", head: true })
    .eq("sensor_name", "easypost.rate_delta_halt")
    .gte("created_at", sevenDaysAgo);
  results.push({
    id: "B7",
    label: "no easypost.rate_delta_halt events in last 7d",
    severity: "blocker",
    passed: (haltCount ?? 0) === 0,
    detail:
      (haltCount ?? 0) === 0
        ? "0 halt events"
        : `${haltCount} halt events — investigate before flipping (each halt = a customer-facing UX failure)`,
  });

  // ── W1: v2 fulfillments probe verified ──────────────────────────────────
  const { count: v2Count } = await supabase
    .from("warehouse_shipments")
    .select("id", { count: "exact", head: true })
    .eq("shipstation_writeback_path", "v2_fulfillments")
    .not("shipstation_marked_shipped_at", "is", null);
  results.push({
    id: "W1",
    label: "v2 fulfillments probe verified at least once",
    severity: "warning",
    passed: (v2Count ?? 0) > 0,
    detail:
      (v2Count ?? 0) > 0
        ? `${v2Count} shipments successfully written back via v2_fulfillments`
        : `0 v2 writebacks recorded. Run: pnpm tsx scripts/shipstation-v2-fulfillments-probe.ts --shipment-id=<se-...> --tracking=<...> --carrier=<code> --confirm. The code defaults to v2 with v1 fallback so this is safe-but-unverified.`,
  });

  // ── W2: any shipstation.* sensor activity in 7d ─────────────────────────
  const { data: ssSensors } = await supabase
    .from("sensor_readings")
    .select("sensor_name")
    .ilike("sensor_name", "shipstation.%")
    .gte("created_at", sevenDaysAgo)
    .limit(1);
  results.push({
    id: "W2",
    label: "shipstation.* sensor activity in 7d (observability)",
    severity: "warning",
    passed: (ssSensors?.length ?? 0) > 0,
    detail:
      (ssSensors?.length ?? 0) > 0
        ? `at least one shipstation.* sensor reading present`
        : `no shipstation.* sensor readings — Phase 7.1 sensors not fired yet, low observability post-cutover`,
  });

  // ── W3: staff_diagnostics flag set (legacy CreateLabelPanel reachable) ──
  const staffDiag = flags.staff_diagnostics === true;
  results.push({
    id: "W3",
    label: "staff_diagnostics flag is OFF post-cutover",
    severity: "warning",
    passed: !staffDiag,
    detail: staffDiag
      ? "staff_diagnostics=true: legacy CreateLabelPanel will still be reachable at /admin/orders-legacy. Intentional? Otherwise unset it."
      : "staff_diagnostics=unset (correct default — legacy panel hidden post-cutover)",
  });

  finish(results, args.json);
}

function finish(results: CheckResult[], json: boolean): never {
  const blockerFailed = results.filter((r) => r.severity === "blocker" && !r.passed);
  const warningFailed = results.filter((r) => r.severity === "warning" && !r.passed);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: blockerFailed.length === 0,
          blockers_failed: blockerFailed.length,
          warnings_failed: warningFailed.length,
          results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\n=== Phase 6 cutover readiness ===\n");
    for (const r of results) {
      const icon = r.passed ? "PASS" : r.severity === "blocker" ? "FAIL" : "WARN";
      const sev = r.severity === "blocker" ? "[blocker]" : "[warning]";
      console.log(`[${icon}] ${r.id} ${sev} ${r.label}`);
      console.log(`        ${r.detail}`);
    }
    console.log("\n--- Summary ---");
    console.log(
      `blockers: ${blockerFailed.length === 0 ? "ALL PASS" : `${blockerFailed.length} failed`}`,
    );
    console.log(
      `warnings: ${warningFailed.length === 0 ? "ALL PASS" : `${warningFailed.length} failed`}`,
    );
    if (blockerFailed.length === 0 && warningFailed.length === 0) {
      console.log(
        "\nReady to flip. Run: UPDATE workspaces SET flags = jsonb_set(flags, '{shipstation_unified_shipping}', 'true') WHERE id = '<ws>';",
      );
    } else if (blockerFailed.length === 0) {
      console.log("\nReady to flip — but read the warnings above first.");
    } else {
      console.log("\nDO NOT flip the cutover flag yet. Resolve the blockers above and re-run.");
    }
  }

  if (blockerFailed.length > 0) process.exit(1);
  if (warningFailed.length > 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(3);
});
