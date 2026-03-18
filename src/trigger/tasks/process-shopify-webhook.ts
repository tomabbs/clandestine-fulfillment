/**
 * Process Shopify inventory webhook — event trigger.
 *
 * Heavy processing happens here, not in the Route Handler (Rule #66).
 * Rule #65: Echo cancellation for inventory updates.
 * Rule #64: Inventory changes via record_inventory_change_txn RPC.
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Payload is IDs only — task fetches data from Postgres.
 * Rule #20: Single write path via recordInventoryChange().
 */

import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const payloadSchema = z.object({
  webhookEventId: z.string().uuid(),
});

/**
 * Parse Shopify inventory_levels/update webhook payload into SKU + absolute quantity.
 * Shopify sends absolute quantities, not deltas — we must compute delta ourselves.
 *
 * Shopify inventory_levels/update payload shape:
 * { inventory_item_id: number, location_id: number, available: number, updated_at: string }
 */
const shopifyInventoryPayloadSchema = z.object({
  inventory_item_id: z.number(),
  available: z.number().nullable(),
});

export interface ParsedShopifyInventory {
  inventoryItemId: number;
  available: number;
}

/**
 * Pure function: parse and validate raw Shopify inventory webhook payload.
 * Exported for testing.
 */
export function parseShopifyInventoryPayload(data: unknown): ParsedShopifyInventory | null {
  const result = shopifyInventoryPayloadSchema.safeParse(data);
  if (!result.success) return null;
  return {
    inventoryItemId: result.data.inventory_item_id,
    available: result.data.available ?? 0,
  };
}

/**
 * Pure function: compute inventory delta from webhook absolute quantity vs warehouse truth.
 * Returns 0 if no change. Exported for testing.
 */
export function computeDelta(webhookQuantity: number, warehouseQuantity: number): number {
  return webhookQuantity - warehouseQuantity;
}

export const processShopifyWebhookTask = task({
  id: "process-shopify-webhook",
  maxDuration: 60,
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { webhookEventId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    // Fetch the webhook event from DB (Rule #12: task fetches its own data)
    const { data: event, error: fetchError } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("id", webhookEventId)
      .single();

    if (fetchError || !event) {
      console.error(
        `[process-shopify-webhook] Event ${webhookEventId} not found: ${fetchError?.message}`,
      );
      return { processed: false, reason: "event_not_found" };
    }

    const metadata = event.metadata as Record<string, unknown>;
    const webhookData = metadata.payload as Record<string, unknown> | undefined;
    if (!webhookData) {
      return { processed: false, reason: "no_payload" };
    }

    // Parse the Shopify inventory payload
    const parsed = parseShopifyInventoryPayload(webhookData);
    if (!parsed) {
      console.error(
        `[process-shopify-webhook] Failed to parse inventory payload for event ${webhookEventId}`,
      );
      await markEvent(supabase, webhookEventId, "parse_failed");
      return { processed: false, reason: "parse_failed" };
    }

    // Look up SKU from inventory_item_id via our variant table
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("sku, id")
      .eq("shopify_inventory_item_id", String(parsed.inventoryItemId))
      .eq("workspace_id", event.workspace_id)
      .single();

    if (!variant) {
      // Unknown inventory item — not one of our tracked SKUs
      await markEvent(supabase, webhookEventId, "sku_not_found");
      return {
        processed: false,
        reason: "sku_not_found",
        inventoryItemId: parsed.inventoryItemId,
      };
    }

    // Rule #65: Echo cancellation — check if this webhook's quantity matches
    // what we last pushed. If so, this is our own update echoing back.
    const appId = (webhookData.app_id as number | undefined) ?? null;
    const echoAppId = metadata.app_id as number | undefined;
    if (appId || echoAppId) {
      // If we know our Shopify app ID, compare. For now, check last_pushed_quantity.
    }

    const { data: mapping } = await supabase
      .from("client_store_sku_mappings")
      .select("last_pushed_quantity")
      .eq("local_sku", variant.sku)
      .eq("platform", "shopify")
      .maybeSingle();

    if (mapping && mapping.last_pushed_quantity === parsed.available) {
      await markEvent(supabase, webhookEventId, "echo_cancelled");
      return { processed: true, reason: "echo_cancelled", sku: variant.sku };
    }

    // Get current warehouse level to compute delta
    const { data: level } = await supabase
      .from("warehouse_inventory_levels")
      .select("available")
      .eq("workspace_id", event.workspace_id)
      .eq("sku", variant.sku)
      .single();

    if (!level) {
      await markEvent(supabase, webhookEventId, "no_inventory_level");
      return { processed: false, reason: "no_inventory_level", sku: variant.sku };
    }

    const delta = computeDelta(parsed.available, level.available);
    if (delta === 0) {
      await markEvent(supabase, webhookEventId, "no_change");
      return { processed: true, reason: "no_change", sku: variant.sku };
    }

    // Rule #20: Single inventory write path via recordInventoryChange
    // Rule #64: This calls the record_inventory_change_txn RPC internally
    try {
      const result = await recordInventoryChange({
        workspaceId: event.workspace_id,
        sku: variant.sku,
        delta,
        source: "shopify",
        correlationId: `shopify_wh:${webhookEventId}`,
        metadata: {
          webhook_event_id: webhookEventId,
          inventory_item_id: parsed.inventoryItemId,
          shopify_available: parsed.available,
          warehouse_available: level.available,
        },
      });

      if (result.alreadyProcessed) {
        await markEvent(supabase, webhookEventId, "already_processed");
        return { processed: true, reason: "idempotent_skip", sku: variant.sku };
      }

      await markEvent(supabase, webhookEventId, "processed");
      return {
        processed: true,
        sku: variant.sku,
        delta,
        newQuantity: result.newQuantity,
        success: result.success,
      };
    } catch (error) {
      console.error(
        `[process-shopify-webhook] recordInventoryChange failed for SKU=${variant.sku}:`,
        error,
      );
      await markEvent(supabase, webhookEventId, "processing_failed");
      return {
        processed: false,
        reason: "inventory_change_failed",
        sku: variant.sku,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

async function markEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  eventId: string,
  status: string,
): Promise<void> {
  await supabase
    .from("webhook_events")
    .update({ status, processed_at: new Date().toISOString() })
    .eq("id", eventId);
}
