"use server";

/**
 * Saturday Workstream 3 (2026-04-18) — warehouse locations Server Actions.
 *
 * Our app is the source of truth for warehouse locations (Plan §20 / new
 * CLAUDE.md Rule #76 below). Every mutation here mirrors one-way to
 * ShipStation v2 via the helpers added in WS3 3a; there is no reverse sync.
 *
 * Public API:
 *   - listLocations({ activeOnly?, search? })
 *   - createLocation({ name, locationType, barcode? })
 *       - Inserts the local row first.
 *       - Then mirrors to ShipStation v2.
 *       - 409/duplicate from ShipStation is resolved via listInventoryLocations
 *         + ID lookup (R-22 / OQ-1 hardening).
 *       - On non-409 mirror failure: local row stands, error surfaces in
 *         `shipstation_sync_error`, returns `warning: 'shipstation_mirror_failed'`.
 *   - createLocationRange({ prefix, fromIndex, toIndex, locationType, padWidth?, throttleMs? })
 *       - Inline path for size <= 30 (300ms throttle, ~12s worst-case;
 *         under Vercel Server Action timeout).
 *       - Trigger task path for size > 30 (delegates to bulk-create-locations).
 *   - updateLocation(id, patch)
 *       - For renames with an existing ShipStation mirror, calls ShipStation
 *         FIRST (v4 hardening §17.1.b) so a v2 failure leaves the local row
 *         untouched.
 *   - deactivateLocation(id) — local-only flip; refuses if any per-location
 *     row has positive quantity. Does NOT call DELETE on ShipStation.
 *   - retryShipstationLocationSync(locationId) — explicit operator retry
 *     for rows with `shipstation_sync_error`.
 *
 * Auth: all actions require staff via requireStaff().
 * Rules: #6 (companion .test.ts), #41 (Server Actions stay <30s — handled
 *        via the 30-entry inline cap), #76 (locator one-way mirror).
 */

import { tasks } from "@trigger.dev/sdk";

import {
  createInventoryLocation,
  listInventoryLocations,
  updateInventoryLocation,
} from "@/lib/clients/shipstation-inventory-v2";
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// ─── Constants ──────────────────────────────────────────────────────────────
//
// 30 inline × 300ms throttle = 9s sleep budget + ~3s API latency = ~12s worst
// case, comfortably under Vercel's 15s Server Action baseline. Larger ranges
// route to the bulk-create-locations Trigger task.
const RANGE_INLINE_MAX = 30;
const DEFAULT_THROTTLE_MS = 300;

const VALID_LOCATION_TYPES = ["shelf", "bin", "floor", "staging"] as const;
type LocationType = (typeof VALID_LOCATION_TYPES)[number];

function assertLocationType(value: string): asserts value is LocationType {
  if (!(VALID_LOCATION_TYPES as readonly string[]).includes(value)) {
    throw new Error(`INVALID_LOCATION_TYPE:${value}`);
  }
}

function buildName(prefix: string, index: number, padWidth: number | undefined): string {
  const pad = padWidth ?? 0;
  return `${prefix}${pad > 0 ? String(index).padStart(pad, "0") : String(index)}`;
}

// ─── listLocations ──────────────────────────────────────────────────────────

export interface WarehouseLocationRow {
  id: string;
  workspace_id: string;
  name: string;
  barcode: string | null;
  location_type: string;
  is_active: boolean;
  shipstation_inventory_location_id: string | null;
  shipstation_synced_at: string | null;
  shipstation_sync_error: string | null;
  created_at: string;
}

export async function listLocations(
  filters: { activeOnly?: boolean; search?: string } = {},
): Promise<WarehouseLocationRow[]> {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  let q = supabase
    .from("warehouse_locations")
    .select(
      "id, workspace_id, name, barcode, location_type, is_active, shipstation_inventory_location_id, shipstation_synced_at, shipstation_sync_error, created_at",
    )
    .eq("workspace_id", workspaceId)
    .order("name");
  if (filters.activeOnly) q = q.eq("is_active", true);
  if (filters.search) q = q.ilike("name", `%${filters.search}%`);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as WarehouseLocationRow[];
}

// ─── createLocation ─────────────────────────────────────────────────────────

export type CreateLocationWarning =
  | "no_v2_warehouse_configured"
  | "shipstation_mirror_failed"
  | "shipstation_mirror_resolved_existing"
  | null;

export interface CreateLocationResult {
  ok: true;
  row: WarehouseLocationRow;
  warning: CreateLocationWarning;
  error?: string;
}

export async function createLocation(params: {
  name: string;
  locationType: string;
  barcode?: string;
}): Promise<CreateLocationResult> {
  const { workspaceId } = await requireStaff();
  assertLocationType(params.locationType);
  const supabase = await createServerSupabaseClient();

  const { data: row, error } = await supabase
    .from("warehouse_locations")
    .insert({
      workspace_id: workspaceId,
      name: params.name,
      location_type: params.locationType,
      barcode: params.barcode ?? null,
      is_active: true,
    })
    .select(
      "id, workspace_id, name, barcode, location_type, is_active, shipstation_inventory_location_id, shipstation_synced_at, shipstation_sync_error, created_at",
    )
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("LOCATION_ALREADY_EXISTS");
    throw error;
  }

  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id")
    .eq("id", workspaceId)
    .single();
  const warehouseId = ws?.shipstation_v2_inventory_warehouse_id as string | null | undefined;
  if (!warehouseId) {
    return { ok: true, row: row as WarehouseLocationRow, warning: "no_v2_warehouse_configured" };
  }

  try {
    const ssLoc = await createInventoryLocation({
      inventory_warehouse_id: warehouseId,
      name: params.name,
    });
    await supabase
      .from("warehouse_locations")
      .update({
        shipstation_inventory_location_id: ssLoc.inventory_location_id,
        shipstation_synced_at: new Date().toISOString(),
        shipstation_sync_error: null,
      })
      .eq("id", row.id);
    return {
      ok: true,
      row: {
        ...(row as WarehouseLocationRow),
        shipstation_inventory_location_id: ssLoc.inventory_location_id,
      },
      warning: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isConflict =
      /409|already exists|duplicate|conflict/i.test(msg) ||
      (err as { status?: number } | null)?.status === 409;
    if (isConflict) {
      try {
        const existing = await listInventoryLocations(warehouseId);
        const match = existing.find((l) => l.name === params.name);
        if (match) {
          await supabase
            .from("warehouse_locations")
            .update({
              shipstation_inventory_location_id: match.inventory_location_id,
              shipstation_synced_at: new Date().toISOString(),
              shipstation_sync_error: null,
            })
            .eq("id", row.id);
          return {
            ok: true,
            row: {
              ...(row as WarehouseLocationRow),
              shipstation_inventory_location_id: match.inventory_location_id,
            },
            warning: "shipstation_mirror_resolved_existing",
          };
        }
      } catch {
        // fall through to error path
      }
    }
    await supabase
      .from("warehouse_locations")
      .update({ shipstation_sync_error: msg })
      .eq("id", row.id);
    return {
      ok: true,
      row: row as WarehouseLocationRow,
      warning: "shipstation_mirror_failed",
      error: msg,
    };
  }
}

// ─── createLocationRange — inline (≤30) vs Trigger task path ────────────────

export type CreateLocationRangeResult =
  | {
      mode: "inline";
      results: Array<{ name: string; status: "created" | "exists" | "error"; warning?: string }>;
      size: number;
    }
  | {
      mode: "trigger";
      taskRunId: string;
      size: number;
      message: string;
    };

export async function createLocationRange(params: {
  prefix: string;
  fromIndex: number;
  toIndex: number;
  locationType: string;
  padWidth?: number;
  throttleMs?: number;
}): Promise<CreateLocationRangeResult> {
  const { userId, workspaceId } = await requireStaff();
  assertLocationType(params.locationType);
  const size = params.toIndex - params.fromIndex + 1;
  if (size <= 0) throw new Error("EMPTY_RANGE");

  if (size > RANGE_INLINE_MAX) {
    const handle = await tasks.trigger("bulk-create-locations", {
      workspaceId,
      actorUserId: userId,
      prefix: params.prefix,
      fromIndex: params.fromIndex,
      toIndex: params.toIndex,
      locationType: params.locationType,
      padWidth: params.padWidth,
      throttleMs: params.throttleMs ?? DEFAULT_THROTTLE_MS,
    });
    return {
      mode: "trigger",
      taskRunId: handle.id,
      size,
      message: `Range of ${size} exceeds inline cap (${RANGE_INLINE_MAX}). Tracking via task ${handle.id}.`,
    };
  }

  const throttle = params.throttleMs ?? DEFAULT_THROTTLE_MS;
  const results: Array<{
    name: string;
    status: "created" | "exists" | "error";
    warning?: string;
  }> = [];

  for (let i = params.fromIndex; i <= params.toIndex; i++) {
    const name = buildName(params.prefix, i, params.padWidth);
    try {
      const r = await createLocation({ name, locationType: params.locationType });
      results.push({ name, status: "created", warning: r.warning ?? undefined });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, status: msg === "LOCATION_ALREADY_EXISTS" ? "exists" : "error" });
    }
    if (throttle > 0 && i < params.toIndex) {
      await new Promise((resolve) => setTimeout(resolve, throttle));
    }
  }

  return { mode: "inline", results, size };
}

// ─── updateLocation ─────────────────────────────────────────────────────────

export interface UpdateLocationResult {
  ok: boolean;
  warning:
    | null
    | "shipstation_mirror_failed"
    | "local_update_failed_after_shipstation"
    | "no_changes";
  error?: string;
}

export async function updateLocation(
  id: string,
  patch: { name?: string; locationType?: string; barcode?: string | null; isActive?: boolean },
): Promise<UpdateLocationResult> {
  const { workspaceId } = await requireStaff();
  if (patch.locationType !== undefined) assertLocationType(patch.locationType);
  const supabase = await createServerSupabaseClient();

  const { data: existing, error: readErr } = await supabase
    .from("warehouse_locations")
    .select("id, name, shipstation_inventory_location_id")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) throw new Error("NOT_FOUND");

  const isRenameWithMirror =
    patch.name !== undefined && Boolean(existing.shipstation_inventory_location_id);

  if (isRenameWithMirror) {
    try {
      await updateInventoryLocation(existing.shipstation_inventory_location_id as string, {
        name: patch.name as string,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("warehouse_locations")
        .update({ shipstation_sync_error: msg })
        .eq("id", id);
      return { ok: false, warning: "shipstation_mirror_failed", error: msg };
    }
  }

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.locationType !== undefined) update.location_type = patch.locationType;
  if (patch.barcode !== undefined) update.barcode = patch.barcode;
  if (patch.isActive !== undefined) update.is_active = patch.isActive;
  if (isRenameWithMirror) {
    update.shipstation_synced_at = new Date().toISOString();
    update.shipstation_sync_error = null;
  }

  if (Object.keys(update).length === 0) {
    return { ok: true, warning: "no_changes" };
  }

  const { error } = await supabase.from("warehouse_locations").update(update).eq("id", id);
  if (error) {
    return {
      ok: false,
      warning: "local_update_failed_after_shipstation",
      error: error.message,
    };
  }
  return { ok: true, warning: null };
}

// ─── deactivateLocation ─────────────────────────────────────────────────────

export async function deactivateLocation(id: string): Promise<{ ok: true }> {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  // Defence in depth: confirm the location belongs to this workspace before
  // we let head-count + update operate on it.
  const { data: row, error: readErr } = await supabase
    .from("warehouse_locations")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!row) throw new Error("NOT_FOUND");

  const { count, error: countErr } = await supabase
    .from("warehouse_variant_locations")
    .select("variant_id", { count: "exact", head: true })
    .eq("location_id", id)
    .gt("quantity", 0);
  if (countErr) throw countErr;
  if ((count ?? 0) > 0) throw new Error("LOCATION_HAS_INVENTORY");

  const { error } = await supabase
    .from("warehouse_locations")
    .update({ is_active: false })
    .eq("id", id);
  if (error) throw error;
  return { ok: true };
}

// ─── retryShipstationLocationSync ───────────────────────────────────────────

export interface RetrySyncResult {
  ok: boolean;
  alreadySynced?: boolean;
  error?: string;
}

export async function retryShipstationLocationSync(locationId: string): Promise<RetrySyncResult> {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const { data: row, error: readErr } = await supabase
    .from("warehouse_locations")
    .select("name, shipstation_inventory_location_id")
    .eq("id", locationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!row) throw new Error("NOT_FOUND");
  if (row.shipstation_inventory_location_id) return { ok: true, alreadySynced: true };

  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id")
    .eq("id", workspaceId)
    .single();
  const warehouseId = ws?.shipstation_v2_inventory_warehouse_id as string | null | undefined;
  if (!warehouseId) throw new Error("NO_V2_WAREHOUSE");

  try {
    const ssLoc = await createInventoryLocation({
      inventory_warehouse_id: warehouseId,
      name: row.name as string,
    });
    await supabase
      .from("warehouse_locations")
      .update({
        shipstation_inventory_location_id: ssLoc.inventory_location_id,
        shipstation_synced_at: new Date().toISOString(),
        shipstation_sync_error: null,
      })
      .eq("id", locationId);
    return { ok: true, alreadySynced: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Same R-22 conflict handling as createLocation: 409 means the name
    // already exists upstream — resolve to that ID.
    const isConflict =
      /409|already exists|duplicate|conflict/i.test(msg) ||
      (err as { status?: number } | null)?.status === 409;
    if (isConflict) {
      try {
        const existing = await listInventoryLocations(warehouseId);
        const match = existing.find((l) => l.name === row.name);
        if (match) {
          await supabase
            .from("warehouse_locations")
            .update({
              shipstation_inventory_location_id: match.inventory_location_id,
              shipstation_synced_at: new Date().toISOString(),
              shipstation_sync_error: null,
            })
            .eq("id", locationId);
          return { ok: true, alreadySynced: false };
        }
      } catch {
        // fall through
      }
    }
    await supabase
      .from("warehouse_locations")
      .update({ shipstation_sync_error: msg })
      .eq("id", locationId);
    return { ok: false, error: msg };
  }
}
