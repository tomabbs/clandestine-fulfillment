/**
 * Autonomous SKU matcher — Phase 5.A: stock-stability sampler pure helpers.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md → §"Stock stability
 * gate" + §"New helpers this plan introduces" + §"stock-stability-sampler".
 *
 * Overview
 * ────────
 * The stability gate (`isStockStableFor()` in `stock-reliability.ts`)
 * requires a rolling table of past stock readings per
 * (workspace_id, variant_id, source) — the `stock_stability_readings`
 * table. This module defines the PURE helpers the Trigger task consumes:
 *
 *   * `bucketObservedAt(now)` floors the sampler's wall-clock to the
 *     nearest 15-minute boundary. The `UNIQUE(workspace_id, variant_id,
 *     source, observed_at)` constraint then makes occasional Trigger.dev
 *     double-deliveries idempotent — two runs inside the same bucket
 *     collide on the key and the ON CONFLICT DO NOTHING clause silently
 *     drops the duplicate. Without bucketing, two runs 500ms apart would
 *     both insert (different observed_at values) and the stability gate
 *     would see noisy, redundant readings.
 *
 *   * `buildWarehouseSampleRows(...)` shapes the per-variant inventory
 *     rows into `stock_stability_readings` row payloads. Keeping this
 *     pure means tests can assert the exact insert payload shape without
 *     mocking Supabase. ATP is computed here (delta between available
 *     and committed) so the stability gate can compare ATP values later,
 *     not raw `available`.
 *
 *   * `buildPurgeCutoff(now, retentionDays)` returns the ISO timestamp
 *     for the nightly purge sweep. Retention is 30d per the migration
 *     comment (§Section H).
 *
 * The Trigger task (`src/trigger/tasks/stock-stability-sampler.ts`) owns
 * the database I/O; this module owns none. Unit tests pin `Date.now()`
 * via fake timers; production callers pass `new Date()` explicitly.
 */

/**
 * 15-minute cadence. The every-15-minute cron plus this bucket floor
 * means every sampler run writes into exactly one bucket per hour
 * quadrant, and double-deliveries inside that quadrant are silently
 * deduped by the UNIQUE(workspace_id, variant_id, source, observed_at)
 * constraint.
 */
export const SAMPLER_BUCKET_MS = 15 * 60 * 1000;

/** Default retention for `stock_stability_readings` rows. */
export const SAMPLER_RETENTION_DAYS = 30;

/**
 * Source tag for warehouse-authoritative readings. Intentionally the
 * short string (not `warehouse_inventory_levels`) so it matches the
 * platform-short tags (`shopify`, `woocommerce`, `squarespace`,
 * `bandcamp`) used on the `stock_stability_readings.source` column.
 * See the migration comment on Section H.
 */
export const SAMPLER_WAREHOUSE_SOURCE = "warehouse" as const;

/**
 * Floor `now` to the nearest 15-minute wall-clock boundary.
 *
 * Examples:
 *   * 2026-04-26T14:37:23.123Z → 2026-04-26T14:30:00.000Z
 *   * 2026-04-26T14:44:59.999Z → 2026-04-26T14:30:00.000Z
 *   * 2026-04-26T14:45:00.000Z → 2026-04-26T14:45:00.000Z
 *
 * The returned Date is always a fresh instance — callers can safely
 * mutate it without affecting the input.
 */
export function bucketObservedAt(now: Date): Date {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("bucketObservedAt: invalid input Date");
  }
  const floored = Math.floor(nowMs / SAMPLER_BUCKET_MS) * SAMPLER_BUCKET_MS;
  return new Date(floored);
}

/**
 * Raw warehouse inventory shape the sampler reads from
 * `warehouse_inventory_levels`. Only the fields the sampler uses are
 * declared — keeps the pure helper decoupled from generated DB types.
 */
export interface WarehouseLevelSnapshot {
  variant_id: string;
  available: number | null;
  committed_quantity: number | null;
}

/**
 * Shape of a row inserted into `stock_stability_readings`. Explicit
 * JSON-on-the-wire names (snake_case) because callers pass this
 * directly to `supabase.from("stock_stability_readings").insert(...)`.
 *
 * Fields map 1:1 to the DB column names in Section H of migration
 * `20260428000001_sku_autonomous_matching_phase0.sql`:
 *   * `workspace_id`, `variant_id`, `source`, `observed_at`,
 *     `observed_at_local`, `available`, `committed`, `atp`,
 *     `remote_stock_listed`, `clock_skew_ms`, `sampler_run_id`.
 * `created_at` and `id` are DB-defaulted.
 */
export interface StabilityReadingRow {
  workspace_id: string;
  variant_id: string;
  source: string;
  observed_at: string;
  observed_at_local: string;
  available: number | null;
  committed: number | null;
  atp: number | null;
  remote_stock_listed: boolean | null;
  clock_skew_ms: number | null;
  sampler_run_id: string | null;
}

export interface BuildWarehouseSampleRowsInput {
  workspaceId: string;
  levels: ReadonlyArray<WarehouseLevelSnapshot>;
  observedAt: Date;
  samplerRunId: string;
}

/**
 * Shape warehouse inventory rows into insert payloads.
 *
 * Rules:
 *   * Skips rows with a null / non-string variant_id (defensive — the
 *     inventory table requires variant_id, but Supabase typings allow
 *     null and we never want to insert a broken row).
 *   * Dedupes by variant_id so the same variant never appears twice in
 *     one insert batch (cheap guard against join accidents upstream).
 *   * Computes ATP as `max(0, available - max(0, committed))`. `atp` is
 *     null only when `available` itself is null.
 *   * `observed_at` is formatted from the BUCKETED Date passed in;
 *     callers should floor with `bucketObservedAt()` before calling.
 *   * `observed_at_local` is the same value — the sampler reads from
 *     our own database so there is no remote clock skew to record.
 *   * `remote_stock_listed` is always null for warehouse samples. The
 *     column is present for future remote-source samples.
 */
export function buildWarehouseSampleRows(
  input: BuildWarehouseSampleRowsInput,
): StabilityReadingRow[] {
  const observedAtIso = input.observedAt.toISOString();
  const seen = new Set<string>();
  const out: StabilityReadingRow[] = [];

  for (const level of input.levels) {
    const variantId = level.variant_id;
    if (typeof variantId !== "string" || variantId.length === 0) continue;
    if (seen.has(variantId)) continue;
    seen.add(variantId);

    const available = typeof level.available === "number" ? level.available : null;
    const committedRaw =
      typeof level.committed_quantity === "number" ? level.committed_quantity : null;
    const committed = committedRaw === null ? null : Math.max(0, committedRaw);
    const atp = available === null ? null : Math.max(0, available - Math.max(0, committed ?? 0));

    out.push({
      workspace_id: input.workspaceId,
      variant_id: variantId,
      source: SAMPLER_WAREHOUSE_SOURCE,
      observed_at: observedAtIso,
      observed_at_local: observedAtIso,
      available,
      committed,
      atp,
      remote_stock_listed: null,
      clock_skew_ms: null,
      sampler_run_id: input.samplerRunId,
    });
  }

  return out;
}

/**
 * Compute the purge cutoff for the nightly retention sweep.
 *
 * All rows whose `created_at < cutoff` may be DELETE'd by the purge
 * task. Retention is 30 days by default per the migration comment
 * (§Section H).
 */
export function buildPurgeCutoff(now: Date, retentionDays: number = SAMPLER_RETENTION_DAYS): Date {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("buildPurgeCutoff: invalid input Date");
  }
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("buildPurgeCutoff: retentionDays must be positive");
  }
  return new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Convenience: ISO variant of {@link buildPurgeCutoff} for callers that
 * pass directly to `supabase.from(...).lt("created_at", <iso>)`.
 */
export function buildPurgeCutoffIso(
  now: Date,
  retentionDays: number = SAMPLER_RETENTION_DAYS,
): string {
  return buildPurgeCutoff(now, retentionDays).toISOString();
}

/**
 * Deduplicate variant IDs pulled from multiple source tables (identity
 * matches + live alias mappings) into a single universe list, preserving
 * stable insertion order. Filters out null/empty entries.
 */
export function mergeVariantUniverse(
  ...inputs: ReadonlyArray<ReadonlyArray<string | null | undefined>>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of inputs) {
    for (const id of chunk) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
