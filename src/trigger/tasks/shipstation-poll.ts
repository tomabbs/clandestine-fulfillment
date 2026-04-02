// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
// Backup poller: runs every 30 min to catch missed webhooks

import { logger, schedules } from "@trigger.dev/sdk";
import { fetchOrders, fetchShipments, type ShipStationShipment } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";

export const shipstationPollTask = schedules.task({
  id: "shipstation-poll",
  queue: shipstationQueue,
  maxDuration: 600,
  cron: "*/30 * * * *",
  run: async () => {
    const supabase = createServiceRoleClient();

    const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
    if (!workspace) throw new Error("No workspace found");
    const workspaceId = workspace.id;

    const { data: syncState } = await supabase
      .from("warehouse_sync_state")
      .select("*")
      .eq("sync_type", "shipstation_poll")
      .maybeSingle();

    const LOOKBACK_DAYS = 30;
    const thirtyDaysAgo = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // ── Pre-fetch ShipStation orders for shippingAmount ──────────────────────
    // Build orderNumber → shippingAmount map before iterating shipments.
    // modifyDateStart aligned to same 30-day window (orders get modified when shipped).
    // One API call regardless of shipment count — avoids N+1 pattern.
    // Keys are normalized (lowercased + trimmed) for consistent lookup.
    const ssOrderShippingMap = new Map<string, number>();
    try {
      const ordersResult = await fetchOrders({
        modifyDateStart: thirtyDaysAgo,
        orderStatus: "shipped",
        pageSize: 500,
      });
      for (const order of ordersResult.orders) {
        if (order.orderNumber && order.shippingAmount != null) {
          ssOrderShippingMap.set(order.orderNumber.toLowerCase().trim(), order.shippingAmount);
        }
      }
      if (ordersResult.pages > 1) {
        for (let p = 2; p <= ordersResult.pages; p++) {
          const page = await fetchOrders({
            modifyDateStart: thirtyDaysAgo,
            orderStatus: "shipped",
            pageSize: 500,
            page: p,
          });
          for (const order of page.orders) {
            if (order.orderNumber && order.shippingAmount != null) {
              ssOrderShippingMap.set(order.orderNumber.toLowerCase().trim(), order.shippingAmount);
            }
          }
        }
      }
      logger.info("Pre-fetched ShipStation order shipping amounts", {
        orderCount: ssOrderShippingMap.size,
      });
    } catch (err) {
      logger.warn("Failed to pre-fetch ShipStation orders for shipping amounts", {
        error: String(err),
      });
      // Non-fatal — customer_shipping_charged will be null for this poll cycle
    }

    // ── Fetch and ingest shipments ───────────────────────────────────────────
    let page = 1;
    let totalProcessed = 0;
    let hasMore = true;

    logger.info("Starting ShipStation poll", { shipDateStart: thirtyDaysAgo, workspaceId });

    while (hasMore) {
      const result = await fetchShipments({
        shipDateStart: thirtyDaysAgo,
        page,
        pageSize: 100,
        sortBy: "ShipDate",
        sortDir: "ASC",
        includeShipmentItems: true,
      });

      logger.info("Fetched shipments page", {
        page,
        total: result.total,
        pages: result.pages,
        count: result.shipments.length,
      });

      for (const shipment of result.shipments) {
        await ingestFromPoll(supabase, shipment, workspaceId, ssOrderShippingMap);
        totalProcessed++;
      }

      hasMore = page < result.pages;
      page++;
    }

    // ── Update sync cursor ───────────────────────────────────────────────────
    const now = new Date().toISOString();
    if (syncState) {
      await supabase
        .from("warehouse_sync_state")
        .update({
          last_sync_cursor: now,
          last_sync_wall_clock: now,
          metadata: { last_poll_processed: totalProcessed },
        })
        .eq("id", syncState.id);
    } else {
      await supabase.from("warehouse_sync_state").insert({
        workspace_id: workspaceId,
        sync_type: "shipstation_poll",
        last_sync_cursor: now,
        last_sync_wall_clock: now,
        metadata: { last_poll_processed: totalProcessed },
      });
    }

    return { processed: totalProcessed };
  },
});

async function ingestFromPoll(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: ShipStationShipment,
  workspaceId: string,
  ssOrderShippingMap: Map<string, number>,
) {
  const shipstationShipmentId = String(shipment.shipmentId);
  const storeId = shipment.advancedOptions?.storeId ?? shipment.storeId;
  const itemsRaw = shipment.shipmentItems ?? [];
  const itemSkus = itemsRaw.map((i) => i.sku).filter(Boolean) as string[];

  // Org matching (3-tier fallback)
  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);
  if (!orgMatch) {
    logger.warn(`Unmatched shipment ${shipstationShipmentId} (poller)`);
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        category: "shipment_org_match",
        severity: "medium" as const,
        title: `Unmatched shipment: ${shipment.trackingNumber ?? shipstationShipmentId}`,
        description: `ShipStation shipment ${shipstationShipmentId} from store ${storeId ?? "unknown"} could not be matched via store mapping or SKU matching.`,
        metadata: {
          shipstation_shipment_id: shipstationShipmentId,
          store_id: storeId,
          tracking_number: shipment.trackingNumber,
          item_skus: itemSkus,
          source: "poller",
        },
        status: "open" as const,
        group_key: `shipment_org_match:${shipstationShipmentId}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
    return;
  }

  const totalUnits = itemsRaw.reduce((sum, item) => sum + (item.quantity ?? 1), 0);

  // Shipping amount from pre-fetched map (normalized key)
  const ssShippingCharged = shipment.orderNumber
    ? (ssOrderShippingMap.get(shipment.orderNumber.toLowerCase().trim()) ?? null)
    : null;

  // ── Two-step upsert protecting immutable fields ──────────────────────────
  // org_id and order_id are NEVER overwritten by re-ingest — once set manually
  // or by auto-link, subsequent polls preserve those values.
  //
  // Step A: Insert if new (ignoreDuplicates: true = do nothing on conflict)
  const { data: insertedRow } = await supabase
    .from("warehouse_shipments")
    .upsert(
      {
        workspace_id: workspaceId,
        shipstation_shipment_id: shipstationShipmentId,
        org_id: orgMatch.orgId,
        tracking_number: shipment.trackingNumber ?? null,
        carrier: shipment.carrierCode ?? null,
        service: shipment.serviceCode ?? null,
        ship_date: shipment.shipDate ?? null,
        delivery_date: shipment.deliveryDate ?? null,
        status: shipment.voided ? "voided" : "shipped",
        shipping_cost: shipment.shipmentCost ?? null,
        weight: shipment.weight?.value ?? null,
        dimensions: shipment.dimensions ?? null,
        label_data: shipment.shipTo ? { shipTo: shipment.shipTo } : null,
        voided: shipment.voided ?? false,
        billed: false,
        total_units: totalUnits,
        ss_order_number: shipment.orderNumber ?? null,
        ss_create_date: shipment.createDate ?? null,
        label_source: "shipstation",
        customer_shipping_charged: ssShippingCharged,
      },
      {
        onConflict: "workspace_id,shipstation_shipment_id",
        ignoreDuplicates: true,
      },
    )
    .select("id, order_id")
    .maybeSingle();

  // Step B: If row already existed, fetch it then update only mutable fields
  let upsertedId: string;
  let existingOrderId: string | null;

  if (insertedRow) {
    upsertedId = insertedRow.id;
    existingOrderId = insertedRow.order_id;
  } else {
    const { data: existing } = await supabase
      .from("warehouse_shipments")
      .select("id, order_id")
      .eq("workspace_id", workspaceId)
      .eq("shipstation_shipment_id", shipstationShipmentId)
      .single();

    if (!existing) {
      logger.error(`Failed to find or create shipment ${shipstationShipmentId}`);
      return;
    }
    upsertedId = existing.id;
    existingOrderId = existing.order_id;

    // Step C: Update mutable tracking fields only (org_id and order_id excluded)
    await supabase
      .from("warehouse_shipments")
      .update({
        tracking_number: shipment.trackingNumber ?? null,
        carrier: shipment.carrierCode ?? null,
        service: shipment.serviceCode ?? null,
        ship_date: shipment.shipDate ?? null,
        delivery_date: shipment.deliveryDate ?? null,
        status: shipment.voided ? "voided" : "shipped",
        shipping_cost: shipment.shipmentCost ?? null,
        weight: shipment.weight?.value ?? null,
        dimensions: shipment.dimensions ?? null,
        label_data: shipment.shipTo ? { shipTo: shipment.shipTo } : null,
        voided: shipment.voided ?? false,
        total_units: totalUnits,
        ss_order_number: shipment.orderNumber ?? null,
        ss_create_date: shipment.createDate ?? null,
        label_source: "shipstation",
        customer_shipping_charged: ssShippingCharged,
      })
      .eq("id", upsertedId);
  }

  // upsertedId is guaranteed set — both branches above return early on failure.
  const upserted = { id: upsertedId, order_id: existingOrderId };

  // ── Items: upsert by (shipment_id, sku, item_index) ──────────────────────
  // item_index allows the same SKU to appear twice in one shipment.
  // Ghost-item pruning: delete rows at indices >= new payload length to handle
  // cases where staff reduced a shipment's items in ShipStation.
  if (itemsRaw.length > 0) {
    const itemRows = itemsRaw.map((item, idx) => ({
      shipment_id: upserted.id,
      workspace_id: workspaceId,
      sku: item.sku ?? "UNKNOWN",
      quantity: item.quantity,
      product_title: item.name ?? null,
      variant_title: null,
      item_index: idx,
    }));

    const { error: itemsError } = await supabase
      .from("warehouse_shipment_items")
      .upsert(itemRows, {
        onConflict: "shipment_id,sku,item_index",
        ignoreDuplicates: false,
      });

    if (itemsError) {
      logger.error(`Failed to upsert items for shipment ${shipstationShipmentId}`, {
        error: itemsError.message,
        count: itemRows.length,
      });
    } else {
      // Prune ghost items left behind when payload was reduced (e.g. 3 items → 1)
      await supabase
        .from("warehouse_shipment_items")
        .delete()
        .eq("shipment_id", upserted.id)
        .gte("item_index", itemsRaw.length);
    }
  }

  // ── Auto-link to warehouse_orders (two-phase matching) ───────────────────
  if (!upserted.order_id) {
    const linkedOrderId = await matchShipmentToOrder(
      supabase,
      workspaceId,
      shipment,
      upserted.id,
      itemSkus,
    );
    if (linkedOrderId) {
      // Fetch linked order to get authoritative shipping cost and source
      const { data: linkedOrder } = await supabase
        .from("warehouse_orders")
        .select("shipping_cost, fulfillment_status, source")
        .eq("id", linkedOrderId)
        .single();

      // Prefer Bandcamp's shipping_cost over ShipStation's shippingAmount
      const authoritativeShippingCharged =
        linkedOrder?.shipping_cost != null
          ? Number(linkedOrder.shipping_cost)
          : ssShippingCharged;

      await supabase
        .from("warehouse_shipments")
        .update({
          order_id: linkedOrderId,
          ...(authoritativeShippingCharged != null && {
            customer_shipping_charged: authoritativeShippingCharged,
          }),
        })
        .eq("id", upserted.id);

      // Only auto-mark fulfilled for non-Bandcamp orders.
      // Bandcamp orders must be marked fulfilled via the Bandcamp API ("Mark Shipped
      // on Bandcamp"). Auto-updating here would cause bandcamp-order-sync to overwrite
      // our local status back to "unfulfilled" on the next run.
      if (
        linkedOrder &&
        linkedOrder.source !== "bandcamp" &&
        ["unfulfilled", "pending", null].includes(linkedOrder.fulfillment_status)
      ) {
        await supabase
          .from("warehouse_orders")
          .update({ fulfillment_status: "fulfilled", updated_at: new Date().toISOString() })
          .eq("id", linkedOrderId);
      }

      logger.info(`Auto-linked shipment ${shipstationShipmentId} → order ${linkedOrderId}`);
    }
  }

  logger.info(
    `Ingested shipment ${shipstationShipmentId}: org=${orgMatch.orgId}, items=${itemsRaw.length}, linked=${!!upserted.order_id}`,
  );
}

// ─── Order number normalization ───────────────────────────────────────────────
// Strips BC- prefix, lowercases, removes all non-alphanumeric chars so
// "BC-12345678" == "bc 12345678" == "12345678" all map to "12345678".
function normalizeOrderNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return (
    raw
      .toLowerCase()
      .replace(/^(bc|bandcamp)[-\s]*/i, "")
      .replace(/[^a-z0-9]/g, "")
      .trim() || null
  );
}

// ─── Two-phase order matching ─────────────────────────────────────────────────
// PHASE 1 (deterministic): exact normalized order number → auto-link.
// PHASE 2 (probabilistic): multi-signal scoring → review queue ONLY, no auto-assign.
// A missing link is safer than a wrong link for billing/audit workflows.
async function matchShipmentToOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  shipment: ShipStationShipment,
  shipmentDbId: string,
  itemSkus: string[],
): Promise<string | null> {
  const postalCode = shipment.shipTo?.postalCode ?? null;
  const recipientName = (shipment.shipTo?.name ?? "").toLowerCase().trim();
  const shipDate = shipment.shipDate ? new Date(shipment.shipDate) : null;
  const normalizedSsOrderNumber = normalizeOrderNumber(shipment.orderNumber);
  // Exclude "UNKNOWN" sentinel — matching on it would score all null-SKU shipments
  // as matching each other and pollute the SKU-overlap signal.
  const matchableItemSkus = itemSkus.filter((sku) => sku !== "UNKNOWN");

  // ── Phase 1: Deterministic exact match ───────────────────────────────────
  if (normalizedSsOrderNumber) {
    const { data: candidates } = await supabase
      .from("warehouse_orders")
      .select("id, order_number")
      .eq("workspace_id", workspaceId)
      .ilike("order_number", `%${normalizedSsOrderNumber}%`)
      .limit(5);

    if (candidates?.length) {
      const exactMatch = candidates.find(
        (o) => normalizeOrderNumber(o.order_number) === normalizedSsOrderNumber,
      );
      if (exactMatch) {
        logger.info(
          `Exact order number match: shipment ${shipmentDbId} → order ${exactMatch.id}`,
        );
        supabase
          .from("channel_sync_log")
          .insert({
            workspace_id: workspaceId,
            channel: "shipstation",
            sync_type: "order_auto_link",
            status: "completed",
            items_processed: 1,
            items_failed: 0,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          })
          .then(() => {}, () => {}); // fire-and-forget, non-critical
        return exactMatch.id;
      }
    }
  }

  // ── Phase 2: Probabilistic scoring → review queue only ───────────────────
  const windowStart = shipDate
    ? new Date(shipDate.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  let candidateQuery = supabase
    .from("warehouse_orders")
    .select("id, order_number, customer_name, shipping_address, line_items, created_at")
    .eq("workspace_id", workspaceId);

  if (postalCode) {
    candidateQuery = candidateQuery.eq("shipping_address->>postalCode", postalCode);
  }
  if (windowStart && shipDate) {
    candidateQuery = candidateQuery
      .gte("created_at", windowStart)
      .lte("created_at", shipDate.toISOString());
  }

  const { data: candidates } = await candidateQuery.limit(20);
  if (!candidates?.length) return null;

  interface ScoredCandidate {
    id: string;
    score: number;
    signals: string[];
  }
  const scored: ScoredCandidate[] = [];

  for (const order of candidates) {
    let score = 0;
    const signals: string[] = [];

    const addrPostal = (
      order.shipping_address as Record<string, string> | null
    )?.postalCode;
    if (postalCode && addrPostal === postalCode) {
      score += 30;
      signals.push("postal_code");
    }

    const orderSkus = ((order.line_items ?? []) as Array<{ sku?: string }>)
      .map((li) => li.sku)
      .filter((sku): sku is string => Boolean(sku) && sku !== "UNKNOWN");
    const skuMatches = matchableItemSkus.filter((sku) => orderSkus.includes(sku)).length;
    if (skuMatches > 0) {
      score += 40 + Math.min(skuMatches - 1, 3) * 5;
      signals.push(`sku_match(${skuMatches})`);
    }

    const orderName = (order.customer_name ?? "").toLowerCase().trim();
    if (
      recipientName &&
      orderName &&
      (orderName.includes(recipientName) || recipientName.includes(orderName))
    ) {
      score += 20;
      signals.push("name_match");
    }

    if (shipDate && order.created_at) {
      const daysDiff =
        (shipDate.getTime() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff >= 0 && daysDiff <= 14) {
        score += 10;
        signals.push("date_close");
      } else if (daysDiff > 14 && daysDiff <= 30) {
        score += 5;
        signals.push("date_ok");
      }
    }

    if (score >= 50) scored.push({ id: order.id, score, signals });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;

  await supabase
    .from("warehouse_review_queue")
    .upsert(
      {
        workspace_id: workspaceId,
        category: "shipment_order_match",
        severity: scored[0].score >= 80 ? ("medium" as const) : ("low" as const),
        title: `Probable order match for shipment — needs confirmation`,
        description:
          `Shipment ${shipmentDbId} (SS order: ${shipment.orderNumber ?? "unknown"}) ` +
          `scored ${scored[0].score} against order ${scored[0].id}. ` +
          `Signals: ${scored[0].signals.join(", ")}. ` +
          `Set order_id on warehouse_shipments to confirm.`,
        metadata: {
          shipment_id: shipmentDbId,
          ss_order_number: shipment.orderNumber,
          top_candidates: scored.slice(0, 3),
        },
        status: "open" as const,
        group_key: `shipment_order_prob_${shipmentDbId}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: true },
    );

  return null;
}
