/**
 * Process Shopify inventory webhook — event trigger.
 *
 * NOTE: first-party Shopify webhook ingress is currently observe-only for
 * orders/inventory topics (ShipStation authoritative). This task remains
 * available for controlled replays or future explicit re-enable.
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

interface ResolvedVariant {
  id: string;
  sku: string;
  resolutionPath: "inventory_item_id";
}

async function resolveVariantInWorkspace(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  inventoryItemId: number,
): Promise<{
  variant: ResolvedVariant | null;
  trace: Record<string, unknown>;
}> {
  const trace: Record<string, unknown> = {
    inventory_item_id: inventoryItemId,
    workspace_id: workspaceId,
    attempted_paths: ["warehouse_product_variants.shopify_inventory_item_id"],
  };

  const { data: candidates } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku")
    .eq("shopify_inventory_item_id", String(inventoryItemId))
    .eq("workspace_id", workspaceId)
    .limit(2);

  const candidateCount = candidates?.length ?? 0;
  trace.variant_candidate_count = candidateCount;

  if (candidateCount === 1) {
    const only = candidates?.[0];
    if (!only) {
      return { variant: null, trace };
    }
    return {
      variant: {
        id: only.id,
        sku: only.sku,
        resolutionPath: "inventory_item_id",
      },
      trace,
    };
  }

  if (candidateCount > 1) {
    trace.reason = "variant_ambiguous_in_workspace";
  } else {
    trace.reason = "inventory_item_unmapped_in_workspace";
  }
  return { variant: null, trace };
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

    if (event.topic !== "inventory_levels/update") {
      await markEvent(supabase, webhookEventId, "ignored_topic");
      return { processed: true, reason: "ignored_topic" };
    }

    if (!event.workspace_id) {
      await markEvent(supabase, webhookEventId, "workspace_resolution_failed");
      await mergeMetadata(supabase, webhookEventId, {
        resolver_trace: {
          reason: "missing_workspace_id_on_event",
        },
      });
      return { processed: false, reason: "workspace_resolution_failed" };
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

    const { variant, trace } = await resolveVariantInWorkspace(
      supabase,
      event.workspace_id,
      parsed.inventoryItemId,
    );
    await mergeMetadata(supabase, webhookEventId, { resolver_trace: trace });

    if (!variant) {
      const status =
        trace.reason === "variant_ambiguous_in_workspace"
          ? "sku_not_found_in_workspace"
          : "inventory_item_unmapped_in_workspace";
      await markEvent(supabase, webhookEventId, status);
      return {
        processed: false,
        reason: status,
        inventoryItemId: parsed.inventoryItemId,
      };
    }

    // Rule #65: Echo cancellation — check if this webhook's quantity matches
    // what we last pushed in store mappings. If so, this is likely our own echo.
    const { data: mappingCandidates } = await supabase
      .from("client_store_sku_mappings")
      .select("last_pushed_quantity, client_store_connections!inner(platform)")
      .eq("variant_id", variant.id)
      .eq("client_store_connections.platform", "shopify")
      .eq("is_active", true)
      .limit(1);

    const mapping = mappingCandidates?.[0];
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
      await markEvent(supabase, webhookEventId, "variant_found_but_inventory_level_missing");
      return {
        processed: false,
        reason: "variant_found_but_inventory_level_missing",
        sku: variant.sku,
      };
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

async function mergeMetadata(
  supabase: ReturnType<typeof createServiceRoleClient>,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data: current } = await supabase
    .from("webhook_events")
    .select("metadata")
    .eq("id", eventId)
    .maybeSingle();

  const nextMetadata = {
    ...((current?.metadata as Record<string, unknown> | null) ?? {}),
    ...patch,
  };

  await supabase.from("webhook_events").update({ metadata: nextMetadata }).eq("id", eventId);
}
