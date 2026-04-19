"use server";

import { tasks } from "@trigger.dev/sdk";
import { fetchOrders, type ShipStationOrder } from "@/lib/clients/shipstation";
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export type { ShipStationOrder };

export interface ShipStationOrderFilters {
  status?: string; // 'awaiting_shipment' | 'shipped' | 'awaiting_payment' | 'all'
  page?: number;
  pageSize?: number;
}

/**
 * Fetch live ShipStation orders directly from the ShipStation API.
 * Staff-only. No DB read/write — data is always current.
 *
 * Kept as the "Force refresh from SS" fallback (Phase 2.1). The cockpit's
 * primary read path is `getShipStationOrdersDb` below.
 */
export async function getShipStationOrders(filters: ShipStationOrderFilters = {}) {
  await requireStaff();
  return fetchOrders({
    orderStatus: filters.status ?? "awaiting_shipment",
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? 500,
  });
}

// ── Phase 2.1 — DB-backed cockpit read path ──────────────────────────────────

export type CockpitTab = "all" | "preorder" | "preorder_ready" | "needs_assignment";
export type CockpitSort = "client_then_date" | "date" | "order_number" | "release_date";

export interface CockpitFilters {
  /** Default 'awaiting_shipment'. Pass 'all' to ignore status. */
  orderStatus?: string;
  /** Filter to a single org (or 'unassigned' for org_id IS NULL). */
  orgId?: string;
  /** Tab selector — see CockpitTab. */
  tab?: CockpitTab;
  /** Free-text search across order#, customer name/email, ship-to, SKU. */
  search?: string;
  /** Sort key. */
  sort?: CockpitSort;
  /** 1-indexed. */
  page?: number;
  /** 50 / 100 / 250 (cap 500). */
  pageSize?: number;
}

export interface CockpitOrderItem {
  sku: string | null;
  name: string | null;
  quantity: number;
  unit_price: number | null;
  item_index: number;
}

export interface CockpitOrderShipment {
  id: string;
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  shipstation_marked_shipped_at: string | null;
  shipstation_writeback_path: "v2" | "v1" | null;
  shipstation_writeback_error: string | null;
  /** SS-returned tracking URL when present (lives in label_data.shipstation_tracking_url). */
  shipstation_tracking_url: string | null;
}

export interface CockpitOrder {
  id: string;
  shipstation_order_id: number;
  order_number: string;
  order_status: string;
  order_date: string | null;
  customer_email: string | null;
  customer_name: string | null;
  ship_to: Record<string, unknown> | null;
  store_id: number | null;
  amount_paid: number | null;
  shipping_paid: number | null;
  last_modified: string | null;
  preorder_state: "none" | "preorder" | "ready";
  preorder_release_date: string | null;
  org_id: string | null;
  org_name: string | null;
  items: CockpitOrderItem[];
  /** Phase 4.5 — most recent EP-printed shipment for this order. Null when staff hasn't bought a label yet. */
  shipment: CockpitOrderShipment | null;
}

export interface CockpitTabCounts {
  all: number;
  preorder: number;
  preorder_ready: number;
  needs_assignment: number;
}

export interface CockpitResponse {
  orders: CockpitOrder[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  tabCounts: CockpitTabCounts;
}

const VALID_PAGE_SIZES = [50, 100, 250, 500] as const;

/**
 * Phase 2.1 — DB-backed cockpit read path. Reads from shipstation_orders +
 * shipstation_order_items + organizations(name) join.
 *
 * Tab semantics:
 *   - 'all'              → no preorder filter
 *   - 'preorder'         → preorder_state = 'preorder'
 *   - 'preorder_ready'   → preorder_state = 'ready'
 *   - 'needs_assignment' → org_id IS NULL  (Phase 1 retro drift-check addition)
 *
 * Sort semantics:
 *   - 'client_then_date' → org name ASC, order_date DESC, order_number ASC
 *   - 'date'             → order_date DESC
 *   - 'order_number'     → order_number ASC
 *
 * Search hits order_number, customer_name, customer_email, ship_to->>name,
 * and via item join — sku, name. Items search is a separate query merged in
 * application code (Postgres OR across joined columns is awkward in PostgREST).
 */
export async function getShipStationOrdersDb(
  filters: CockpitFilters = {},
): Promise<CockpitResponse> {
  await requireStaff();
  const supabase = await createServerSupabaseClient();

  const page = Math.max(1, filters.page ?? 1);
  const pageSize = (VALID_PAGE_SIZES as readonly number[]).includes(filters.pageSize ?? 50)
    ? (filters.pageSize ?? 50)
    : 50;
  const tab: CockpitTab = filters.tab ?? "all";
  const orderStatus = filters.orderStatus ?? "awaiting_shipment";
  const sort: CockpitSort = filters.sort ?? "client_then_date";

  // ── 1. Helper: apply base filter to any select-builder. Typed loosely
  //       because PostgREST's chain types don't generalize well across
  //       count-only and row-returning selects in the same generic.
  type Filterable = {
    eq: (col: string, val: unknown) => Filterable;
    is: (col: string, val: unknown) => Filterable;
    in: (col: string, vals: readonly unknown[]) => Filterable;
  };
  const applyBaseFilter = (q: Filterable): Filterable => {
    let r = q;
    if (orderStatus !== "all") r = r.eq("order_status", orderStatus);
    if (filters.orgId === "unassigned") r = r.is("org_id", null);
    else if (filters.orgId) r = r.eq("org_id", filters.orgId);
    return r;
  };
  const applyTabFilter = (q: Filterable): Filterable => {
    let r = q;
    if (tab === "preorder") r = r.eq("preorder_state", "preorder");
    else if (tab === "preorder_ready") r = r.eq("preorder_state", "ready");
    else if (tab === "needs_assignment") r = r.is("org_id", null);
    if (searchOrderIds) r = r.in("id", searchOrderIds);
    return r;
  };

  // ── 2. Resolve the "search" SKU → order_id mapping if needed. PostgREST
  //       doesn't easily OR across joined columns, so we do this in two steps.
  let searchOrderIds: string[] | null = null;
  if (filters.search?.trim()) {
    const term = filters.search.trim();
    // SKU / name match on items.
    const { data: itemHits } = await supabase
      .from("shipstation_order_items")
      .select("shipstation_order_id")
      .or(`sku.ilike.%${term}%,name.ilike.%${term}%`)
      .limit(2000);
    const itemOrderIds = new Set((itemHits ?? []).map((r) => r.shipstation_order_id as string));
    // Order-level match on order_number / customer fields. Apply base filter
    // so search is scoped to whatever status/org the user has selected.
    const orderHitsBuilder = supabase
      .from("shipstation_orders")
      .select("id")
      .or(
        `order_number.ilike.%${term}%,customer_email.ilike.%${term}%,customer_name.ilike.%${term}%`,
      );
    const orderHits = applyBaseFilter(orderHitsBuilder as unknown as Filterable);
    const { data: orderHitsRows } = await (orderHits as unknown as {
      limit: (n: number) => Promise<{ data: Array<{ id: string }> | null }>;
    }).limit(2000);
    const orderLevelIds = new Set((orderHitsRows ?? []).map((r) => r.id));
    const merged = new Set([...itemOrderIds, ...orderLevelIds]);
    searchOrderIds = merged.size > 0 ? Array.from(merged) : ["__no_match__"];
  }

  // ── 3. Total + tab counts (in parallel). Each starts a fresh head-only
  //       count query so the chain types stay clean.
  const baseTotal = applyTabFilter(
    applyBaseFilter(
      supabase
        .from("shipstation_orders")
        .select("id", { count: "exact", head: true }) as unknown as Filterable,
    ),
  );
  const baseAll = applyBaseFilter(
    supabase.from("shipstation_orders").select("id", { count: "exact", head: true }) as unknown as Filterable,
  );
  const basePre = applyBaseFilter(
    supabase
      .from("shipstation_orders")
      .select("id", { count: "exact", head: true }) as unknown as Filterable,
  ).eq("preorder_state", "preorder");
  const baseReady = applyBaseFilter(
    supabase
      .from("shipstation_orders")
      .select("id", { count: "exact", head: true }) as unknown as Filterable,
  ).eq("preorder_state", "ready");
  const baseNA = applyBaseFilter(
    supabase
      .from("shipstation_orders")
      .select("id", { count: "exact", head: true }) as unknown as Filterable,
  ).is("org_id", null);

  type Counted = Promise<{ count: number | null }>;
  const [
    { count: totalCount },
    { count: cAll },
    { count: cPreorder },
    { count: cReady },
    { count: cNeedsAssignment },
  ] = await Promise.all([
    baseTotal as unknown as Counted,
    baseAll as unknown as Counted,
    basePre as unknown as Counted,
    baseReady as unknown as Counted,
    baseNA as unknown as Counted,
  ]);

  // ── 4. The row query — joined to organizations(name) + items.
  const rowBuilder = supabase
    .from("shipstation_orders")
    .select(
      `
      id, shipstation_order_id, order_number, order_status, order_date,
      customer_email, customer_name, ship_to, store_id, amount_paid,
      shipping_paid, last_modified, preorder_state, preorder_release_date,
      org_id,
      organizations ( name ),
      shipstation_order_items ( sku, name, quantity, unit_price, item_index )
      `,
    );

  type Sortable = Filterable & {
    order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => Sortable;
    range: (from: number, to: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  let rowQuery = applyTabFilter(applyBaseFilter(rowBuilder as unknown as Filterable)) as unknown as Sortable;

  if (sort === "client_then_date") {
    rowQuery = rowQuery
      .order("org_id", { ascending: true, nullsFirst: false })
      .order("order_date", { ascending: false })
      .order("order_number", { ascending: true });
  } else if (sort === "date") {
    rowQuery = rowQuery.order("order_date", { ascending: false });
  } else if (sort === "release_date") {
    // Phase 5.4 — sort the preorder tabs by upcoming release date so staff
    // see what's about to ship at the top.
    rowQuery = rowQuery
      .order("preorder_release_date", { ascending: true, nullsFirst: false })
      .order("order_number", { ascending: true });
  } else {
    rowQuery = rowQuery.order("order_number", { ascending: true });
  }

  const { data: rows, error } = await rowQuery.range(
    (page - 1) * pageSize,
    page * pageSize - 1,
  );
  if (error) throw new Error(`getShipStationOrdersDb: ${error.message}`);

  type RawRow = {
    id: string;
    shipstation_order_id: number;
    order_number: string;
    order_status: string;
    order_date: string | null;
    customer_email: string | null;
    customer_name: string | null;
    ship_to: Record<string, unknown> | null;
    store_id: number | null;
    amount_paid: number | null;
    shipping_paid: number | null;
    last_modified: string | null;
    preorder_state: "none" | "preorder" | "ready";
    preorder_release_date: string | null;
    org_id: string | null;
    organizations: { name?: string } | null;
    shipstation_order_items: Array<{
      sku: string | null;
      name: string | null;
      quantity: number;
      unit_price: number | null;
      item_index: number;
    }>;
  };
  const rowList = (rows ?? []) as RawRow[];

  // Phase 4.5 — hydrate the most-recent EP-printed shipment per row in one
  // additional query. We use shipstation_order_id (text on warehouse_shipments)
  // to match. Cockpit shows tracking + writeback state from this join.
  const ssIdsForShipmentLookup = rowList.map((r) => String(r.shipstation_order_id));
  const shipmentByOrder = new Map<string, CockpitOrderShipment>();
  if (ssIdsForShipmentLookup.length > 0) {
    const { data: shipmentRows } = await supabase
      .from("warehouse_shipments")
      .select(
        `id, shipstation_order_id, tracking_number, carrier, service, ship_date, label_source,
         shipstation_marked_shipped_at, shipstation_writeback_path, shipstation_writeback_error,
         label_data`,
      )
      .in("shipstation_order_id", ssIdsForShipmentLookup)
      .eq("label_source", "easypost")
      .order("ship_date", { ascending: false });

    for (const s of shipmentRows ?? []) {
      const orderKey = String(s.shipstation_order_id);
      // Only set the FIRST (most recent) per order.
      if (shipmentByOrder.has(orderKey)) continue;
      const labelData = (s.label_data ?? {}) as Record<string, unknown>;
      const trackingUrl = typeof labelData.shipstation_tracking_url === "string"
        ? (labelData.shipstation_tracking_url as string)
        : null;
      shipmentByOrder.set(orderKey, {
        id: s.id,
        tracking_number: s.tracking_number,
        carrier: s.carrier,
        service: s.service,
        shipstation_marked_shipped_at: s.shipstation_marked_shipped_at,
        shipstation_writeback_path: s.shipstation_writeback_path as "v2" | "v1" | null,
        shipstation_writeback_error: s.shipstation_writeback_error,
        shipstation_tracking_url: trackingUrl,
      });
    }
  }

  const orders: CockpitOrder[] = rowList.map((r) => ({
    id: r.id,
    shipstation_order_id: r.shipstation_order_id,
    order_number: r.order_number,
    order_status: r.order_status,
    order_date: r.order_date,
    customer_email: r.customer_email,
    customer_name: r.customer_name,
    ship_to: r.ship_to,
    store_id: r.store_id,
    amount_paid: r.amount_paid,
    shipping_paid: r.shipping_paid,
    last_modified: r.last_modified,
    preorder_state: r.preorder_state,
    preorder_release_date: r.preorder_release_date,
    org_id: r.org_id,
    org_name: r.organizations?.name ?? null,
    items: (r.shipstation_order_items ?? []).sort((a, b) => a.item_index - b.item_index),
    shipment: shipmentByOrder.get(String(r.shipstation_order_id)) ?? null,
  }));

  const total = totalCount ?? 0;
  return {
    orders,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    tabCounts: {
      all: cAll ?? 0,
      preorder: cPreorder ?? 0,
      preorder_ready: cReady ?? 0,
      needs_assignment: cNeedsAssignment ?? 0,
    },
  };
}

/**
 * Phase 2.1 — Force a narrow re-poll from the cockpit's "Refresh from SS" button.
 * Enqueues the windowed poll task (defaults 30 min) so cockpit updates within
 * seconds without burning SS rate-limit budget on a full cron run.
 */
export async function refreshShipStationOrdersFromSS(payload: {
  windowMinutes?: number;
} = {}): Promise<{ ok: true; runId: string }> {
  await requireStaff();
  const run = await tasks.trigger("shipstation-orders-poll-window", {
    windowMinutes: payload.windowMinutes ?? 30,
  });
  return { ok: true, runId: run.id };
}

/**
 * Phase 2.1 / Phase 1 retro drift-check — manually assign an org to a SS order
 * that ingested with org_id NULL. Used by the cockpit "Needs assignment" tab.
 */
export async function assignOrgToShipStationOrder(input: {
  shipstationOrderId: string; // shipstation_orders.id (uuid), NOT the bigint SS id
  orgId: string;
}): Promise<{ ok: true }> {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("shipstation_orders")
    .update({ org_id: input.orgId, updated_at: new Date().toISOString() })
    .eq("id", input.shipstationOrderId);
  if (error) throw new Error(`assignOrgToShipStationOrder: ${error.message}`);
  return { ok: true };
}
