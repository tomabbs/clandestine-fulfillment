"use server";

/**
 * Order Pages Transition Phase 3 — Direct Orders staff read model.
 *
 * Phase 3 deliverable: a staff-gated read surface over `warehouse_orders`
 * with explicit DTOs, scoped query keys, indexed search, hydrated
 * items / shipments / tracking events / mirror links / writeback
 * status.
 *
 * Design notes:
 *   - The existing `getOrders()` in `src/actions/orders.ts` has NO auth
 *     check (intentionally — it's used by some staff surfaces today).
 *     The plan's verification log explicitly calls out NOT modifying
 *     `getOrders()` here; instead, staff-only callers move to
 *     `getStaffOrders` / `getStaffOrderDetail` which add `requireStaff()`
 *     and a workspace_id filter.
 *   - DTOs are explicit, no `*` selects. The Phase 1 trigram indexes
 *     (`idx_warehouse_orders_*_trgm`) are exercised here for ILIKE search
 *     across `order_number`, `customer_email`, and `external_order_id`.
 *   - Mirror-link hydration uses the bridge table from Phase 2; it is
 *     STRICTLY one fan-out join, never embedded into the list query
 *     (the row count is unbounded).
 */

import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface DirectOrderDTO {
  id: string;
  workspaceId: string;
  orgId: string | null;
  orgName: string | null;
  connectionId: string | null;
  externalOrderId: string | null;
  orderNumber: string | null;
  source: string | null;
  customerName: string | null;
  customerEmail: string | null;
  totalPrice: number | null;
  currency: string | null;
  fulfillmentStatus: string | null;
  financialStatus: string | null;
  isPreorder: boolean | null;
  streetDate: string | null;
  fulfillmentHold: string | null;
  identityResolutionStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface DirectOrderListResult {
  orders: DirectOrderDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DirectOrderDetailDTO extends DirectOrderDTO {
  items: Array<{
    id: string;
    sku: string | null;
    title: string | null;
    quantity: number;
    price: number | null;
  }>;
  shipments: Array<{
    id: string;
    trackingNumber: string | null;
    carrier: string | null;
    status: string | null;
    shipDate: string | null;
    labelSource: string | null;
    easypostTrackerStatus: string | null;
  }>;
  trackingEvents: Array<{
    id: string;
    shipmentId: string;
    status: string;
    description: string | null;
    location: string | null;
    eventTime: string | null;
    trackingSource: string;
  }>;
  mirrorLinks: Array<{
    id: string;
    shipstationOrderId: string;
    confidence: string;
    matchSignals: Record<string, unknown>;
  }>;
  writebacks: Array<{
    id: string;
    platform: string;
    status: string;
    shipmentId: string | null;
    externalOrderId: string | null;
    attemptCount: number;
    lastAttemptAt: string | null;
    errorMessage: string | null;
    lines: Array<{
      id: string;
      warehouseOrderItemId: string;
      quantityFulfilled: number;
      status: string;
      errorMessage: string | null;
    }>;
  }>;
  identityResolutionNotes: Record<string, unknown>;
}

export interface StaffOrderListFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  source?: string;
  identityResolutionStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  isPreorder?: boolean;
  fulfillmentHold?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

export async function getStaffOrders(
  filters: StaffOrderListFilters,
): Promise<DirectOrderListResult> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("warehouse_orders")
    .select(
      "id, workspace_id, org_id, organizations(name), connection_id, external_order_id, order_number, source, customer_name, customer_email, total_price, currency, fulfillment_status, financial_status, is_preorder, street_date, fulfillment_hold, identity_resolution_status, created_at, updated_at",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters.status) query = query.eq("fulfillment_status", filters.status);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.identityResolutionStatus) {
    query = query.eq("identity_resolution_status", filters.identityResolutionStatus);
  }
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom);
  if (filters.dateTo) query = query.lte("created_at", filters.dateTo);
  if (filters.isPreorder !== undefined) query = query.eq("is_preorder", filters.isPreorder);
  if (filters.fulfillmentHold) query = query.eq("fulfillment_hold", filters.fulfillmentHold);
  if (filters.search) {
    const term = filters.search.replace(/%/g, "");
    if (term.length > 0) {
      const like = `%${term}%`;
      query = query.or(
        `order_number.ilike.${like},customer_email.ilike.${like},external_order_id.ilike.${like}`,
      );
    }
  }

  const { data, count, error } = await query;
  if (error) {
    throw new Error(`getStaffOrders failed: ${error.message}`);
  }

  return {
    orders: (data ?? []).map(toDirectOrderDTO),
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function getStaffOrderDetail(orderId: string): Promise<DirectOrderDetailDTO> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: order, error: orderErr } = await supabase
    .from("warehouse_orders")
    .select(
      "id, workspace_id, org_id, organizations(name), connection_id, external_order_id, order_number, source, customer_name, customer_email, total_price, currency, fulfillment_status, financial_status, is_preorder, street_date, fulfillment_hold, identity_resolution_status, identity_resolution_notes, line_items, created_at, updated_at",
    )
    .eq("id", orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (orderErr || !order) {
    throw new Error(`Order not found: ${orderErr?.message ?? "no row"}`);
  }

  const [itemsResult, shipmentsResult, mirrorLinksResult, writebacksResult] = await Promise.all([
    supabase
      .from("warehouse_order_items")
      .select("id, sku, title, quantity, price")
      .eq("order_id", orderId),
    supabase
      .from("warehouse_shipments")
      .select(
        "id, tracking_number, carrier, status, ship_date, label_source, easypost_tracker_status",
      )
      .eq("order_id", orderId),
    supabase
      .from("order_mirror_links")
      .select("id, shipstation_order_id, confidence, match_signals")
      .eq("warehouse_order_id", orderId)
      .neq("confidence", "rejected"),
    supabase
      .from("platform_fulfillment_writebacks")
      .select(
        "id, platform, status, shipment_id, external_order_id, attempt_count, last_attempt_at, error_message, platform_fulfillment_writeback_lines(id, warehouse_order_item_id, quantity_fulfilled, status, error_message)",
      )
      .eq("warehouse_order_id", orderId),
  ]);

  const items = itemsResult.data ?? [];
  const shipments = shipmentsResult.data ?? [];
  const mirrorLinks = mirrorLinksResult.data ?? [];
  const writebackRows = writebacksResult.data ?? [];

  const lineItemsJson =
    ((order as { line_items: unknown }).line_items as Array<{
      sku?: string;
      title?: string;
      quantity?: number;
      price?: number;
    }> | null) ?? [];
  const resolvedItems =
    items.length > 0
      ? items.map((i) => ({
          id: (i as { id: string }).id,
          sku: (i as { sku: string | null }).sku ?? null,
          title: (i as { title: string | null }).title ?? null,
          quantity: (i as { quantity: number }).quantity ?? 0,
          price: (i as { price: number | null }).price ?? null,
        }))
      : lineItemsJson.map((li, i) => ({
          id: `jsonb-${i}`,
          sku: li.sku ?? null,
          title: li.title ?? null,
          quantity: li.quantity ?? 1,
          price: li.price ?? null,
        }));

  // Tracking events fan out from shipments, capped to keep the response small.
  let trackingEvents: DirectOrderDetailDTO["trackingEvents"] = [];
  if (shipments.length > 0) {
    const shipmentIds = shipments.map((s) => (s as { id: string }).id);
    const { data: events, error: eventsErr } = await supabase
      .from("warehouse_tracking_events")
      .select("id, shipment_id, status, description, location, event_time, tracking_source")
      .in("shipment_id", shipmentIds)
      .order("event_time", { ascending: false })
      .limit(200);
    if (!eventsErr) {
      trackingEvents = (events ?? []).map((e) => ({
        id: (e as { id: string }).id,
        shipmentId: (e as { shipment_id: string }).shipment_id,
        status: (e as { status: string }).status,
        description: (e as { description: string | null }).description ?? null,
        location: (e as { location: string | null }).location ?? null,
        eventTime: (e as { event_time: string | null }).event_time ?? null,
        trackingSource: (e as { tracking_source: string }).tracking_source ?? "unknown",
      }));
    }
  }

  const baseDto = toDirectOrderDTO(order);
  return {
    ...baseDto,
    items: resolvedItems,
    shipments: shipments.map((s) => ({
      id: (s as { id: string }).id,
      trackingNumber: (s as { tracking_number: string | null }).tracking_number ?? null,
      carrier: (s as { carrier: string | null }).carrier ?? null,
      status: (s as { status: string | null }).status ?? null,
      shipDate: (s as { ship_date: string | null }).ship_date ?? null,
      labelSource: (s as { label_source: string | null }).label_source ?? null,
      easypostTrackerStatus:
        (s as { easypost_tracker_status: string | null }).easypost_tracker_status ?? null,
    })),
    trackingEvents,
    mirrorLinks: mirrorLinks.map((l) => ({
      id: (l as { id: string }).id,
      shipstationOrderId: (l as { shipstation_order_id: string }).shipstation_order_id,
      confidence: (l as { confidence: string }).confidence,
      matchSignals: ((l as { match_signals: Record<string, unknown> }).match_signals ??
        {}) as Record<string, unknown>,
    })),
    writebacks: writebackRows.map((w) => {
      const row = w as {
        id: string;
        platform: string;
        status: string;
        shipment_id: string | null;
        external_order_id: string | null;
        attempt_count: number | null;
        last_attempt_at: string | null;
        error_message: string | null;
        platform_fulfillment_writeback_lines: Array<{
          id: string;
          warehouse_order_item_id: string;
          quantity_fulfilled: number;
          status: string;
          error_message: string | null;
        }> | null;
      };
      return {
        id: row.id,
        platform: row.platform,
        status: row.status,
        shipmentId: row.shipment_id ?? null,
        externalOrderId: row.external_order_id ?? null,
        attemptCount: row.attempt_count ?? 0,
        lastAttemptAt: row.last_attempt_at ?? null,
        errorMessage: row.error_message ?? null,
        lines: (row.platform_fulfillment_writeback_lines ?? []).map((ln) => ({
          id: ln.id,
          warehouseOrderItemId: ln.warehouse_order_item_id,
          quantityFulfilled: ln.quantity_fulfilled,
          status: ln.status,
          errorMessage: ln.error_message ?? null,
        })),
      };
    }),
    identityResolutionNotes: ((order as { identity_resolution_notes: Record<string, unknown> })
      .identity_resolution_notes ?? {}) as Record<string, unknown>,
  };
}

function toDirectOrderDTO(row: unknown): DirectOrderDTO {
  const r = row as {
    id: string;
    workspace_id: string;
    org_id: string | null;
    organizations: { name: string } | { name: string }[] | null;
    connection_id: string | null;
    external_order_id: string | null;
    order_number: string | null;
    source: string | null;
    customer_name: string | null;
    customer_email: string | null;
    total_price: number | null;
    currency: string | null;
    fulfillment_status: string | null;
    financial_status: string | null;
    is_preorder: boolean | null;
    street_date: string | null;
    fulfillment_hold: string | null;
    identity_resolution_status: string;
    created_at: string;
    updated_at: string;
  };
  const orgNameSource = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    orgId: r.org_id ?? null,
    orgName: orgNameSource?.name ?? null,
    connectionId: r.connection_id ?? null,
    externalOrderId: r.external_order_id ?? null,
    orderNumber: r.order_number ?? null,
    source: r.source ?? null,
    customerName: r.customer_name ?? null,
    customerEmail: r.customer_email ?? null,
    totalPrice: r.total_price ?? null,
    currency: r.currency ?? null,
    fulfillmentStatus: r.fulfillment_status ?? null,
    financialStatus: r.financial_status ?? null,
    isPreorder: r.is_preorder ?? null,
    streetDate: r.street_date ?? null,
    fulfillmentHold: r.fulfillment_hold ?? null,
    identityResolutionStatus: r.identity_resolution_status ?? "unresolved",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
