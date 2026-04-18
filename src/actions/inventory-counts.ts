"use server";

/**
 * Saturday Workstream 3 (2026-04-18) — per-SKU count session backend.
 *
 * Scope and write-path discipline:
 *
 *   - `startCountSession(sku)` — flip `warehouse_inventory_levels.count_status`
 *     from `idle` to `count_in_progress`. Snapshot `count_baseline_available`
 *     for AUDIT only — `completeCountSession()` does NOT use it for delta math
 *     (review pass v4 §17.1.b corrected the formula to current - sumOfLocations).
 *
 *   - `setVariantLocationQuantity({sku, locationId, quantity})` — upsert one
 *     `warehouse_variant_locations` row. Two branches by parent count_status:
 *       (A) `count_in_progress` — DO NOT recompute `warehouse_inventory_levels.available`,
 *           DO NOT call `recordInventoryChange()`. This is the count-session
 *           fanout suppression invariant (R-1 / Rule #76 below). Returns the
 *           running sumOfLocations for the UI delta-preview chip.
 *       (B) `idle` — recompute SKU total, call `recordInventoryChange({ source:
 *           'manual_inventory_count' })` so fanout fires (Bandcamp / Clandestine
 *           Shopify / client store via `fanoutInventoryChange()`; ShipStation v2
 *           via the WS3 3f extension once the §15.3 GATE probe lands).
 *
 *   - `completeCountSession(sku)` — sum per-location rows, compute
 *     `delta = sumOfLocations - currentAvailable`, fire ONE
 *     `recordInventoryChange({ source: 'cycle_count', correlationId:
 *     'count-session:{startedAt}:{sku}' })`, flip count_status back to idle.
 *     The single recordInventoryChange call is what makes the count session
 *     fanout-once invariant (FR-6).
 *
 *   - `cancelCountSession(sku, { rollbackLocationEntries })` — roll back per-
 *     location rows updated during the session if requested, then flip back.
 *     Does NOT call `recordInventoryChange()`.
 *
 *   - `getCountSessionState(sku)` — read-only state hydrator for the UI.
 *
 * Sticky `has_per_location_data` flag (R-23 / migration §3): on the first
 * non-zero per-location write we permanently mark the SKU as per-location.
 * Once true, never reset by automation — the WS3 3f ShipStation v2 fanout
 * uses the flag to refuse falling back to a single SKU-total write that
 * would clobber the per-location ShipStation records.
 *
 * Auth: all five actions require staff via `requireStaff()`.
 * Rules: #6 (companion .test.ts), #20 (single inventory write path),
 *        #41 (Server Actions stay <30s — completeCountSession is the longest
 *        path; sums are bounded by location count per SKU which is small),
 *        #76 (count-session fanout suppression — defined below in CLAUDE.md).
 */

import { requireStaff } from "@/lib/server/auth-context";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// ─────────────────────────────────────────────────────────────────────────────
// Helper types
// ─────────────────────────────────────────────────────────────────────────────

type LocationRow = { quantity: number };

function sumLocations(rows: LocationRow[] | null | undefined): number {
  return (rows ?? []).reduce((acc, r) => acc + (r.quantity ?? 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// startCountSession
// ─────────────────────────────────────────────────────────────────────────────

export interface StartCountSessionResult {
  ok: true;
  startedAt: string;
  baselineAvailable: number;
}

export async function startCountSession(sku: string): Promise<StartCountSessionResult> {
  const { userId, workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const { data: pre, error: preErr } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, count_status")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .maybeSingle();
  if (preErr) throw preErr;
  if (!pre) throw new Error("UNKNOWN_SKU");
  if (pre.count_status !== "idle") {
    const existing = await getCountSessionState(sku);
    throw new Error(`ALREADY_IN_PROGRESS:${existing.startedBy?.id ?? "unknown"}`);
  }

  const startedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("warehouse_inventory_levels")
    .update({
      count_status: "count_in_progress",
      count_started_at: startedAt,
      count_started_by: userId,
      count_baseline_available: pre.available, // AUDIT-only; complete uses current
    })
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .eq("count_status", "idle") // optimistic concurrency guard
    .select("count_started_at, count_baseline_available")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const existing = await getCountSessionState(sku);
    throw new Error(`ALREADY_IN_PROGRESS:${existing.startedBy?.id ?? "unknown"}`);
  }

  return {
    ok: true,
    startedAt: data.count_started_at as string,
    baselineAvailable: (data.count_baseline_available as number | null) ?? pre.available,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// setVariantLocationQuantity — fanout-suppressing branch + idle pass-through
// ─────────────────────────────────────────────────────────────────────────────

export type SetVariantLocationQuantityResult =
  | { status: "session_partial"; sumOfLocations: number }
  | { status: "fanned_out"; newTotal: number; delta: number }
  | { status: "no_change"; newTotal: number };

export async function setVariantLocationQuantity(params: {
  sku: string;
  locationId: string;
  quantity: number;
}): Promise<SetVariantLocationQuantityResult> {
  const { workspaceId } = await requireStaff();
  if (!Number.isInteger(params.quantity) || params.quantity < 0) {
    throw new Error("QUANTITY_INVALID");
  }
  const supabase = await createServerSupabaseClient();

  const { data: variant, error: vErr } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", params.sku)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level, error: lErr } = await supabase
    .from("warehouse_inventory_levels")
    .select("count_status, available, has_per_location_data")
    .eq("variant_id", variant.id)
    .maybeSingle();
  if (lErr) throw lErr;

  // Verify the location actually belongs to this workspace before we touch
  // warehouse_variant_locations — defence in depth against UI bug or stale
  // dropdown state.
  const { data: loc, error: locErr } = await supabase
    .from("warehouse_locations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", params.locationId)
    .maybeSingle();
  if (locErr) throw locErr;
  if (!loc) throw new Error("UNKNOWN_LOCATION");

  const { error: upsertErr } = await supabase.from("warehouse_variant_locations").upsert(
    {
      variant_id: variant.id,
      location_id: params.locationId,
      workspace_id: workspaceId,
      quantity: params.quantity,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "variant_id,location_id" },
  );
  if (upsertErr) throw upsertErr;

  // R-23 sticky flag: first non-zero per-location write switches the SKU
  // permanently into per-location mode. Never reset by automation.
  if (params.quantity > 0 && level?.has_per_location_data === false) {
    await supabase
      .from("warehouse_inventory_levels")
      .update({ has_per_location_data: true })
      .eq("variant_id", variant.id)
      .eq("has_per_location_data", false);
  }

  const { data: rows, error: rowsErr } = await supabase
    .from("warehouse_variant_locations")
    .select("quantity")
    .eq("variant_id", variant.id);
  if (rowsErr) throw rowsErr;
  const sumOfLocations = sumLocations(rows as LocationRow[] | null);

  // Branch A: SUPPRESS fanout while a count session is in progress.
  if (level?.count_status === "count_in_progress") {
    return { status: "session_partial", sumOfLocations };
  }

  // Branch B: idle path — recompute SKU total and route through the canonical
  // write path so fanout fires.
  const oldTotal = level?.available ?? 0;
  const delta = sumOfLocations - oldTotal;
  if (delta === 0) return { status: "no_change", newTotal: sumOfLocations };

  const result = await recordInventoryChange({
    workspaceId,
    sku: params.sku,
    delta,
    source: "manual_inventory_count",
    correlationId: `loc-edit:${params.locationId}:${params.sku}:${Date.now()}`,
    metadata: {
      origin: "set_variant_location_quantity_idle",
      location_id: params.locationId,
      sum_of_locations: sumOfLocations,
      old_total: oldTotal,
    },
  });
  if (!result.success) {
    throw new Error("RECORD_INVENTORY_CHANGE_FAILED");
  }
  return { status: "fanned_out", newTotal: sumOfLocations, delta };
}

// ─────────────────────────────────────────────────────────────────────────────
// completeCountSession — single canonical fanout for the whole session
// ─────────────────────────────────────────────────────────────────────────────

export interface CompleteCountSessionResult {
  newTotal: number;
  delta: number;
  fanoutEnqueued: boolean;
  baselineAvailable: number | null;
  salesDuringSession: number | null;
  formula: "current_minus_sum";
}

export async function completeCountSession(sku: string): Promise<CompleteCountSessionResult> {
  const { workspaceId, userId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const { data: variant, error: vErr } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level, error: lErr } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, count_status, count_started_at, count_baseline_available")
    .eq("variant_id", variant.id)
    .maybeSingle();
  if (lErr) throw lErr;
  if (level?.count_status !== "count_in_progress") throw new Error("NO_ACTIVE_SESSION");

  const { data: rows, error: rowsErr } = await supabase
    .from("warehouse_variant_locations")
    .select("quantity")
    .eq("variant_id", variant.id);
  if (rowsErr) throw rowsErr;
  const sumOfLocations = sumLocations(rows as LocationRow[] | null);

  // Plan §17.1.b v4 hardening: USE CURRENT, NOT BASELINE.
  // See completeCountSession body in plan C.8 lines 3360-3389 for the
  // full Scenario A vs Scenario B rationale.
  const baseline = (level.count_baseline_available as number | null) ?? null;
  const currentAvailable = (level.available as number | null) ?? 0;
  const delta = sumOfLocations - currentAvailable;
  const salesDuringSession = baseline !== null ? baseline - currentAvailable : null;

  if (delta !== 0) {
    const result = await recordInventoryChange({
      workspaceId,
      sku,
      delta,
      source: "cycle_count",
      correlationId: `count-session:${level.count_started_at as string}:${sku}`,
      metadata: {
        actor_user_id: userId,
        sum_of_locations: sumOfLocations,
        baseline_available: baseline,
        current_available_at_complete: currentAvailable,
        sales_during_session: salesDuringSession,
        formula_used: "current_minus_sum",
      },
    });
    if (!result.success) {
      throw new Error("RECORD_INVENTORY_CHANGE_FAILED");
    }
  }

  const { error: clearErr } = await supabase
    .from("warehouse_inventory_levels")
    .update({
      count_status: "idle",
      count_started_at: null,
      count_started_by: null,
      count_baseline_available: null,
    })
    .eq("variant_id", variant.id);
  if (clearErr) throw clearErr;

  return {
    newTotal: sumOfLocations,
    delta,
    fanoutEnqueued: delta !== 0,
    baselineAvailable: baseline,
    salesDuringSession,
    formula: "current_minus_sum",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelCountSession
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelCountSessionResult {
  ok: true;
  alreadyIdle: boolean;
  rolledBackRows: number;
}

export async function cancelCountSession(
  sku: string,
  opts: { rollbackLocationEntries: boolean },
): Promise<CancelCountSessionResult> {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const { data: variant, error: vErr } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level, error: lErr } = await supabase
    .from("warehouse_inventory_levels")
    .select("count_started_at, count_status")
    .eq("variant_id", variant.id)
    .maybeSingle();
  if (lErr) throw lErr;
  if (level?.count_status !== "count_in_progress") {
    return { ok: true, alreadyIdle: true, rolledBackRows: 0 };
  }

  let rolledBackRows = 0;
  if (opts.rollbackLocationEntries && level.count_started_at) {
    const { data: deleted, error: delErr } = await supabase
      .from("warehouse_variant_locations")
      .delete()
      .eq("variant_id", variant.id)
      .gte("updated_at", level.count_started_at as string)
      .select("id");
    if (delErr) throw delErr;
    rolledBackRows = (deleted ?? []).length;
  }

  const { error: clearErr } = await supabase
    .from("warehouse_inventory_levels")
    .update({
      count_status: "idle",
      count_started_at: null,
      count_started_by: null,
      count_baseline_available: null,
    })
    .eq("variant_id", variant.id);
  if (clearErr) throw clearErr;

  return { ok: true, alreadyIdle: false, rolledBackRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// getCountSessionState — read-only state hydrator for the count UI panel
// ─────────────────────────────────────────────────────────────────────────────

export interface CountSessionStateLocation {
  locationId: string;
  locationName: string;
  locationType: string;
  quantity: number;
}

export interface CountSessionState {
  status: "idle" | "count_in_progress";
  startedAt: string | null;
  startedBy: { id: string; name: string | null } | null;
  baselineAvailable: number | null;
  currentAvailable: number;
  sumOfLocations: number;
  hasPerLocationData: boolean;
  locations: CountSessionStateLocation[];
}

export async function getCountSessionState(sku: string): Promise<CountSessionState> {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const { data: variant, error: vErr } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!variant) throw new Error("UNKNOWN_SKU");

  const { data: level, error: lErr } = await supabase
    .from("warehouse_inventory_levels")
    .select(
      `available, count_status, count_started_at, count_baseline_available, has_per_location_data,
       users:count_started_by ( id, name )`,
    )
    .eq("variant_id", variant.id)
    .maybeSingle();
  if (lErr) throw lErr;

  const { data: rows, error: rowsErr } = await supabase
    .from("warehouse_variant_locations")
    .select("location_id, quantity, warehouse_locations!inner(name, location_type)")
    .eq("variant_id", variant.id);
  if (rowsErr) throw rowsErr;

  type Row = {
    location_id: string;
    quantity: number;
    warehouse_locations: { name: string; location_type: string };
  };
  const locationRows = (rows as unknown as Row[] | null) ?? [];
  const sumOfLocations = sumLocations(locationRows.map((r) => ({ quantity: r.quantity })));

  const startedByRaw = (level as unknown as { users?: { id: string; name: string | null } | null })
    ?.users;
  const startedBy =
    startedByRaw && startedByRaw.id
      ? { id: startedByRaw.id, name: startedByRaw.name ?? null }
      : null;

  return {
    status: ((level?.count_status as string | null) ?? "idle") as "idle" | "count_in_progress",
    startedAt: (level?.count_started_at as string | null) ?? null,
    startedBy,
    baselineAvailable: (level?.count_baseline_available as number | null) ?? null,
    currentAvailable: (level?.available as number | null) ?? 0,
    sumOfLocations,
    hasPerLocationData: (level?.has_per_location_data as boolean | null) ?? false,
    locations: locationRows.map((r) => ({
      locationId: r.location_id,
      locationName: r.warehouse_locations.name,
      locationType: r.warehouse_locations.location_type,
      quantity: r.quantity,
    })),
  };
}
