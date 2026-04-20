// Phase 1.2 — Pull modified ShipStation orders into the local mirror.
//
// Cron "*/15 * * * *". Pulls orders modified since the cursor in
// warehouse_sync_state(sync_type='shipstation_orders_poll'), upserts them into
// shipstation_orders (+ replaces shipstation_order_items per row).
//
// Phase 1.3 also calls this task with a `windowMinutes` payload to do a
// narrow re-poll triggered by ORDER_NOTIFY webhooks. Both paths share the
// shipstationQueue (concurrencyLimit: 1) so cron + webhook can never
// double-call SS API and burn rate-limit budget.
//
// preorder_state derivation lands in Phase 5.2; this task leaves the column
// at its default 'none' for now.

import { logger, schedules, task } from "@trigger.dev/sdk";
import { fetchOrders, type ShipStationOrder } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  deriveOrderPreorderState,
  type PreorderVariantRecord,
} from "@/lib/shared/order-preorder";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

const SYNC_TYPE = "shipstation_orders_poll";

/** Default lookback for first-ever poll (no cursor yet). */
const FIRST_POLL_LOOKBACK_DAYS = 7;

/** Safety overlap when a cursor exists — re-fetch the last 5 minutes to absorb clock skew between SS and us. */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

interface PollResult {
  upserted: number;
  unmatched: number;
  cursorAdvancedTo: string | null;
}

/**
 * Shared body — invoked by both the cron task and the webhook-triggered
 * window task below so the upsert logic only lives in one place.
 */
async function runPoll(args: {
  workspaceId?: string;
  windowMinutes?: number;
}): Promise<PollResult> {
  const supabase = createServiceRoleClient();

  const { data: workspace } = args.workspaceId
    ? { data: { id: args.workspaceId } }
    : await supabase.from("workspaces").select("id").limit(1).single();
  if (!workspace) throw new Error("No workspace found");
  const workspaceId = workspace.id;

  // Cursor logic: read last_sync_cursor, fall back to FIRST_POLL_LOOKBACK_DAYS.
  // Webhook-triggered runs override with `windowMinutes`.
  const { data: syncState } = await supabase
    .from("warehouse_sync_state")
    .select("id, last_sync_cursor")
    .eq("workspace_id", workspaceId)
    .eq("sync_type", SYNC_TYPE)
    .maybeSingle();

  let modifyDateStart: string;
  if (args.windowMinutes && args.windowMinutes > 0) {
    modifyDateStart = new Date(Date.now() - args.windowMinutes * 60 * 1000).toISOString();
  } else if (syncState?.last_sync_cursor) {
    const cursor = new Date(syncState.last_sync_cursor).getTime();
    // Safety overlap to absorb clock skew between SS and us.
    modifyDateStart = new Date(cursor - CURSOR_OVERLAP_MS).toISOString();
  } else {
    modifyDateStart = new Date(
      Date.now() - FIRST_POLL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
  }

  const runStartedAt = new Date().toISOString();

  logger.info("[shipstation-orders-poll] starting", {
    workspaceId,
    modifyDateStart,
    isWindowedRun: !!args.windowMinutes,
  });

  let page = 1;
  let upserted = 0;
  let unmatched = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await fetchOrders({
      modifyDateStart,
      page,
      pageSize: 250,
      sortBy: "ModifyDate",
      sortDir: "ASC",
      // Pull every status — we need awaiting_payment + awaiting_shipment +
      // shipped + on_hold + cancelled in the cockpit so staff see history.
      orderStatus: "all",
    });

    logger.info("[shipstation-orders-poll] page", {
      page,
      pages: result.pages,
      total: result.total,
      count: result.orders.length,
    });

    for (const ssOrder of result.orders) {
      const ok = await upsertOrder(supabase, workspaceId, ssOrder);
      if (ok === "upserted") upserted++;
      if (ok === "unmatched") unmatched++;
    }

    hasMore = page < result.pages;
    page++;
  }

  // Advance cursor to the moment we STARTED (not the moment we finished) so
  // we don't miss orders modified during the run.
  const cursorAdvancedTo = runStartedAt;
  if (syncState) {
    await supabase
      .from("warehouse_sync_state")
      .update({
        last_sync_cursor: cursorAdvancedTo,
        last_sync_wall_clock: cursorAdvancedTo,
        metadata: { last_poll_upserted: upserted, last_poll_unmatched: unmatched },
        updated_at: cursorAdvancedTo,
      })
      .eq("id", syncState.id);
  } else {
    await supabase.from("warehouse_sync_state").insert({
      workspace_id: workspaceId,
      sync_type: SYNC_TYPE,
      last_sync_cursor: cursorAdvancedTo,
      last_sync_wall_clock: cursorAdvancedTo,
      metadata: { last_poll_upserted: upserted, last_poll_unmatched: unmatched },
    });
  }

  await supabase.from("sensor_readings").insert({
    workspace_id: workspaceId,
    sensor_name: "trigger:shipstation-orders-poll",
    status: unmatched > 0 ? "warning" : "healthy",
    message: `Upserted ${upserted} order(s), ${unmatched} unmatched (no org)`,
  });

  return { upserted, unmatched, cursorAdvancedTo };
}

/**
 * Upsert one SS order + replace its items. Returns:
 *   - "upserted" on success
 *   - "unmatched" when org couldn't be resolved (still upserts with org_id NULL,
 *     surfaces in cockpit "Needs assignment" bucket)
 *   - "skipped" on hard error (logged + sensor)
 */
async function upsertOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  ssOrder: ShipStationOrder,
): Promise<"upserted" | "unmatched" | "skipped"> {
  const storeId = ssOrder.advancedOptions?.storeId ?? ssOrder.storeId ?? null;
  const itemSkus = (ssOrder.items ?? [])
    .map((i) => i.sku)
    .filter((s): s is string => !!s && s !== "UNKNOWN");

  // Reuse 3-tier org matcher. matchShipmentOrg returns null when no org
  // resolves — we still upsert (with org_id NULL) so the cockpit can show
  // the order in a "Needs assignment" bucket rather than silently dropping.
  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);
  const orgId = orgMatch?.orgId ?? null;
  const isUnmatched = orgId == null;

  // Phase 8.5 + 8.6 + 8.8 — denormalize SS-only fields into proper columns.
  const tagIds = (ssOrder.tagIds ?? []).filter((n): n is number => typeof n === "number");
  const holdUntilDate = ssOrder.holdUntilDate ? ssOrder.holdUntilDate.slice(0, 10) : null;
  const shipByDate = ssOrder.shipByDate ? ssOrder.shipByDate.slice(0, 10) : null;
  const deliverByDate = ssOrder.advancedOptions?.deliveryDate
    ? ssOrder.advancedOptions.deliveryDate.slice(0, 10)
    : null;
  const allocationStatus = ssOrder.advancedOptions?.allocationStatus ?? null;

  const { data: upserted, error: upsertErr } = await supabase
    .from("shipstation_orders")
    .upsert(
      {
        workspace_id: workspaceId,
        org_id: orgId,
        shipstation_order_id: ssOrder.orderId,
        order_number: ssOrder.orderNumber,
        order_status: ssOrder.orderStatus,
        order_date: ssOrder.orderDate ?? null,
        customer_email: ssOrder.customerEmail ?? null,
        customer_name: ssOrder.customerUsername ?? null,
        ship_to: ssOrder.shipTo ?? null,
        store_id: storeId,
        amount_paid: ssOrder.amountPaid ?? null,
        shipping_paid: ssOrder.shippingAmount ?? null,
        last_modified: ssOrder.modifyDate ?? null,
        synced_at: new Date().toISOString(),
        advanced_options: ssOrder.advancedOptions ?? {},
        // Phase 8 — extended fields
        tag_ids: tagIds,
        hold_until_date: holdUntilDate,
        ship_by_date: shipByDate,
        deliver_by_date: deliverByDate,
        payment_date: ssOrder.paymentDate ?? null,
        assignee_user_id: ssOrder.userId ?? null,
        allocation_status: allocationStatus,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,shipstation_order_id" },
    )
    .select("id")
    .single();

  if (upsertErr || !upserted) {
    logger.error("[shipstation-orders-poll] order upsert failed", {
      shipstationOrderId: ssOrder.orderId,
      error: upsertErr?.message,
    });
    return "skipped";
  }

  // Replace items wholesale per upsert. Small set per order — simpler than
  // diffing and avoids item_index drift when SS reorders items in the source.
  await supabase.from("shipstation_order_items").delete().eq("shipstation_order_id", upserted.id);

  if (ssOrder.items?.length) {
    const itemRows = ssOrder.items.map((it, idx) => ({
      workspace_id: workspaceId,
      shipstation_order_id: upserted.id,
      sku: it.sku ?? null,
      name: it.name ?? null,
      quantity: it.quantity,
      unit_price: it.unitPrice ?? null,
      item_index: idx,
    }));
    const { error: itemsErr } = await supabase.from("shipstation_order_items").insert(itemRows);
    if (itemsErr) {
      logger.warn("[shipstation-orders-poll] items insert failed (non-fatal)", {
        shipstationOrderId: ssOrder.orderId,
        error: itemsErr.message,
      });
    }
  }

  // ── Phase 5.2 — derive preorder_state from variants ─────────────────────
  // Look up each item's variant and collapse to per-order state. Failure to
  // derive (missing variants, etc.) is non-fatal — the order still upserts;
  // preorder_state stays at the schema default 'none'.
  await applyPreorderState(supabase, workspaceId, upserted.id, ssOrder.items ?? []);

  return isUnmatched ? "unmatched" : "upserted";
}

/**
 * Phase 5.2 — Compute and write preorder_state + preorder_release_date.
 *
 * Exposed for the daily refresh cron in Phase 5.3 — that task re-derives
 * for orders that may have crossed the today+7 boundary, without re-pulling
 * from SS.
 */
export async function applyPreorderState(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  shipstationOrderUuid: string,
  items: Array<{ sku?: string | null }>,
): Promise<{ preorder_state: "none" | "preorder" | "ready"; preorder_release_date: string | null }> {
  const skus = items
    .map((i) => i.sku)
    .filter((s): s is string => !!s && s !== "UNKNOWN");

  let variantRows: PreorderVariantRecord[] = [];
  if (skus.length > 0) {
    const { data } = await supabase
      .from("warehouse_product_variants")
      .select("sku, is_preorder, street_date")
      .eq("workspace_id", workspaceId)
      .in("sku", skus);
    variantRows = (data ?? []) as PreorderVariantRecord[];
  }
  const variantLookup = new Map<string, PreorderVariantRecord>(
    variantRows.map((v) => [v.sku, v]),
  );

  const derived = deriveOrderPreorderState({
    items: items.map((i) => ({ sku: i.sku ?? null })),
    variantLookup,
  });

  const { error: updErr } = await supabase
    .from("shipstation_orders")
    .update({
      preorder_state: derived.preorder_state,
      preorder_release_date: derived.preorder_release_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", shipstationOrderUuid);

  if (updErr) {
    logger.warn("[shipstation-orders-poll] preorder_state update failed (non-fatal)", {
      shipstationOrderUuid,
      error: updErr.message,
    });
  }

  return derived;
}

// ── Cron entry ───────────────────────────────────────────────────────────────

export const shipstationOrdersPollTask = schedules.task({
  id: "shipstation-orders-poll",
  queue: shipstationQueue,
  maxDuration: 600,
  cron: "*/15 * * * *",
  run: async () => runPoll({}),
});

// ── Webhook-triggered narrow window (Phase 1.3) ──────────────────────────────
// ORDER_NOTIFY enqueues this task with a small windowMinutes so we re-poll
// just the affected slice and keep cockpit staleness low without the cost of
// a full cursor-driven run. Same shipstationQueue → cannot run concurrently
// with the cron, so SS rate-limit budget is shared.

export const shipstationOrdersPollWindowTask = task({
  id: "shipstation-orders-poll-window",
  queue: shipstationQueue,
  maxDuration: 300,
  run: async (payload: { workspaceId?: string; windowMinutes?: number } = {}) =>
    runPoll({
      workspaceId: payload.workspaceId,
      windowMinutes: payload.windowMinutes ?? 30,
    }),
});

// Exported for unit testing.
export { runPoll };
