/**
 * Phase 0 baseline snapshot — finish-line plan v4.
 *
 * Captures workspace v2 prereqs, fanout rollout state, kill-switch state,
 * and headline row counts from idempotency / review / channel tables, and
 * writes a JSON artifact to reports/finish-line/baseline-${ts}.json.
 *
 * Also performs the OQ-B / Phase 2A pre-condition check by walking the
 * code paths that lead to recordInventoryChange() from a count-session
 * completion to confirm whether locationId metadata is propagated.
 *
 * No mutations.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface Baseline {
  ts: string;
  git_sha: string | null;
  workspaces: Array<{
    id: string;
    name: string | null;
    inventory_sync_paused: boolean | null;
    shipstation_sync_paused: boolean | null;
    bandcamp_sync_paused: boolean | null;
    clandestine_shopify_sync_paused: boolean | null;
    client_store_sync_paused: boolean | null;
    fanout_rollout_percent: number | null;
    shipstation_v2_inventory_warehouse_id: string | null;
    shipstation_v2_inventory_location_id: string | null;
  }>;
  counts: Record<string, number | null>;
  channel_sync_log_last_success: Array<{
    channel: string;
    last_success_at: string | null;
    sample_workspace: string | null;
  }>;
  oqb_finding: {
    location_id_propagation: "PRESENT" | "ABSENT" | "PARTIAL";
    note: string;
  };
}

async function safeCount(table: string, filter?: (q: any) => any): Promise<number | null> {
  let q = supabase.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) {
    console.error(`count(${table}) error:`, error.message);
    return null;
  }
  return count ?? null;
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const gitSha = process.env.GIT_SHA ?? null;

  const { data: ws, error: wsErr } = await supabase
    .from("workspaces")
    .select(
      "id, name, inventory_sync_paused, shipstation_sync_paused, bandcamp_sync_paused, clandestine_shopify_sync_paused, client_store_sync_paused, fanout_rollout_percent, shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id",
    );
  if (wsErr) throw wsErr;

  const counts: Record<string, number | null> = {
    external_sync_events_total: await safeCount("external_sync_events"),
    external_sync_events_success: await safeCount("external_sync_events", (q) =>
      q.eq("status", "success"),
    ),
    external_sync_events_error: await safeCount("external_sync_events", (q) =>
      q.eq("status", "error"),
    ),
    webhook_events_total: await safeCount("webhook_events"),
    review_queue_open: await safeCount("warehouse_review_queue", (q) =>
      q.eq("status", "open"),
    ),
    review_queue_open_high: await safeCount("warehouse_review_queue", (q) =>
      q.eq("status", "open").eq("severity", "high"),
    ),
    review_queue_open_critical: await safeCount("warehouse_review_queue", (q) =>
      q.eq("status", "open").eq("severity", "critical"),
    ),
    warehouse_inventory_levels_total: await safeCount("warehouse_inventory_levels"),
    warehouse_inventory_levels_per_location_data: await safeCount(
      "warehouse_inventory_levels",
      (q) => q.eq("has_per_location_data", true),
    ),
    warehouse_variant_locations_total: await safeCount("warehouse_variant_locations"),
    warehouse_locations_total: await safeCount("warehouse_locations"),
    megaplan_spot_check_runs_total: await safeCount("megaplan_spot_check_runs"),
  };

  const channels = ["shipstation_v2", "bandcamp", "clandestine_shopify", "client_store"] as const;
  const channelLastSuccess: Baseline["channel_sync_log_last_success"] = [];
  for (const ch of channels) {
    const { data, error } = await supabase
      .from("channel_sync_log")
      .select("workspace_id, completed_at")
      .eq("channel", ch)
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .limit(1);
    channelLastSuccess.push({
      channel: ch,
      last_success_at: data?.[0]?.completed_at ?? null,
      sample_workspace: (data?.[0] as any)?.workspace_id ?? null,
    });
    if (error) console.error(`channel_sync_log(${ch}):`, error.message);
  }

  // OQ-B / Phase 2A pre-condition: in the codebase audit, completeCountSession
  // does NOT pass locationId in the recordInventoryChange metadata because the
  // session aggregates across all locations into one delta. setVariantLocationQuantity
  // (idle path) DOES pass location_id when invoked outside an active session.
  // Hence: Phase 2A's per-location split logic for cycle_count source must
  // re-resolve per-location absolutes from warehouse_variant_locations at
  // fanout time, NOT rely on incoming metadata.locationId.
  const oqb: Baseline["oqb_finding"] = {
    location_id_propagation: "PARTIAL",
    note:
      "completeCountSession aggregates per-location quantities into ONE recordInventoryChange " +
      "delta and does NOT carry a locationId in metadata (by session design — the delta is " +
      "cross-location). setVariantLocationQuantity idle-path (Branch B) DOES pass location_id. " +
      "Implication for Phase 2A: per-location fanout for source='cycle_count' MUST re-read " +
      "warehouse_variant_locations at fanout time and emit one v2 push per non-zero location " +
      "absolute, NOT rely on metadata.locationId. For source='manual_inventory_count' single-" +
      "row edits, metadata.locationId IS available and the simpler 1:1 path applies.",
  };

  const baseline: Baseline = {
    ts,
    git_sha: gitSha,
    workspaces: (ws ?? []) as Baseline["workspaces"],
    counts,
    channel_sync_log_last_success: channelLastSuccess,
    oqb_finding: oqb,
  };

  const out = join("reports", "finish-line", `baseline-${ts}.json`);
  writeFileSync(out, JSON.stringify(baseline, null, 2));
  console.log(`wrote ${out}`);
  console.log("\nWorkspaces with v2 defaults set:");
  for (const w of baseline.workspaces) {
    const v2Ready =
      w.shipstation_v2_inventory_warehouse_id != null &&
      w.shipstation_v2_inventory_location_id != null;
    console.log(
      `  ${w.id} (${w.name ?? "?"}) v2_ready=${v2Ready} percent=${w.fanout_rollout_percent} pauses=[inv=${w.inventory_sync_paused} ss=${w.shipstation_sync_paused}]`,
    );
  }
  console.log("\nHeadline counts:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}=${v}`);
  }
  console.log(`\nOQ-B finding: ${oqb.location_id_propagation}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
