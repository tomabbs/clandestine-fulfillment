// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
// Backup poller: runs every 30 min to catch missed webhooks

import { logger, schedules } from "@trigger.dev/sdk";
import { fetchShipments, type ShipStationShipment } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";

export const shipstationPollTask = schedules.task({
  id: "shipstation-poll",
  queue: shipstationQueue,
  maxDuration: 600, // 10 min — 30-day rolling window can have 400+ shipments
  cron: "*/30 * * * *",
  run: async () => {
    const supabase = createServiceRoleClient();

    // Get workspace ID (single-workspace for now)
    const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
    if (!workspace) throw new Error("No workspace found");
    const workspaceId = workspace.id;

    // Get last poll cursor from sync state
    const { data: syncState } = await supabase
      .from("warehouse_sync_state")
      .select("*")
      .eq("sync_type", "shipstation_poll")
      .maybeSingle();

    // Rolling 30-day window ensures we catch shipments even after webhook outages
    // and allows detecting changes to existing shipments (voided, cost updates).
    // Dedup via shipstation_shipment_id handles the overlap.
    const LOOKBACK_DAYS = 30;
    const shipDateStart = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let page = 1;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let hasMore = true;

    logger.info("Starting ShipStation poll", { shipDateStart, workspaceId });

    while (hasMore) {
      const result = await fetchShipments({
        shipDateStart,
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
        shipmentsOnPage: result.shipments.length,
      });

      for (const shipment of result.shipments) {
        const shipstationShipmentId = String(shipment.shipmentId);

        // Check if already ingested
        const { data: existing } = await supabase
          .from("warehouse_shipments")
          .select("id")
          .eq("shipstation_shipment_id", shipstationShipmentId)
          .maybeSingle();

        if (existing) {
          totalSkipped++;
          continue;
        }

        // Ingest via the same logic as webhook task
        await ingestFromPoll(supabase, shipment, workspaceId);
        totalProcessed++;
      }

      hasMore = page < result.pages;
      page++;
    }

    // Update sync cursor
    const now = new Date().toISOString();
    if (syncState) {
      await supabase
        .from("warehouse_sync_state")
        .update({
          last_sync_cursor: now,
          last_sync_wall_clock: now,
          metadata: { last_poll_processed: totalProcessed, last_poll_skipped: totalSkipped },
        })
        .eq("id", syncState.id);
    } else {
      await supabase.from("warehouse_sync_state").insert({
        workspace_id: workspaceId,
        sync_type: "shipstation_poll",
        last_sync_cursor: now,
        last_sync_wall_clock: now,
        metadata: { last_poll_processed: totalProcessed, last_poll_skipped: totalSkipped },
      });
    }

    return { processed: totalProcessed, skipped: totalSkipped };
  },
});

async function ingestFromPoll(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: ShipStationShipment,
  workspaceId: string,
) {
  const shipstationShipmentId = String(shipment.shipmentId);

  // Match org via 3-tier fallback chain (shared with shipment-ingest)
  const storeId = shipment.advancedOptions?.storeId ?? shipment.storeId;
  const itemSkus = (shipment.shipmentItems ?? []).map((i) => i.sku).filter(Boolean) as string[];

  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);

  // If all tiers fail, create a review queue item with full shipment data for replay.
  if (!orgMatch) {
    logger.warn(`Unmatched shipment ${shipstationShipmentId} (poller), creating review queue item`);
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        category: "shipment_org_match",
        severity: "medium" as const,
        title: `Unmatched shipment: ${shipment.trackingNumber ?? shipstationShipmentId}`,
        description: `ShipStation shipment ${shipstationShipmentId} from store ${storeId ?? "unknown"} could not be matched via store mapping or SKU matching. (Detected by poller)`,
        metadata: {
          shipstation_shipment_id: shipstationShipmentId,
          store_id: storeId,
          tracking_number: shipment.trackingNumber,
          carrier: shipment.carrierCode,
          service: shipment.serviceCode,
          ship_date: shipment.shipDate,
          shipping_cost: shipment.shipmentCost,
          voided: shipment.voided,
          item_skus: itemSkus,
          item_count: shipment.shipmentItems?.length ?? 0,
          match_attempts: ["store_mapping", "sku_match"],
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

  logger.info(
    `Ingesting shipment ${shipstationShipmentId} (poller): org=${orgMatch.orgId} via ${orgMatch.method}`,
  );

  const { data: inserted, error } = await supabase
    .from("warehouse_shipments")
    .insert({
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
    })
    .select("id")
    .single();

  if (error || !inserted) return;

  // Insert items
  const items = shipment.shipmentItems ?? [];
  if (items.length > 0) {
    await supabase.from("warehouse_shipment_items").insert(
      items.map((item) => ({
        shipment_id: inserted.id,
        sku: item.sku ?? "UNKNOWN",
        quantity: item.quantity,
        product_title: item.name ?? null,
        variant_title: null,
      })),
    );
  }
}
