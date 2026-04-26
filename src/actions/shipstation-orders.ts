"use server";

import { tasks } from "@trigger.dev/sdk";
import { verifyAddress } from "@/lib/clients/easypost-client";
import {
  addOrderTag,
  fetchOrders,
  holdOrderUntil,
  listTags as listShipStationTags,
  removeOrderTag,
  restoreOrderFromHold,
  type ShipStationOrder,
  type ShipStationTag,
} from "@/lib/clients/shipstation";
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { parsePaymentIdFromCustomField } from "@/lib/shared/bandcamp-reconcile-helpers";

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
  /** Phase 8.5 — filter to orders that have ALL of these tag IDs. Empty = no filter. */
  tagIds?: number[];
  /** Phase 8.2 — filter to a specific SS storeId. */
  storeId?: number;
  /** Phase 9.3 — filter to a specific assigned staff user (or "me" for the
   *  current caller). NOT the SS-side assignee_user_id. */
  assignedUserId?: string | "me";
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
  /**
   * Slice 4 — token for the public /track/[token] page. Used by the
   * cockpit to render a "View as customer" link next to the carrier
   * tracking link, so staff can see exactly what the customer sees.
   * Nullable for legacy shipments printed before the token rollout.
   */
  public_track_token: string | null;
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
  // Phase 8 extensions
  tag_ids: number[];
  hold_until_date: string | null;
  ship_by_date: string | null;
  deliver_by_date: string | null;
  payment_date: string | null;
  assignee_user_id: string | null;
  allocation_status: string | null;
  // Phase 9.3 — OUR staff assignment (NOT synced to SS). Distinct from
  // assignee_user_id which mirrors the SS-side assignee.
  assigned_user_id: string | null;
  assigned_at: string | null;
}

export interface StatusBucketCounts {
  awaiting_payment: number;
  awaiting_shipment: number;
  on_hold: number;
  shipped: number;
  cancelled: number;
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
    contains: (col: string, val: unknown) => Filterable;
  };
  // Resolve "me" to the current caller's auth.users.id so the cockpit can
  // wire an "Assigned to me" sidebar bucket without juggling user ids client-
  // side. We look it up once per call.
  let resolvedAssignedUserId: string | null = null;
  if (filters.assignedUserId === "me") {
    const { data: who } = await supabase.auth.getUser();
    resolvedAssignedUserId = who?.user?.id ?? null;
  } else if (filters.assignedUserId) {
    resolvedAssignedUserId = filters.assignedUserId;
  }
  const applyBaseFilter = (q: Filterable): Filterable => {
    let r = q;
    if (orderStatus !== "all") r = r.eq("order_status", orderStatus);
    if (filters.orgId === "unassigned") r = r.is("org_id", null);
    else if (filters.orgId) r = r.eq("org_id", filters.orgId);
    if (filters.storeId) r = r.eq("store_id", filters.storeId);
    if (filters.tagIds && filters.tagIds.length > 0) {
      r = r.contains("tag_ids", filters.tagIds);
    }
    if (resolvedAssignedUserId) r = r.eq("assigned_user_id", resolvedAssignedUserId);
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
    const { data: orderHitsRows } = await (
      orderHits as unknown as {
        limit: (n: number) => Promise<{ data: Array<{ id: string }> | null }>;
      }
    ).limit(2000);
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
    supabase
      .from("shipstation_orders")
      .select("id", { count: "exact", head: true }) as unknown as Filterable,
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
  const rowBuilder = supabase.from("shipstation_orders").select(
    `
      id, shipstation_order_id, order_number, order_status, order_date,
      customer_email, customer_name, ship_to, store_id, amount_paid,
      shipping_paid, last_modified, preorder_state, preorder_release_date,
      org_id,
      tag_ids, hold_until_date, ship_by_date, deliver_by_date,
      payment_date, assignee_user_id, allocation_status,
      assigned_user_id, assigned_at,
      organizations ( name ),
      shipstation_order_items ( sku, name, quantity, unit_price, item_index )
      `,
  );

  type Sortable = Filterable & {
    order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => Sortable;
    range: (
      from: number,
      to: number,
    ) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  let rowQuery = applyTabFilter(
    applyBaseFilter(rowBuilder as unknown as Filterable),
  ) as unknown as Sortable;

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

  const { data: rows, error } = await rowQuery.range((page - 1) * pageSize, page * pageSize - 1);
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
    tag_ids: number[] | null;
    hold_until_date: string | null;
    ship_by_date: string | null;
    deliver_by_date: string | null;
    payment_date: string | null;
    assignee_user_id: string | null;
    allocation_status: string | null;
    assigned_user_id: string | null;
    assigned_at: string | null;
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
         label_data, public_track_token`,
      )
      .in("shipstation_order_id", ssIdsForShipmentLookup)
      .eq("label_source", "easypost")
      .order("ship_date", { ascending: false });

    for (const s of shipmentRows ?? []) {
      const orderKey = String(s.shipstation_order_id);
      // Only set the FIRST (most recent) per order.
      if (shipmentByOrder.has(orderKey)) continue;
      const labelData = (s.label_data ?? {}) as Record<string, unknown>;
      const trackingUrl =
        typeof labelData.shipstation_tracking_url === "string"
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
        public_track_token:
          (s as { public_track_token?: string | null }).public_track_token ?? null,
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
    tag_ids: r.tag_ids ?? [],
    hold_until_date: r.hold_until_date,
    ship_by_date: r.ship_by_date,
    deliver_by_date: r.deliver_by_date,
    payment_date: r.payment_date,
    assignee_user_id: r.assignee_user_id,
    allocation_status: r.allocation_status,
    assigned_user_id: r.assigned_user_id,
    assigned_at: r.assigned_at,
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
export async function refreshShipStationOrdersFromSS(
  payload: { windowMinutes?: number } = {},
): Promise<{ ok: true; runId: string }> {
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

// ── Phase 8.1 + 8.2 — Status-bucket counts for the left sidebar ──────────────

/**
 * Phase 8.1 — counts per order_status for the cockpit's left sidebar.
 * Optionally scoped to an org or store. Returns 0 for missing buckets.
 */
export async function getStatusBucketCounts(
  filters: { orgId?: string; storeId?: number } = {},
): Promise<StatusBucketCounts> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  // One head-only count per status. 5 round-trips per render is acceptable
  // at typical workspace scale (~1.2k SS orders today). If this becomes hot,
  // promote to a single grouped query via .rpc() or a view.
  const STATUSES = [
    "awaiting_payment",
    "awaiting_shipment",
    "on_hold",
    "shipped",
    "cancelled",
  ] as const;

  const counts: StatusBucketCounts = {
    awaiting_payment: 0,
    awaiting_shipment: 0,
    on_hold: 0,
    shipped: 0,
    cancelled: 0,
  };

  await Promise.all(
    STATUSES.map(async (status) => {
      let q = supabase
        .from("shipstation_orders")
        .select("id", { count: "exact", head: true })
        .eq("order_status", status);
      if (filters.orgId === "unassigned") q = q.is("org_id", null);
      else if (filters.orgId) q = q.eq("org_id", filters.orgId);
      if (filters.storeId) q = q.eq("store_id", filters.storeId);
      const { count } = await q;
      counts[status] = count ?? 0;
    }),
  );

  return counts;
}

/**
 * Phase 8.2 — distinct orgs that currently have awaiting_shipment orders, with
 * counts. Powers the left-sidebar org list.
 */
export interface OrgBucketRow {
  org_id: string | null;
  org_name: string | null;
  awaiting_shipment_count: number;
}

export async function getOrgBucketsForCockpit(): Promise<OrgBucketRow[]> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  // Pull awaiting-shipment rows joined to organizations, then aggregate in
  // app code. Simpler than a custom view; bounded by total awaiting_shipment.
  const { data } = await supabase
    .from("shipstation_orders")
    .select("org_id, organizations ( name )")
    .eq("order_status", "awaiting_shipment");

  const byOrg = new Map<string, OrgBucketRow>();
  for (const row of (data ?? []) as Array<{
    org_id: string | null;
    organizations: { name?: string } | null;
  }>) {
    const key = row.org_id ?? "__unassigned__";
    const existing = byOrg.get(key);
    if (existing) {
      existing.awaiting_shipment_count++;
    } else {
      byOrg.set(key, {
        org_id: row.org_id,
        org_name: row.organizations?.name ?? null,
        awaiting_shipment_count: 1,
      });
    }
  }

  return Array.from(byOrg.values()).sort((a, b) => {
    if (a.org_id === null && b.org_id !== null) return -1; // unassigned bubbles to top
    if (b.org_id === null && a.org_id !== null) return 1;
    return (a.org_name ?? "").localeCompare(b.org_name ?? "");
  });
}

/**
 * Phase 8 polish — list orgs in this workspace for the manual org-assignment
 * dropdown in the "Needs assignment" drawer.
 */
export async function listOrgsForAssignment(): Promise<Array<{ id: string; name: string }>> {
  await requireStaff();
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });
  return (data ?? []) as Array<{ id: string; name: string }>;
}

// ── Phase 8.5 — Tag editing ─────────────────────────────────────────────────

/**
 * Phase 8.5 — list all SS tags (cached 1h in the v1 client). Cockpit calls
 * this to populate the Edit Tags dropdown.
 */
export async function listShipStationTagDefinitions(): Promise<ShipStationTag[]> {
  await requireStaff();
  return listShipStationTags();
}

/**
 * Phase 8.5 — add/remove tags on a SS order. Optimistic local update +
 * enqueue a windowed re-poll so the cockpit picks up the canonical state
 * within ~30s.
 */
export async function editOrderTags(input: {
  shipstationOrderUuid: string;
  addTagIds: number[];
  removeTagIds: number[];
}): Promise<{ ok: true; remoteSuccess: boolean; localTagIds: number[] }> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: order } = await supabase
    .from("shipstation_orders")
    .select("workspace_id, shipstation_order_id, tag_ids")
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();
  if (!order) throw new Error("editOrderTags: order not found");

  const ssOrderId = Number(order.shipstation_order_id);

  // Fire SS API calls. Each is a single round-trip; do not batch — we rely on
  // shipstationFetch's rate limiter.
  let remoteSuccess = true;
  for (const tagId of input.addTagIds) {
    try {
      await addOrderTag(ssOrderId, tagId);
    } catch {
      remoteSuccess = false;
    }
  }
  for (const tagId of input.removeTagIds) {
    try {
      await removeOrderTag(ssOrderId, tagId);
    } catch {
      remoteSuccess = false;
    }
  }

  // Optimistic local update — remove → add to handle "re-add same tag" idempotently.
  const current = (order.tag_ids ?? []) as number[];
  const without = current.filter((t) => !input.removeTagIds.includes(t));
  const localTagIds = Array.from(new Set([...without, ...input.addTagIds]));
  await supabase
    .from("shipstation_orders")
    .update({ tag_ids: localTagIds, updated_at: new Date().toISOString() })
    .eq("id", input.shipstationOrderUuid);

  // Reconcile via windowed re-poll (cron + webhook also catch it eventually).
  await tasks.trigger("shipstation-orders-poll-window", { windowMinutes: 5 });

  return { ok: true, remoteSuccess, localTagIds };
}

// ── Phase 8.6 — Hold Until / Restore from Hold ──────────────────────────────

/**
 * Phase 8.6 — set a hold-until date on a SS order. SS moves the order to
 * "on_hold" status until the date passes. holdUntilDate format: YYYY-MM-DD.
 */
export async function setOrderHoldUntil(input: {
  shipstationOrderUuid: string;
  holdUntilDate: string;
}): Promise<{ ok: true; remoteSuccess: boolean }> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: order } = await supabase
    .from("shipstation_orders")
    .select("shipstation_order_id")
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();
  if (!order) throw new Error("setOrderHoldUntil: order not found");

  let remoteSuccess = true;
  try {
    await holdOrderUntil(Number(order.shipstation_order_id), input.holdUntilDate);
  } catch {
    remoteSuccess = false;
  }

  // Optimistic local update — flip to on_hold + stamp the date.
  await supabase
    .from("shipstation_orders")
    .update({
      hold_until_date: input.holdUntilDate,
      order_status: "on_hold",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.shipstationOrderUuid);

  await tasks.trigger("shipstation-orders-poll-window", { windowMinutes: 5 });

  return { ok: true, remoteSuccess };
}

export async function restoreOrderFromHoldAction(input: {
  shipstationOrderUuid: string;
}): Promise<{ ok: true; remoteSuccess: boolean }> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: order } = await supabase
    .from("shipstation_orders")
    .select("shipstation_order_id")
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();
  if (!order) throw new Error("restoreOrderFromHold: order not found");

  let remoteSuccess = true;
  try {
    await restoreOrderFromHold(Number(order.shipstation_order_id));
  } catch {
    remoteSuccess = false;
  }

  await supabase
    .from("shipstation_orders")
    .update({
      hold_until_date: null,
      order_status: "awaiting_shipment",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.shipstationOrderUuid);

  await tasks.trigger("shipstation-orders-poll-window", { windowMinutes: 5 });

  return { ok: true, remoteSuccess };
}

// ── Phase 8.7 — Address verification preflight ──────────────────────────────

export interface AddressVerifyResult {
  verified: boolean;
  errors: string[];
}

/**
 * Phase 8.7 — run EP address verification on the persisted ship_to. Returns
 * a verified flag + any error messages. Callers cache by shipstation_order_id
 * for the session (UI hook).
 */
export async function verifyShipStationOrderAddress(input: {
  shipstationOrderUuid: string;
}): Promise<AddressVerifyResult> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: order } = await supabase
    .from("shipstation_orders")
    .select("ship_to")
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();
  if (!order || !order.ship_to) {
    return { verified: false, errors: ["No ship_to recorded for this order"] };
  }

  const st = order.ship_to as Record<string, unknown>;
  const s = (k: string): string => {
    const v = st[k];
    return typeof v === "string" ? v : "";
  };
  // EP expects { name, street1, city, state, zip, country, phone? }.
  return verifyAddress({
    name: s("name"),
    street1: s("street1"),
    street2: s("street2") || undefined,
    city: s("city"),
    state: s("state"),
    zip: s("postalCode") || s("zip"),
    country: s("country") || "US",
    phone: s("phone") || undefined,
  });
}

/**
 * Phase 8.7 — staff edits ship_to in the click-to-fix overlay; we persist the
 * fixed address back to shipstation_orders.ship_to. Also enqueue a windowed
 * re-poll so any SS-side transformations (e.g. SS auto-formats the city) get
 * captured.
 *
 * Note: SS does not document a clean per-field address PATCH on v1 outside
 * createorder (which is a full upsert). The local update is the source of
 * truth for label printing; pushing the fixed address back to SS is left as
 * a Phase 11 enrichment if needed.
 */
export async function updateShipStationOrderShipTo(input: {
  shipstationOrderUuid: string;
  ship_to: Record<string, unknown>;
}): Promise<{ ok: true }> {
  await requireStaff();
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("shipstation_orders")
    .update({ ship_to: input.ship_to, updated_at: new Date().toISOString() })
    .eq("id", input.shipstationOrderUuid);
  if (error) throw new Error(`updateShipStationOrderShipTo: ${error.message}`);
  return { ok: true };
}

// ── Phase 6.1 — Bandcamp reconciliation ─────────────────────────────────────

export type BandcampMatchConfidence = "high" | "medium" | "low" | "none";

export interface BandcampReconcileResult {
  matched_warehouse_order_id: string | null;
  bandcamp_payment_id: number | null;
  /** Order number in our DB (e.g. "BC-1234567"). */
  order_number: string | null;
  confidence: BandcampMatchConfidence;
  /** Why we matched (or didn't) — one short label per signal. */
  matched_via: string;
}

/**
 * Phase 6.1 — find the Bandcamp `warehouse_orders` row that corresponds to a
 * ShipStation order, in priority order:
 *   1. SS `advanced_options.customField1` carries the BC payment_id (high).
 *   2. (customer_email + total_price) within ±7 days of SS order_date (medium).
 *   3. ship-to name + city normalized (low).
 *
 * Returns null match with confidence='none' when no candidate fits. UI uses the
 * confidence label to decide whether to show the badge as a confident match
 * vs a "maybe" needs-staff-confirmation hint.
 */
export async function getBandcampMatchForShipStationOrder(input: {
  shipstationOrderUuid: string;
}): Promise<BandcampReconcileResult> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: ssOrder } = await supabase
    .from("shipstation_orders")
    .select(
      "workspace_id, customer_email, customer_name, ship_to, amount_paid, order_date, advanced_options",
    )
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();

  if (!ssOrder) {
    return {
      matched_warehouse_order_id: null,
      bandcamp_payment_id: null,
      order_number: null,
      confidence: "none",
      matched_via: "ss_order_not_found",
    };
  }

  // ── Tier 1: explicit payment_id in advanced_options.customField1 ──────────
  const adv = (ssOrder.advanced_options ?? {}) as Record<string, unknown>;
  const customField1Raw = typeof adv.customField1 === "string" ? adv.customField1 : null;
  const explicitPaymentId = customField1Raw ? parsePaymentIdFromCustomField(customField1Raw) : null;

  if (explicitPaymentId != null) {
    const { data: bcOrder } = await supabase
      .from("warehouse_orders")
      .select("id, order_number, bandcamp_payment_id")
      .eq("workspace_id", ssOrder.workspace_id)
      .eq("source", "bandcamp")
      .eq("bandcamp_payment_id", explicitPaymentId)
      .maybeSingle();
    if (bcOrder) {
      return {
        matched_warehouse_order_id: bcOrder.id,
        bandcamp_payment_id: bcOrder.bandcamp_payment_id ?? explicitPaymentId,
        order_number: bcOrder.order_number ?? null,
        confidence: "high",
        matched_via: "advanced_options.customField1 → bandcamp_payment_id",
      };
    }
  }

  // ── Tier 2: customer_email + total within ±7 days ─────────────────────────
  if (ssOrder.customer_email && ssOrder.amount_paid != null && ssOrder.order_date) {
    const orderDate = new Date(ssOrder.order_date);
    if (!Number.isNaN(orderDate.getTime())) {
      const lo = new Date(orderDate.getTime() - 7 * 86400000).toISOString();
      const hi = new Date(orderDate.getTime() + 7 * 86400000).toISOString();
      const { data: candidates } = await supabase
        .from("warehouse_orders")
        .select("id, order_number, bandcamp_payment_id, total_price")
        .eq("workspace_id", ssOrder.workspace_id)
        .eq("source", "bandcamp")
        .eq("customer_email", ssOrder.customer_email)
        .gte("created_at", lo)
        .lte("created_at", hi);
      const exact = (candidates ?? []).find(
        (c) => Math.abs(Number(c.total_price ?? 0) - Number(ssOrder.amount_paid)) < 0.01,
      );
      if (exact) {
        return {
          matched_warehouse_order_id: exact.id,
          bandcamp_payment_id: exact.bandcamp_payment_id ?? null,
          order_number: exact.order_number ?? null,
          confidence: "medium",
          matched_via: "customer_email + total_price within 7d",
        };
      }
    }
  }

  // ── Tier 3: ship-to name + city ──────────────────────────────────────────
  const shipTo = (ssOrder.ship_to ?? {}) as Record<string, unknown>;
  const shipName = typeof shipTo.name === "string" ? shipTo.name.trim().toLowerCase() : null;
  const shipCity = typeof shipTo.city === "string" ? shipTo.city.trim().toLowerCase() : null;
  if (shipName && shipCity) {
    const { data: candidates } = await supabase
      .from("warehouse_orders")
      .select("id, order_number, bandcamp_payment_id, customer_name, shipping_address")
      .eq("workspace_id", ssOrder.workspace_id)
      .eq("source", "bandcamp")
      .ilike("customer_name", `%${shipName.split(" ")[0]}%`)
      .limit(20);
    const match = (candidates ?? []).find((c) => {
      const addr = (c.shipping_address ?? {}) as Record<string, unknown>;
      const city = typeof addr.city === "string" ? addr.city.trim().toLowerCase() : null;
      const name =
        typeof c.customer_name === "string" ? c.customer_name.trim().toLowerCase() : null;
      return city === shipCity && name?.includes(shipName.split(" ")[0] ?? "");
    });
    if (match) {
      return {
        matched_warehouse_order_id: match.id,
        bandcamp_payment_id: match.bandcamp_payment_id ?? null,
        order_number: match.order_number ?? null,
        confidence: "low",
        matched_via: "ship_to.name first-token + city",
      };
    }
  }

  return {
    matched_warehouse_order_id: null,
    bandcamp_payment_id: null,
    order_number: null,
    confidence: "none",
    matched_via: "no_candidate_found",
  };
}

// Phase 6.1 — `parsePaymentIdFromCustomField` lives in
// `src/lib/shared/bandcamp-reconcile-helpers.ts` because Server Action files
// can't export sync functions.

// ── Phase 11.2 — Bandcamp enrichment for cockpit drawer ────────────────────

export interface BandcampEnrichmentForCockpit {
  buyer_note: string | null;
  ship_notes: string | null;
  additional_fan_contribution: number | null;
  payment_state: string | null;
  paypal_transaction_id: string | null;
  primary_artist: string | null;
  /** True when ANY enrichment was found. UI uses to gate panel rendering. */
  has_data: boolean;
}

/**
 * Phase 11.2 — load BC enrichment fields for one SS order. Drawer calls this
 * lazily when the row is expanded; result is cached at the SESSION tier so
 * subsequent re-opens are free.
 *
 * Resolves the BC payment_id via:
 *   1. SS advanced_options.customField1 parser (high-confidence match), then
 *   2. The Phase 6.1 reconciliation matcher (email+total or name+city) as
 *      fallback for orders that don't carry the BC id in customField1.
 *
 * Returns has_data=false when no BC payment_id can be resolved — the drawer
 * just doesn't render the Payment panel in that case.
 */
export async function getBandcampEnrichmentForCockpit(input: {
  shipstationOrderUuid: string;
}): Promise<BandcampEnrichmentForCockpit> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: order } = await supabase
    .from("shipstation_orders")
    .select("workspace_id, advanced_options")
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();
  if (!order) {
    return emptyEnrichment();
  }

  // 1) Try customField1 (cheap, exact).
  const adv = (order.advanced_options ?? {}) as Record<string, unknown>;
  const cf1 = typeof adv.customField1 === "string" ? adv.customField1 : null;
  let paymentId = parsePaymentIdFromCustomField(cf1);

  // 2) Fall back to the Phase 6.1 matcher when no customField1 hit.
  if (!paymentId) {
    const reconcile = await getBandcampMatchForShipStationOrder({
      shipstationOrderUuid: input.shipstationOrderUuid,
    });
    paymentId = reconcile.bandcamp_payment_id ?? null;
  }
  if (!paymentId) return emptyEnrichment();

  const { data: salesRows } = await supabase
    .from("bandcamp_sales")
    .select(
      "artist, buyer_note, ship_notes, additional_fan_contribution, payment_state, paypal_transaction_id",
    )
    .eq("workspace_id", order.workspace_id)
    .eq("bandcamp_transaction_id", paymentId);

  if (!salesRows || salesRows.length === 0) return emptyEnrichment();

  // Take the first non-null per field (payment-level fields are identical
  // across rows for the same transaction).
  const first = (key: keyof (typeof salesRows)[number]): unknown => {
    for (const r of salesRows) {
      const v = r[key];
      if (v != null && v !== "") return v;
    }
    return null;
  };

  // Most-frequent artist for the order header.
  const artistTally = new Map<string, number>();
  for (const r of salesRows) {
    if (typeof r.artist === "string" && r.artist.length > 0) {
      artistTally.set(r.artist, (artistTally.get(r.artist) ?? 0) + 1);
    }
  }
  let primaryArtist: string | null = null;
  let maxCount = 0;
  for (const [artist, count] of artistTally) {
    if (count > maxCount) {
      primaryArtist = artist;
      maxCount = count;
    }
  }

  return {
    buyer_note: (first("buyer_note") as string | null) ?? null,
    ship_notes: (first("ship_notes") as string | null) ?? null,
    additional_fan_contribution: (first("additional_fan_contribution") as number | null) ?? null,
    payment_state: (first("payment_state") as string | null) ?? null,
    paypal_transaction_id: (first("paypal_transaction_id") as string | null) ?? null,
    primary_artist: primaryArtist,
    has_data: true,
  };
}

function emptyEnrichment(): BandcampEnrichmentForCockpit {
  return {
    buyer_note: null,
    ship_notes: null,
    additional_fan_contribution: null,
    payment_state: null,
    paypal_transaction_id: null,
    primary_artist: null,
    has_data: false,
  };
}

// ── Phase 8 polish — Retry write-back ───────────────────────────────────────

/**
 * Phase 8 polish — re-fire shipstation-mark-shipped for the most recent
 * shipment with a writeback error on this order. Surfaces in the cockpit's
 * writeback error banner.
 */
export async function retryShipStationWriteback(input: {
  shipstationOrderUuid: string;
}): Promise<{ ok: true; runId: string | null; warehouseShipmentId: string | null }> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  // Most recent open writeback failure for this order.
  const { data: order } = await supabase
    .from("shipstation_orders")
    .select("workspace_id, shipstation_order_id")
    .eq("id", input.shipstationOrderUuid)
    .maybeSingle();
  if (!order) throw new Error("retryShipStationWriteback: order not found");

  const { data: shipment } = await supabase
    .from("warehouse_shipments")
    .select("id")
    .eq("workspace_id", order.workspace_id)
    .eq("shipstation_order_id", String(order.shipstation_order_id))
    .not("shipstation_writeback_error", "is", null)
    .is("shipstation_marked_shipped_at", null)
    .order("ship_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!shipment) {
    return { ok: true, runId: null, warehouseShipmentId: null };
  }

  const run = await tasks.trigger("shipstation-mark-shipped", {
    warehouse_shipment_id: shipment.id,
  });
  return { ok: true, runId: run.id, warehouseShipmentId: shipment.id };
}
