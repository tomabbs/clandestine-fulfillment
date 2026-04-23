/**
 * Tiered ShipStation v2 ↔ DB reconcile sensor — Phase 5 (plan §7.1.6.1).
 *
 * Phase 4 establishes the bidirectional bridge at the SKU level (sale-poll
 * → ShipStation v2 decrement; SHIP_NOTIFY → Bandcamp focused push). Both
 * legs are ledger-gated and queue-pinned, so the same correlation_id can
 * never double-write. But focused legs can still drop:
 *   - a Trigger.dev outage between the source event and the focused enqueue
 *   - a fanout-guard pause flip mid-run
 *   - a manual edit in the ShipStation UI by warehouse staff
 *   - a 5xx from the v2 API on a ledger-success path
 *
 * Phase 5 is the steady-state safety net. It compares ShipStation v2's
 * `available` against our DB `warehouse_inventory_levels.available` per
 * SKU and ABSORBS the drift into our DB by writing a delta through
 * `recordInventoryChange({ source: 'reconcile' })`. ShipStation v2 is the
 * source of truth at this layer (it is what fulfilling staff see and pick
 * from; our DB is a derived projection). Treating v2 as truth means
 * reconcile NEVER writes to v2 — it always adjusts our DB.
 *
 * Three schedule tiers keep cost/latency aligned:
 *   - hot  (every 5 min):   `available <= HOT_LOW_STOCK_THRESHOLD` OR sold in last 24h
 *   - warm (every 30 min):  sold in last 30 days
 *   - cold (every 6h):      full corpus
 *
 * All three call the same `runShipstationBandcampReconcile(payload, ctx, deps)`
 * function, parameterized by `tier`. The schedule wrappers are thin shims
 * so the test surface stays pure (per the bundle-derived-drift pattern).
 *
 * Drift threshold tiers (plan §7.1.6.1):
 *   - |drift| <= SILENT_DRIFT_TOLERANCE (1):  silent auto-fix, no review item
 *   - |drift| 2-5:                            auto-fix + low-severity review
 *   - |drift|  > 5:                            auto-fix + high-severity review
 *
 * Skip rules:
 *   - Workspace without v2 wired (`shipstation_v2_inventory_warehouse_id`
 *     OR `_location_id` IS NULL) → entire workspace skipped. Reading v2
 *     without scoping to the workspace's warehouse would compare cross-
 *     tenant SKU collisions — a correctness problem, not a perf one.
 *   - Bundle parent SKUs (variants present in `bundle_components.bundle_variant_id`)
 *     → handled by the bundle-derived-drift sensor (Phase 2.5(c)). Including
 *     them here would always report drift because v2's row is the merchant's
 *     legacy value, not derived from components. Plan §7.1.6.1 excludes
 *     bundles from `shipstation.qty_drift` explicitly.
 *   - SKU at `available: 0` is invisible to `GET /v2/inventory?sku=…`
 *     (the empty `inventory: []` response is the row being deleted, not
 *     a query miss — Phase 0 §4.2.3). When our DB also says 0, treat as
 *     equal, NOT as drift. When our DB says > 0 but v2 returns no row,
 *     treat as our_value drift (we believe in stock that v2 disagrees
 *     about) and absorb.
 *   - `do_not_fanout` is irrelevant here — reconcile does NOT push to
 *     external systems. The auto-fix flows back into Clandestine Shopify
 *     via `recordInventoryChange()`'s built-in fanout, which is correct
 *     propagation of the v2 truth.
 *
 * Idempotency:
 *   - The `recordInventoryChange()` call uses `correlation_id =
 *     'reconcile:{tier}:{run_id}:{sku}'`. Repeated invocations of the
 *     same task run id short-circuit on Redis SETNX (Rule #47) and the
 *     `warehouse_inventory_activity (sku, correlation_id)` UNIQUE.
 *   - The review queue upsert uses `group_key =
 *     'reconcile.qty_drift:{workspace_id}:{sku}'` so re-detection bumps
 *     `occurrence_count` instead of inserting duplicates (Rule #55).
 *
 * Cost envelope:
 *   - Per workspace per run: ceil(sku_count / 50) v2 calls. Cold tier
 *     is the only one that scales with full catalog; hot/warm are
 *     bounded by the "low stock OR recently sold" filter and typically
 *     fit in 1-3 batches per workspace.
 *   - Pinned to `shipstationQueue` (concurrencyLimit 1) so reconcile
 *     bursts cannot starve real-time SHIP_NOTIFY processing or seed.
 *
 * Rule #7: createServiceRoleClient. Rule #20: writes ALWAYS through
 * `recordInventoryChange()`. Rule #59: NOT a bulk sync — even though it
 * touches many SKUs per run, it goes through the canonical write path
 * one SKU at a time so the activity log captures every adjustment.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import {
  type InventoryRecord,
  listInventory,
  V2_INVENTORY_LIST_BATCH_LIMIT,
} from "@/lib/clients/shipstation-inventory-v2";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

// ─── Constants ───────────────────────────────────────────────────────────────

export type ReconcileTier = "hot" | "warm" | "cold";

/**
 * Per plan §7.1.6.1 — drift of 0 or 1 unit is normal in-flight churn
 * (race window between SHIP_NOTIFY and the next sensor pass). Silent
 * auto-fix without opening a review item.
 */
export const SILENT_DRIFT_TOLERANCE = 1;

/** Boundary between low-severity (informational) and high-severity (Channels page surface). */
export const HIGH_SEVERITY_DRIFT_THRESHOLD = 5;

/** Hot-tier "low stock" SKU filter — anything <= this triggers per-5min recheck. */
export const HOT_LOW_STOCK_THRESHOLD = 10;

/** Hot-tier recency window for "recently sold" SKU filter. */
const HOT_RECENT_SALE_WINDOW_HOURS = 24;

/** Warm-tier recency window for "sold in the last 30 days" SKU filter. */
const WARM_RECENT_SALE_WINDOW_DAYS = 30;

/**
 * Pass 2 D6 — no-other-writer gate. Skip reconcile auto-fix when ANY
 * `client_store_sku_mappings` row for this (workspace, SKU) was pushed
 * to within the last 60s. Rationale:
 *   - Reconcile observes drift between ShipStation v2 and our DB and
 *     absorbs it via `recordInventoryChange(source='reconcile')`.
 *   - That recordInventoryChange triggers fanout to every channel —
 *     including Shopify CAS via `client-store-push-on-sku` and
 *     `clandestine-shopify-push-on-sku`.
 *   - If a Shopify (or other client-store) push happened within the
 *     last 60s for this SKU, the drift we observed MIGHT be caused by
 *     that in-flight push (the storefront's webhook hasn't echoed back
 *     to update our last-known remote yet). Absorbing now risks
 *     stomping over a write that's already converging.
 *   - 60s comfortably covers Shopify webhook propagation (typically
 *     <5s) plus our own webhook handler latency budget.
 *   - The drift row stays in `result.drifts` with
 *     `auto_fix_applied:false` + `skip_reason:'recent_other_writer'`
 *     so the next reconcile pass will pick it up if it persists.
 *
 * Why the gate is conservative (60s, not 5s):
 *   - We'd rather defer one reconcile round-trip than emit a churn
 *     pulse to Shopify CAS that the sensor itself caused.
 *   - The `inv.propagation_lag` sensor will surface the SKU as
 *     `delayed` if the gate keeps firing, which is the correct
 *     escalation path (operator visibility, not auto-stomping).
 */
export const RECONCILE_NO_OTHER_WRITER_WINDOW_MS = 60_000;

// ─── Public surface ──────────────────────────────────────────────────────────

export interface ReconcilePayload {
  /** Optional list of workspace IDs — defaults to every workspace. */
  workspaceIds?: string[];
  /** Skip the v2 fetch — used by tests that pre-stub the listInventory call. */
  skipShipstationFetch?: boolean;
}

export interface ReconcileDriftRow {
  sku: string;
  workspace_id: string;
  v2_available: number;
  our_available: number;
  drift: number;
  severity: "silent" | "low" | "high";
  auto_fix_applied: boolean;
  /** Pass 2 D6 — populated when the no-other-writer gate held the auto-fix. */
  skip_reason?: "recent_other_writer";
  /** ISO timestamp of the most recent client-store push that gated us. */
  most_recent_writer_at?: string;
  review_queue_id?: string;
}

export interface ReconcileWorkspaceResult {
  workspaceId: string;
  tier: ReconcileTier;
  candidatesEvaluated: number;
  v2RowsFound: number;
  driftDetected: number;
  silentFixes: number;
  lowReviewItemsUpserted: number;
  highReviewItemsUpserted: number;
  bundlesSkipped: number;
  /** Pass 2 D6 — count of drifts gated by the no-other-writer window. */
  recentWriterGated: number;
  drifts: ReconcileDriftRow[];
  notes?: string;
}

export interface ReconcileResult {
  tier: ReconcileTier;
  workspaces: ReconcileWorkspaceResult[];
}

export interface ReconcileDeps {
  supabase: ReturnType<typeof createServiceRoleClient>;
  inventoryFetcher?: typeof listInventory;
  getWorkspaceIds?: typeof getAllWorkspaceIds;
  recordInventoryChange?: typeof recordInventoryChange;
  /**
   * Pass 2 D6 — clock injection for the no-other-writer gate. Tests
   * pin Date.now() so the 60s window is deterministic. Defaults to
   * Date.now in production.
   */
  now?: () => number;
}

// ─── Internal row shapes ─────────────────────────────────────────────────────

interface InventoryLevelRow {
  variant_id: string;
  sku: string;
  available: number;
}

interface BundleComponentRow {
  bundle_variant_id: string;
}

interface RecentActivityRow {
  sku: string;
}

interface WorkspaceV2DefaultsRow {
  shipstation_v2_inventory_warehouse_id: string | null;
  shipstation_v2_inventory_location_id: string | null;
}

// ─── Inner runner (exported for tests) ───────────────────────────────────────

export async function runShipstationBandcampReconcile(
  tier: ReconcileTier,
  payload: ReconcilePayload,
  ctx: { run: { id: string } },
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const supabase = deps.supabase;
  const fetchInventory = payload.skipShipstationFetch
    ? async () => [] as InventoryRecord[]
    : (deps.inventoryFetcher ?? listInventory);
  const getWorkspaces = deps.getWorkspaceIds ?? getAllWorkspaceIds;
  const writeInventory = deps.recordInventoryChange ?? recordInventoryChange;
  const now = deps.now ?? Date.now;

  const workspaceIds =
    payload.workspaceIds && payload.workspaceIds.length > 0
      ? payload.workspaceIds
      : await getWorkspaces(supabase);

  const result: ReconcileResult = { tier, workspaces: [] };

  for (const workspaceId of workspaceIds) {
    const startedAt = new Date().toISOString();
    const wsResult = await runWorkspace(
      tier,
      workspaceId,
      ctx,
      fetchInventory,
      writeInventory,
      supabase,
      now,
    );
    result.workspaces.push(wsResult);

    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceId,
      channel: "shipstation_v2",
      sync_type: `reconcile_${tier}`,
      status: "completed",
      items_processed: wsResult.candidatesEvaluated,
      items_failed: wsResult.driftDetected,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      error_message: wsResult.notes ?? null,
    });
  }

  return result;
}

async function runWorkspace(
  tier: ReconcileTier,
  workspaceId: string,
  ctx: { run: { id: string } },
  fetchInventory: typeof listInventory,
  writeInventory: typeof recordInventoryChange,
  supabase: ReturnType<typeof createServiceRoleClient>,
  now: () => number,
): Promise<ReconcileWorkspaceResult> {
  const baseResult: ReconcileWorkspaceResult = {
    workspaceId,
    tier,
    candidatesEvaluated: 0,
    v2RowsFound: 0,
    driftDetected: 0,
    silentFixes: 0,
    lowReviewItemsUpserted: 0,
    highReviewItemsUpserted: 0,
    bundlesSkipped: 0,
    recentWriterGated: 0,
    drifts: [],
  };

  // 1) Workspace MUST have v2 wired — otherwise we'd compare cross-tenant SKUs.
  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id")
    .eq("id", workspaceId)
    .single<WorkspaceV2DefaultsRow>();

  if (!ws?.shipstation_v2_inventory_warehouse_id || !ws?.shipstation_v2_inventory_location_id) {
    baseResult.notes = "skipped_no_v2_defaults";
    return baseResult;
  }

  // 2) Bundle parent SKUs are excluded from this sensor (Phase 2.5(c) handles them).
  const { data: bundleRows } = await supabase
    .from("bundle_components")
    .select("bundle_variant_id")
    .eq("workspace_id", workspaceId);
  const bundleVariantIds = new Set(
    ((bundleRows ?? []) as BundleComponentRow[]).map((r) => r.bundle_variant_id),
  );

  // 3) Resolve the candidate SKU set per tier.
  const candidateSkus = await selectCandidateSkus(tier, workspaceId, bundleVariantIds, supabase);
  baseResult.candidatesEvaluated = candidateSkus.length;
  if (candidateSkus.length === 0) {
    baseResult.notes = "no_candidates";
    return baseResult;
  }

  // 4) Pull our inventory levels for the candidate SKUs in one query.
  const { data: levels } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, sku, available")
    .eq("workspace_id", workspaceId)
    .in("sku", candidateSkus);
  const ourBySku = new Map<string, { variantId: string; available: number }>();
  for (const row of (levels ?? []) as InventoryLevelRow[]) {
    if (bundleVariantIds.has(row.variant_id)) {
      baseResult.bundlesSkipped++;
      continue;
    }
    ourBySku.set(row.sku, {
      variantId: row.variant_id,
      available: Number(row.available) || 0,
    });
  }

  if (ourBySku.size === 0) {
    baseResult.notes = "all_candidates_bundles_or_missing";
    return baseResult;
  }

  // 5) Batch-fetch v2 inventory scoped to this workspace's warehouse + location.
  const v2Records = await fetchInventory({
    skus: Array.from(ourBySku.keys()),
    inventory_warehouse_id: ws.shipstation_v2_inventory_warehouse_id,
    inventory_location_id: ws.shipstation_v2_inventory_location_id,
  });
  baseResult.v2RowsFound = v2Records.length;
  const v2BySku = new Map<string, number>();
  for (const r of v2Records) v2BySku.set(r.sku, Number(r.available) || 0);

  // 5b) Pass 2 D6 — fetch most-recent client_store_sku_mappings.last_pushed_at
  //     per SKU for this workspace. Used by the no-other-writer gate
  //     in the per-SKU loop. We do this in a single query before the
  //     loop so we don't fan out one PostgREST call per drift row.
  const mostRecentPushBySku = await fetchMostRecentPushBySku(
    supabase,
    workspaceId,
    Array.from(ourBySku.keys()),
  );

  // 6) Per-SKU drift evaluation.
  for (const [sku, ours] of Array.from(ourBySku.entries())) {
    // SKU at 0 is invisible to `GET /v2/inventory?sku=…` (Phase 0 §4.2.3 —
    // the empty `inventory: []` response is the row being deleted, not a
    // query miss). When v2 omits a SKU we treat it as `available: 0`. If
    // our DB also says 0 the drift is 0 and we skip; if our DB says > 0
    // the absolute drift equals our value and we absorb downward.
    const v2Available = v2BySku.get(sku) ?? 0;
    const drift = v2Available - ours.available;
    if (Math.abs(drift) === 0) continue;

    // Pass 2 D6 — no-other-writer gate. Defer auto-fix when any
    // client-store push touched this SKU within the last 60s; the
    // observed drift may be in flight from that push and absorbing
    // would create a churn pulse. The drift is still RECORDED in
    // `result.drifts` (with skip_reason='recent_other_writer') so
    // operators / tests can see we deferred, and the next reconcile
    // round will pick it up if it persists.
    const mostRecent = mostRecentPushBySku.get(sku);
    const gated =
      mostRecent != null && now() - Date.parse(mostRecent) < RECONCILE_NO_OTHER_WRITER_WINDOW_MS;

    if (gated) {
      baseResult.driftDetected++;
      baseResult.recentWriterGated++;
      const severity: "silent" | "low" | "high" =
        Math.abs(drift) <= SILENT_DRIFT_TOLERANCE
          ? "silent"
          : Math.abs(drift) > HIGH_SEVERITY_DRIFT_THRESHOLD
            ? "high"
            : "low";
      baseResult.drifts.push({
        sku,
        workspace_id: workspaceId,
        v2_available: v2Available,
        our_available: ours.available,
        drift,
        severity,
        auto_fix_applied: false,
        skip_reason: "recent_other_writer",
        most_recent_writer_at: mostRecent,
      });
      logger.info("[shipstation-bandcamp-reconcile] no-other-writer gate held auto-fix", {
        workspaceId,
        sku,
        drift,
        most_recent_writer_at: mostRecent,
      });
      continue;
    }

    if (Math.abs(drift) <= SILENT_DRIFT_TOLERANCE) {
      // Silent auto-fix path — absorb the delta into our DB; no review item.
      const applied = await applyAutoFix(workspaceId, sku, drift, tier, ctx, writeInventory);
      baseResult.driftDetected++;
      if (applied) baseResult.silentFixes++;
      baseResult.drifts.push({
        sku,
        workspace_id: workspaceId,
        v2_available: v2Available,
        our_available: ours.available,
        drift,
        severity: "silent",
        auto_fix_applied: applied,
      });
      continue;
    }

    const severity: "low" | "high" =
      Math.abs(drift) > HIGH_SEVERITY_DRIFT_THRESHOLD ? "high" : "low";
    const applied = await applyAutoFix(workspaceId, sku, drift, tier, ctx, writeInventory);
    const reviewQueueId = await upsertDriftReviewItem(
      workspaceId,
      sku,
      ours.available,
      v2Available,
      drift,
      severity,
      tier,
      ctx,
      supabase,
    );

    baseResult.driftDetected++;
    if (severity === "high") baseResult.highReviewItemsUpserted++;
    else baseResult.lowReviewItemsUpserted++;

    baseResult.drifts.push({
      sku,
      workspace_id: workspaceId,
      v2_available: v2Available,
      our_available: ours.available,
      drift,
      severity,
      auto_fix_applied: applied,
      review_queue_id: reviewQueueId,
    });
  }

  logger.info("[shipstation-bandcamp-reconcile] workspace done", {
    workspaceId,
    tier,
    candidatesEvaluated: baseResult.candidatesEvaluated,
    v2RowsFound: baseResult.v2RowsFound,
    driftDetected: baseResult.driftDetected,
    silentFixes: baseResult.silentFixes,
    lowReviewItemsUpserted: baseResult.lowReviewItemsUpserted,
    highReviewItemsUpserted: baseResult.highReviewItemsUpserted,
    recentWriterGated: baseResult.recentWriterGated,
  });

  return baseResult;
}

// ─── Tier candidate-SKU selection ────────────────────────────────────────────

async function selectCandidateSkus(
  tier: ReconcileTier,
  workspaceId: string,
  bundleVariantIds: Set<string>,
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string[]> {
  if (tier === "cold") {
    const { data } = await supabase
      .from("warehouse_inventory_levels")
      .select("sku, variant_id")
      .eq("workspace_id", workspaceId);
    return Array.from(
      new Set(
        ((data ?? []) as Array<{ sku: string; variant_id: string }>)
          .filter((r) => !bundleVariantIds.has(r.variant_id))
          .map((r) => r.sku),
      ),
    );
  }

  if (tier === "warm") {
    const since = new Date(
      Date.now() - WARM_RECENT_SALE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data } = await supabase
      .from("warehouse_inventory_activity")
      .select("sku")
      .eq("workspace_id", workspaceId)
      .lt("delta", 0)
      .gte("created_at", since);
    return Array.from(new Set(((data ?? []) as RecentActivityRow[]).map((r) => r.sku)));
  }

  // Hot tier — union of "low stock" + "sold in last 24h".
  const since = new Date(Date.now() - HOT_RECENT_SALE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const [lowStock, recentSales] = await Promise.all([
    supabase
      .from("warehouse_inventory_levels")
      .select("sku, variant_id, available")
      .eq("workspace_id", workspaceId)
      .lte("available", HOT_LOW_STOCK_THRESHOLD),
    supabase
      .from("warehouse_inventory_activity")
      .select("sku")
      .eq("workspace_id", workspaceId)
      .lt("delta", 0)
      .gte("created_at", since),
  ]);

  const skus = new Set<string>();
  for (const row of (lowStock.data ?? []) as Array<{
    sku: string;
    variant_id: string;
  }>) {
    if (!bundleVariantIds.has(row.variant_id)) skus.add(row.sku);
  }
  for (const row of (recentSales.data ?? []) as RecentActivityRow[]) {
    skus.add(row.sku);
  }
  return Array.from(skus);
}

// ─── Pass 2 D6 — most-recent-pushed-at lookup for the no-other-writer gate ──

/**
 * Returns a map of SKU → ISO timestamp of the most recent
 * `client_store_sku_mappings.last_pushed_at` for that (workspace, SKU)
 * across all client store connections. Returns the latest stamp when a
 * SKU has multiple mapping rows (the gate is "ANY active writer in the
 * window").
 *
 * The query is INTENTIONALLY scoped to `is_active=true` mappings —
 * historical/disabled mappings can have stale `last_pushed_at` values
 * that would falsely gate every reconcile run forever.
 */
export async function fetchMostRecentPushBySku(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  skus: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (skus.length === 0) return out;

  // Chunk to keep the IN-list under PostgREST's URL-length budget.
  const CHUNK = 200;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    const { data } = await supabase
      .from("client_store_sku_mappings")
      .select("remote_sku, last_pushed_at")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .in("remote_sku", chunk)
      .not("last_pushed_at", "is", null);

    for (const row of (data ?? []) as Array<{
      remote_sku: string;
      last_pushed_at: string | null;
    }>) {
      if (!row.last_pushed_at) continue;
      const existing = out.get(row.remote_sku);
      if (!existing || Date.parse(row.last_pushed_at) > Date.parse(existing)) {
        out.set(row.remote_sku, row.last_pushed_at);
      }
    }
  }

  return out;
}

// ─── Auto-fix helper ─────────────────────────────────────────────────────────

async function applyAutoFix(
  workspaceId: string,
  sku: string,
  drift: number,
  tier: ReconcileTier,
  ctx: { run: { id: string } },
  writeInventory: typeof recordInventoryChange,
): Promise<boolean> {
  try {
    const result = await writeInventory({
      workspaceId,
      sku,
      delta: drift,
      source: "reconcile",
      correlationId: `reconcile:${tier}:${ctx.run.id}:${sku}`,
      metadata: {
        tier,
        run_id: ctx.run.id,
        absorbed_drift: drift,
        sensor: "shipstation-bandcamp-reconcile",
      },
    });
    return Boolean(result.success);
  } catch (err) {
    logger.warn("[shipstation-bandcamp-reconcile] auto-fix failed", {
      workspaceId,
      sku,
      drift,
      tier,
      error: String(err),
    });
    return false;
  }
}

// ─── Review-queue upsert (Rule #55 dedupe) ───────────────────────────────────

async function upsertDriftReviewItem(
  workspaceId: string,
  sku: string,
  ourAvailable: number,
  v2Available: number,
  drift: number,
  severity: "low" | "high",
  tier: ReconcileTier,
  ctx: { run: { id: string } },
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string | undefined> {
  const groupKey = `reconcile.qty_drift:${workspaceId}:${sku}`;
  const metadata = {
    sku,
    workspace_id: workspaceId,
    our_available: ourAvailable,
    v2_available: v2Available,
    drift,
    tier,
    sensor_run_id: ctx.run.id,
    sensor: "shipstation-bandcamp-reconcile",
  };

  const { data: existing } = await supabase
    .from("warehouse_review_queue")
    .select("id, occurrence_count, severity")
    .eq("group_key", groupKey)
    .eq("status", "open")
    .maybeSingle();

  if (existing?.id) {
    // Severity may need to escalate (low → high) on re-detection if drift widened.
    const nextSeverity = severity === "high" ? "high" : ((existing.severity as string) ?? severity);
    await supabase
      .from("warehouse_review_queue")
      .update({
        occurrence_count: ((existing.occurrence_count as number) ?? 1) + 1,
        updated_at: new Date().toISOString(),
        severity: nextSeverity,
        title: `Reconcile drift on ${sku}: v2=${v2Available}, ours=${ourAvailable} (|drift|=${Math.abs(drift)})`,
        metadata,
      })
      .eq("id", existing.id);
    return existing.id as string;
  }

  const { data: inserted } = await supabase
    .from("warehouse_review_queue")
    .insert({
      workspace_id: workspaceId,
      category: "inventory_drift",
      severity,
      title: `Reconcile drift on ${sku}: v2=${v2Available}, ours=${ourAvailable} (|drift|=${Math.abs(drift)})`,
      description: `The ${tier}-tier reconcile sensor found |drift|=${Math.abs(drift)} units between ShipStation v2's stored available (${v2Available}) and our DB (${ourAvailable}). The drift has been absorbed into our DB via recordInventoryChange(source='reconcile'). v2 is the source of truth at this layer; if the drift recurs the underlying integration is dropping events — investigate the SHIP_NOTIFY processor or the focused fanout legs (Phase 4) for this SKU.`,
      metadata,
      group_key: groupKey,
      status: "open",
      occurrence_count: 1,
    })
    .select("id")
    .maybeSingle();

  return (inserted as { id?: string } | null)?.id;
}

// ─── Schedule wrappers ───────────────────────────────────────────────────────
// One-shot manual task for ad-hoc reruns + three cron-driven schedules.

const buildDeps = (): ReconcileDeps => ({ supabase: createServiceRoleClient() });

export const shipstationBandcampReconcileTask = task({
  id: "shipstation-bandcamp-reconcile",
  queue: shipstationQueue,
  maxDuration: 300,
  run: async (
    payload: ReconcilePayload & { tier?: ReconcileTier },
    { ctx },
  ): Promise<ReconcileResult> =>
    runShipstationBandcampReconcile(payload.tier ?? "cold", payload, ctx, buildDeps()),
});

export const shipstationBandcampReconcileHotSchedule = schedules.task({
  id: "shipstation-bandcamp-reconcile-hot",
  cron: "*/5 * * * *",
  queue: shipstationQueue,
  maxDuration: 300,
  run: async (_payload, { ctx }): Promise<ReconcileResult> =>
    runShipstationBandcampReconcile("hot", {}, ctx, buildDeps()),
});

export const shipstationBandcampReconcileWarmSchedule = schedules.task({
  id: "shipstation-bandcamp-reconcile-warm",
  cron: "*/30 * * * *",
  queue: shipstationQueue,
  maxDuration: 300,
  run: async (_payload, { ctx }): Promise<ReconcileResult> =>
    runShipstationBandcampReconcile("warm", {}, ctx, buildDeps()),
});

export const shipstationBandcampReconcileColdSchedule = schedules.task({
  id: "shipstation-bandcamp-reconcile-cold",
  cron: "0 */6 * * *",
  queue: shipstationQueue,
  maxDuration: 600,
  run: async (_payload, { ctx }): Promise<ReconcileResult> =>
    runShipstationBandcampReconcile("cold", {}, ctx, buildDeps()),
});

// Re-export so tests / callers can reach the underlying batch limit.
export { V2_INVENTORY_LIST_BATCH_LIMIT };
