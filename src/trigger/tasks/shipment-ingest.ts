// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
// Rule #12: Payload is IDs only — task fetches data from Postgres

import { logger, task } from "@trigger.dev/sdk";
import { z } from "zod";
import type { ShipStationShipment } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";

const payloadSchema = z.object({
  webhookEventId: z.string().uuid(),
});

export const shipmentIngestTask = task({
  id: "shipment-ingest",
  maxDuration: 120,
  queue: {
    concurrencyLimit: 5,
  },
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { webhookEventId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    // Fetch webhook event from DB
    const { data: webhookEvent, error: fetchError } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("id", webhookEventId)
      .single();

    if (fetchError || !webhookEvent) {
      throw new Error(`Webhook event ${webhookEventId} not found: ${fetchError?.message}`);
    }

    // The resource_url points to the shipment(s) — fetch from ShipStation API
    const resourceUrl = (webhookEvent.metadata as Record<string, unknown>).resource_url as string;
    if (!resourceUrl) {
      throw new Error(`No resource_url in webhook event ${webhookEventId}`);
    }

    // ShipStation SHIP_NOTIFY resource_url returns the shipment data directly
    const response = await fetch(resourceUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch shipment from resource_url: ${response.status}`);
    }

    const shipmentData = (await response.json()) as Record<string, unknown>;

    // ShipStation resource_url returns either a single shipment or a list
    const shipments: ShipStationShipment[] = Array.isArray(shipmentData)
      ? shipmentData
      : ((shipmentData as { shipments?: ShipStationShipment[] }).shipments ?? [
          shipmentData as ShipStationShipment,
        ]);

    let processed = 0;

    for (const shipment of shipments) {
      await ingestSingleShipment(supabase, shipment);
      processed++;
    }

    // Mark webhook event as processed
    await supabase
      .from("webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", webhookEventId);

    return { processed };
  },
});

async function ingestSingleShipment(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: ShipStationShipment,
) {
  const shipstationShipmentId = String(shipment.shipmentId);

  // Check if already ingested (idempotent)
  const { data: existing } = await supabase
    .from("warehouse_shipments")
    .select("id")
    .eq("shipstation_shipment_id", shipstationShipmentId)
    .maybeSingle();

  if (existing) return;

  // Match org via 3-tier fallback chain
  const storeId = shipment.advancedOptions?.storeId ?? shipment.storeId;
  const itemSkus = (shipment.shipmentItems ?? []).map((i) => i.sku).filter(Boolean) as string[];

  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);

  // If all tiers fail, create a review queue item with full shipment data for replay.
  // org_id is NOT NULL on warehouse_shipments, so we can't insert without a match.
  if (!orgMatch) {
    logger.warn(`Unmatched shipment ${shipstationShipmentId}, creating review queue item`);
    await supabase.from("warehouse_review_queue").upsert(
      {
        category: "shipment_org_match",
        severity: "medium" as const,
        title: `Unmatched shipment: ${shipment.trackingNumber ?? shipstationShipmentId}`,
        description: `ShipStation shipment ${shipstationShipmentId} from store ${storeId ?? "unknown"} could not be matched to an organization via store mapping or SKU matching. Full shipment data stored in metadata for replay after org mapping is configured.`,
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
          ship_to: shipment.shipTo ?? null,
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
    `Ingesting shipment ${shipstationShipmentId}: org=${orgMatch.orgId} via ${orgMatch.method}`,
  );

  // Insert shipment
  const { data: inserted, error: insertError } = await supabase
    .from("warehouse_shipments")
    .insert({
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

  if (insertError || !inserted) {
    throw new Error(`Failed to insert shipment ${shipstationShipmentId}: ${insertError?.message}`);
  }

  // Insert shipment items
  const items = shipment.shipmentItems ?? [];
  if (items.length > 0) {
    const itemRows = items.map((item) => ({
      shipment_id: inserted.id,
      sku: item.sku ?? "UNKNOWN",
      quantity: item.quantity,
      product_title: item.name ?? null,
      variant_title: null,
    }));

    const { error: itemsError } = await supabase.from("warehouse_shipment_items").insert(itemRows);

    if (itemsError) {
      throw new Error(`Failed to insert shipment items: ${itemsError.message}`);
    }
  }
}
