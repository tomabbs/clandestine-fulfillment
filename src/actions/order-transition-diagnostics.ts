"use server";

/**
 * Order Pages Transition Phase 0 — read-only diagnostics for staff.
 *
 * Surfaces a single workspace-scoped snapshot of the transition's health:
 *   - direct vs ShipStation mirror counts (last 30 / 90 days)
 *   - identity backfill progress (deferred to Phase 1; safely returns 0s
 *     until the v2 columns and tables exist)
 *   - tracking source breakdown (EasyPost / ShipStation / Pirate Ship /
 *     manual)
 *   - writeback parity stub (Phase 5b populates this for real)
 *   - effective route mode + legacy flag value
 *
 * Read-only. No mutations, no Trigger fires. Safe to call from a Server
 * Component.
 */

import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { getOrdersRouteMode, type OrdersRouteMode } from "./order-route-mode";

export interface OrderTransitionDiagnostics {
  workspaceId: string;
  routeMode: OrdersRouteMode | null;
  legacyShipstationUnifiedShipping: boolean;
  effectiveSurface: "direct" | "shipstation_mirror";
  counts: {
    warehouseOrdersTotal: number;
    warehouseOrdersLast30d: number;
    warehouseOrdersLast90d: number;
    shipstationOrdersTotal: number;
    shipstationOrdersLast30d: number;
    shipstationOrdersLast90d: number;
    warehouseOrdersWithoutConnectionId: number; // Phase 1 fills this
    warehouseOrdersAmbiguousIdentity: number; // Phase 1 fills this
  };
  shipments: {
    total: number;
    bySource: {
      shipstation: number;
      easypost: number;
      pirate_ship: number;
      manual: number;
      unknown: number;
    };
    pirateShipPotentialMislinks: number;
  };
  reviewQueue: {
    openOrderRouteFlips: number;
    openIdentityReviewItems: number; // Phase 1 surface
    openPirateShipMislinkItems: number;
  };
  mirrorLinks: {
    deterministic: number;
    probable: number;
    manual: number;
    rejected: number;
  };
  holds: {
    onHold: number;
    released: number;
    cancelled: number;
  };
  preorderPending: {
    direct: number;
    shipstationMirror: number;
  };
  writebacks: {
    pending: number;
    inProgress: number;
    succeeded: number;
    partialSucceeded: number;
    failedRetryable: number;
    failedTerminal: number;
    blockedMissingIdentity: number;
    blockedBandcampGenericPath: number;
    notRequired: number;
  };
  generatedAt: string;
}

const DAY_MS = 86_400_000;

export async function getOrderTransitionDiagnostics(): Promise<OrderTransitionDiagnostics> {
  const { workspaceId } = await requireStaff();
  const flags = await getWorkspaceFlags(workspaceId);
  const { routeMode, legacyShipstationUnifiedShipping } = await getOrdersRouteMode(workspaceId);

  const supabase = createServiceRoleClient();

  const now = Date.now();
  const last30dIso = new Date(now - 30 * DAY_MS).toISOString();
  const last90dIso = new Date(now - 90 * DAY_MS).toISOString();
  const last180dIso = new Date(now - 180 * DAY_MS).toISOString();

  const [
    warehouseOrdersTotal,
    warehouseOrdersLast30d,
    warehouseOrdersLast90d,
    shipstationOrdersTotal,
    shipstationOrdersLast30d,
    shipstationOrdersLast90d,
    shipmentsTotal,
    shipmentsByLabelSource,
    pirateShipPotentialMislinks,
    openOrderRouteFlips,
    openPirateShipMislinkItems,
    warehouseOrdersWithoutConnectionId,
    warehouseOrdersAmbiguousIdentity,
    openIdentityReviewItems,
  ] = await Promise.all([
    countRows(supabase, "warehouse_orders", workspaceId, undefined),
    countRows(supabase, "warehouse_orders", workspaceId, {
      column: "created_at",
      gteIso: last30dIso,
    }),
    countRows(supabase, "warehouse_orders", workspaceId, {
      column: "created_at",
      gteIso: last90dIso,
    }),
    countRows(supabase, "shipstation_orders", workspaceId, undefined),
    countRows(supabase, "shipstation_orders", workspaceId, {
      column: "created_at",
      gteIso: last30dIso,
    }),
    countRows(supabase, "shipstation_orders", workspaceId, {
      column: "created_at",
      gteIso: last90dIso,
    }),
    countRows(supabase, "warehouse_shipments", workspaceId, undefined),
    countShipmentsByLabelSource(supabase, workspaceId),
    countPirateShipPotentialMislinks(supabase, workspaceId, last180dIso),
    countOpenReviewQueue(supabase, workspaceId, "order_route_mode_change"),
    countOpenReviewQueue(supabase, workspaceId, "pirate_ship_potential_mislink"),
    countWarehouseOrdersWithoutConnection(supabase, workspaceId),
    countWarehouseOrdersByIdentityStatus(supabase, workspaceId, "ambiguous"),
    countOpenIdentityReviewQueue(supabase, workspaceId),
  ]);

  const [mirrorLinkCounts, holdCounts, preorderPendingCounts, writebackCounts] = await Promise.all([
    countMirrorLinkConfidence(supabase, workspaceId),
    countOrdersByHoldState(supabase, workspaceId),
    countPreorderPendingBySurface(supabase, workspaceId),
    countWritebackStatuses(supabase, workspaceId),
  ]);

  const effectiveSurface: "direct" | "shipstation_mirror" =
    routeMode === "shipstation_mirror"
      ? "shipstation_mirror"
      : routeMode === "direct"
        ? "direct"
        : (flags.shipstation_unified_shipping ?? false)
          ? "shipstation_mirror"
          : "direct";

  return {
    workspaceId,
    routeMode,
    legacyShipstationUnifiedShipping,
    effectiveSurface,
    counts: {
      warehouseOrdersTotal,
      warehouseOrdersLast30d,
      warehouseOrdersLast90d,
      shipstationOrdersTotal,
      shipstationOrdersLast30d,
      shipstationOrdersLast90d,
      warehouseOrdersWithoutConnectionId,
      warehouseOrdersAmbiguousIdentity,
    },
    shipments: {
      total: shipmentsTotal,
      bySource: shipmentsByLabelSource,
      pirateShipPotentialMislinks,
    },
    reviewQueue: {
      openOrderRouteFlips,
      openIdentityReviewItems,
      openPirateShipMislinkItems,
    },
    mirrorLinks: mirrorLinkCounts,
    holds: holdCounts,
    preorderPending: preorderPendingCounts,
    writebacks: writebackCounts,
    generatedAt: new Date().toISOString(),
  };
}

async function countWritebackStatuses(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<OrderTransitionDiagnostics["writebacks"]> {
  const seed: OrderTransitionDiagnostics["writebacks"] = {
    pending: 0,
    inProgress: 0,
    succeeded: 0,
    partialSucceeded: 0,
    failedRetryable: 0,
    failedTerminal: 0,
    blockedMissingIdentity: 0,
    blockedBandcampGenericPath: 0,
    notRequired: 0,
  };
  const { data, error } = await supabase
    .from("platform_fulfillment_writebacks")
    .select("status")
    .eq("workspace_id", workspaceId);
  if (error) {
    console.error("[order-transition-diagnostics] countWritebackStatuses failed", error.message);
    return seed;
  }
  for (const row of data ?? []) {
    const s = (row as { status: string }).status;
    switch (s) {
      case "pending":
        seed.pending += 1;
        break;
      case "in_progress":
        seed.inProgress += 1;
        break;
      case "succeeded":
        seed.succeeded += 1;
        break;
      case "partial_succeeded":
        seed.partialSucceeded += 1;
        break;
      case "failed_retryable":
        seed.failedRetryable += 1;
        break;
      case "failed_terminal":
        seed.failedTerminal += 1;
        break;
      case "blocked_missing_identity":
        seed.blockedMissingIdentity += 1;
        break;
      case "blocked_bandcamp_generic_path":
        seed.blockedBandcampGenericPath += 1;
        break;
      case "not_required":
        seed.notRequired += 1;
        break;
    }
  }
  return seed;
}

async function countOrdersByHoldState(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<OrderTransitionDiagnostics["holds"]> {
  const seed: OrderTransitionDiagnostics["holds"] = {
    onHold: 0,
    released: 0,
    cancelled: 0,
  };
  const states: Array<keyof typeof seed> = ["onHold", "released", "cancelled"];
  const stateToColumn: Record<keyof typeof seed, string> = {
    onHold: "on_hold",
    released: "released",
    cancelled: "cancelled",
  };
  await Promise.all(
    states.map(async (k) => {
      const { count, error } = await supabase
        .from("warehouse_orders")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("fulfillment_hold", stateToColumn[k]);
      if (!error) seed[k] = count ?? 0;
    }),
  );
  return seed;
}

async function countPreorderPendingBySurface(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<OrderTransitionDiagnostics["preorderPending"]> {
  const seed: OrderTransitionDiagnostics["preorderPending"] = {
    direct: 0,
    shipstationMirror: 0,
  };
  const { data, error } = await supabase
    .from("preorder_pending_orders")
    .select("surface")
    .eq("workspace_id", workspaceId);
  if (error) {
    console.error(
      "[order-transition-diagnostics] countPreorderPendingBySurface failed",
      error.message,
    );
    return seed;
  }
  for (const row of data ?? []) {
    const s = (row as { surface: "direct" | "shipstation_mirror" }).surface;
    if (s === "direct") seed.direct += 1;
    else if (s === "shipstation_mirror") seed.shipstationMirror += 1;
  }
  return seed;
}

async function countMirrorLinkConfidence(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<OrderTransitionDiagnostics["mirrorLinks"]> {
  const { data, error } = await supabase
    .from("order_mirror_links")
    .select("confidence")
    .eq("workspace_id", workspaceId);
  const seed: OrderTransitionDiagnostics["mirrorLinks"] = {
    deterministic: 0,
    probable: 0,
    manual: 0,
    rejected: 0,
  };
  if (error) {
    console.error("[order-transition-diagnostics] countMirrorLinkConfidence failed", error.message);
    return seed;
  }
  for (const row of data ?? []) {
    const c = (row as { confidence: keyof typeof seed }).confidence;
    if (c in seed) seed[c] += 1;
  }
  return seed;
}

interface CountFilter {
  column: string;
  gteIso: string;
}

async function countRows(
  supabase: ReturnType<typeof createServiceRoleClient>,
  table: string,
  workspaceId: string,
  filter: CountFilter | undefined,
): Promise<number> {
  let query = supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (filter) {
    query = query.gte(filter.column, filter.gteIso);
  }
  const { count, error } = await query;
  if (error) {
    // Don't fail the whole diagnostics call for one missing column / table.
    console.error(`[order-transition-diagnostics] count(${table}) failed`, error.message);
    return 0;
  }
  return count ?? 0;
}

async function countShipmentsByLabelSource(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<OrderTransitionDiagnostics["shipments"]["bySource"]> {
  const { data, error } = await supabase
    .from("warehouse_shipments")
    .select("label_source")
    .eq("workspace_id", workspaceId);

  const seed: OrderTransitionDiagnostics["shipments"]["bySource"] = {
    shipstation: 0,
    easypost: 0,
    pirate_ship: 0,
    manual: 0,
    unknown: 0,
  };
  if (error) {
    console.error(
      "[order-transition-diagnostics] countShipmentsByLabelSource failed",
      error.message,
    );
    return seed;
  }
  for (const row of data ?? []) {
    const source = (row as { label_source: string | null }).label_source;
    switch (source) {
      case "shipstation":
        seed.shipstation += 1;
        break;
      case "easypost":
        seed.easypost += 1;
        break;
      case "pirate_ship":
        seed.pirate_ship += 1;
        break;
      case "manual":
        seed.manual += 1;
        break;
      default:
        seed.unknown += 1;
    }
  }
  return seed;
}

/**
 * Heuristic mirror of the historical Pirate Ship audit Trigger task: count
 * shipments where the parent warehouse_orders.created_at is more than 180
 * days BEFORE the shipment's effective ship date. Plan §"Pirate Ship
 * historical link audit" — we never auto-unlink (would break customer
 * tracking links); we only count and surface.
 *
 * Uses `coalesce(ship_date, created_at)` because some early Pirate Ship
 * imports never wrote a ship_date.
 */
async function countPirateShipPotentialMislinks(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  cutoffIso: string,
): Promise<number> {
  // We can't express the cross-row temporal predicate via PostgREST in one
  // shot, so we pull the candidate set (Pirate Ship shipments older than
  // the cutoff window with an order_id set) and let the runner-side check
  // do the temporal comparison. Keeps the diagnostic cheap (capped at 5k).
  const { data, error } = await supabase
    .from("warehouse_shipments")
    .select("id, ship_date, created_at, order_id, warehouse_orders(created_at)")
    .eq("workspace_id", workspaceId)
    .eq("label_source", "pirate_ship")
    .not("order_id", "is", null)
    .lt("created_at", cutoffIso)
    .limit(5_000);
  if (error) {
    console.error(
      "[order-transition-diagnostics] countPirateShipPotentialMislinks failed",
      error.message,
    );
    return 0;
  }

  let mislinks = 0;
  for (const row of data ?? []) {
    const r = row as {
      ship_date: string | null;
      created_at: string;
      warehouse_orders: { created_at: string } | { created_at: string }[] | null;
    };
    const orderRow = Array.isArray(r.warehouse_orders) ? r.warehouse_orders[0] : r.warehouse_orders;
    if (!orderRow?.created_at) continue;
    const shipMs = Date.parse(r.ship_date ?? r.created_at);
    const orderMs = Date.parse(orderRow.created_at);
    if (Number.isNaN(shipMs) || Number.isNaN(orderMs)) continue;
    if (shipMs - orderMs > 180 * DAY_MS) {
      mislinks += 1;
    }
  }
  return mislinks;
}

async function countOpenReviewQueue(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  category: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("warehouse_review_queue")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("category", category)
    .eq("status", "open");
  if (error) {
    console.error(
      `[order-transition-diagnostics] countOpenReviewQueue(${category}) failed`,
      error.message,
    );
    return 0;
  }
  return count ?? 0;
}

async function countWarehouseOrdersWithoutConnection(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("warehouse_orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .is("connection_id", null);
  if (error) {
    console.error(
      "[order-transition-diagnostics] countWarehouseOrdersWithoutConnection failed",
      error.message,
    );
    return 0;
  }
  return count ?? 0;
}

async function countWarehouseOrdersByIdentityStatus(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  status: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("warehouse_orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("identity_resolution_status", status);
  if (error) {
    console.error(
      `[order-transition-diagnostics] countWarehouseOrdersByIdentityStatus(${status}) failed`,
      error.message,
    );
    return 0;
  }
  return count ?? 0;
}

async function countOpenIdentityReviewQueue(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("warehouse_order_identity_review_queue")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("status", ["open", "in_progress"]);
  if (error) {
    console.error(
      "[order-transition-diagnostics] countOpenIdentityReviewQueue failed",
      error.message,
    );
    return 0;
  }
  return count ?? 0;
}
