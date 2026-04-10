/**
 * Process client store webhook — event trigger.
 *
 * Heavy processing happens here, not in the Route Handler (Rule #66).
 * Rule #65: Echo cancellation for inventory updates.
 * Rule #7: Uses createServiceRoleClient().
 */

import { task, tasks } from "@trigger.dev/sdk";
import { triggerBundleFanout } from "@/lib/server/bundles";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const processClientStoreWebhookTask = task({
  id: "process-client-store-webhook",
  maxDuration: 60,
  run: async (payload: { webhookEventId: string }) => {
    const supabase = createServiceRoleClient();

    // Fetch the webhook event
    const { data: event } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("id", payload.webhookEventId)
      .single();

    if (!event) throw new Error(`Webhook event ${payload.webhookEventId} not found`);

    const metadata = event.metadata as Record<string, unknown>;
    const webhookData = metadata.payload as Record<string, unknown> | undefined;
    if (!webhookData) return { processed: false, reason: "no_payload" };

    const topic = event.topic ?? "";

    // Determine connection for echo cancellation check
    const connectionId = metadata.connection_id as string | undefined;

    if (topic.includes("inventory") || topic.includes("stock")) {
      return await handleInventoryUpdate(supabase, event, webhookData, connectionId);
    }

    if (topic.includes("order")) {
      return await handleOrderCreated(supabase, event, webhookData, connectionId);
    }

    return { processed: false, reason: "unknown_topic", topic };
  },
});

async function handleInventoryUpdate(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const sku = (data.sku as string) ?? "";
  const newQuantity = data.quantity as number | undefined;

  if (!sku || newQuantity === undefined) {
    return { processed: false, reason: "missing_sku_or_quantity" };
  }

  // Rule #65: Echo cancellation
  if (connectionId) {
    const { data: mapping } = await supabase
      .from("client_store_sku_mappings")
      .select("last_pushed_quantity")
      .eq("connection_id", connectionId)
      .eq("remote_sku", sku)
      .single();

    if (mapping && mapping.last_pushed_quantity === newQuantity) {
      // This is our own push echoing back
      await supabase
        .from("webhook_events")
        .update({ status: "echo_cancelled" })
        .eq("id", event.id as string);

      return { processed: true, reason: "echo_cancelled", sku };
    }
  }

  // Get current warehouse inventory to compute delta
  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("workspace_id", event.workspace_id as string)
    .eq("sku", sku)
    .single();

  if (!level) return { processed: false, reason: "sku_not_found", sku };

  const delta = newQuantity - level.available;
  if (delta === 0) return { processed: true, reason: "no_change", sku };

  const platform = event.platform as string;
  const source =
    platform === "shopify" ? "shopify" : platform === "woocommerce" ? "woocommerce" : "shopify";

  await recordInventoryChange({
    workspaceId: event.workspace_id as string,
    sku,
    delta,
    source: source as "shopify" | "woocommerce",
    correlationId: `webhook:${event.platform}:${event.id}`,
    metadata: { webhook_event_id: event.id, platform },
  });

  await supabase
    .from("webhook_events")
    .update({ status: "processed" })
    .eq("id", event.id as string);

  return { processed: true, sku, delta };
}

async function handleOrderCreated(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const workspaceId = event.workspace_id as string;
  const remoteOrderId = (data.id as string) ?? (data.order_id as string) ?? "";
  const lineItems = (data.line_items as Array<Record<string, unknown>>) ?? [];

  // Check for duplicate
  const { data: existing } = await supabase
    .from("warehouse_orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("external_order_id", remoteOrderId)
    .single();

  if (existing) return { processed: true, reason: "duplicate_order" };

  // Get org from connection
  let orgId: string | null = null;
  if (connectionId) {
    const { data: conn } = await supabase
      .from("client_store_connections")
      .select("org_id")
      .eq("id", connectionId)
      .single();
    orgId = conn?.org_id ?? null;
  }

  if (!orgId) return { processed: false, reason: "no_org_id" };

  const platform = event.platform as string;
  const { data: newOrder } = await supabase
    .from("warehouse_orders")
    .insert({
      workspace_id: workspaceId,
      org_id: orgId,
      external_order_id: remoteOrderId,
      order_number: (data.order_number as string) ?? (data.name as string) ?? null,
      source: platform,
      line_items: lineItems,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (newOrder && lineItems.length > 0) {
    const items = lineItems.map((li) => ({
      order_id: newOrder.id,
      workspace_id: workspaceId,
      sku: (li.sku as string) ?? "",
      quantity: (li.quantity as number) ?? 1,
    }));
    await supabase.from("warehouse_order_items").insert(items);

    // Decrement warehouse inventory for each line item.
    // This loop is NOT atomic — partial failures are recorded in warehouse_review_queue.
    // floor_violation (medium) = expected stock-short; system_fault (high) = needs investigation.
    const platform = event.platform as string;
    const bundleCache = new Map<string, boolean>();
    const decrementResults: {
      sku: string;
      delta: number;
      status: "ok" | "floor_violation" | "not_mapped" | "error";
      reason?: string;
    }[] = [];

    for (let index = 0; index < lineItems.length; index++) {
      const li = lineItems[index];
      const remoteSku = (li.sku as string) ?? "";
      if (!remoteSku) continue;

      // Resolve warehouse SKU via mapping (remote SKU may differ from warehouse SKU)
      const { data: mapping } = await supabase
        .from("client_store_sku_mappings")
        .select("variant_id, warehouse_product_variants!inner(sku)")
        .eq("connection_id", connectionId ?? "")
        .eq("remote_sku", remoteSku)
        .single();

      const warehouseSku = (
        mapping?.warehouse_product_variants as unknown as { sku: string } | null
      )?.sku;
      if (!warehouseSku) {
        decrementResults.push({ sku: remoteSku, delta: 0, status: "not_mapped" });
        continue;
      }

      const qty = (li.quantity as number) ?? 1;
      // Include line item ID or index to prevent correlation ID collision when
      // the same warehouse SKU appears in two separate line items of one order.
      const lineItemId = (li.id as string | undefined) ?? String(index);
      const result = await recordInventoryChange({
        workspaceId,
        sku: warehouseSku,
        delta: -qty,
        source: platform === "woocommerce" ? "woocommerce" : "shopify",
        correlationId: `store-order:${event.id}:${warehouseSku}:${lineItemId}`,
        metadata: {
          order_id: newOrder.id,
          remote_sku: remoteSku,
          connection_id: connectionId,
          line_item_id: lineItemId,
        },
      });

      if (result.success || result.alreadyProcessed) {
        decrementResults.push({ sku: warehouseSku, delta: -qty, status: "ok" });

        if (result.success && !result.alreadyProcessed && qty > 0 && mapping?.variant_id) {
          const fanout = await triggerBundleFanout({
            variantId: mapping.variant_id,
            soldQuantity: qty,
            workspaceId,
            correlationBase: `store-order:${event.id}:${warehouseSku}`,
            cache: bundleCache,
          });
          if (fanout.error) {
            console.error("[process-client-store-webhook] Bundle fanout failed:", fanout.error);
          }
        }
      } else if ((result as { reason?: string }).reason === "floor_violation") {
        decrementResults.push({
          sku: warehouseSku,
          delta: -qty,
          status: "floor_violation",
          reason: "insufficient_stock",
        });
      } else {
        decrementResults.push({
          sku: warehouseSku,
          delta: -qty,
          status: "error",
          reason: "system_fault",
        });
      }
    }

    // Record partial application to review queue if any line item failed
    const failures = decrementResults.filter((r) => r.status !== "ok" && r.status !== "not_mapped");
    if (failures.length > 0) {
      const hasSystemFault = failures.some((r) => r.status === "error");
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: workspaceId,
          org_id: orgId,
          category: "inventory_partial_apply",
          severity: hasSystemFault ? "high" : "medium",
          title: hasSystemFault
            ? `Order ${newOrder.id}: inventory write failed (system error)`
            : `Order ${newOrder.id}: inventory short on ${failures.length} SKU(s)`,
          description: failures
            .map((f) => `${f.sku}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`)
            .join("; "),
          metadata: { order_id: newOrder.id, decrement_results: decrementResults },
          status: "open",
          group_key: `inv_partial:${newOrder.id}`,
          occurrence_count: 1,
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );
    }

    // Trigger immediate push to all channels if any decrement succeeded
    if (decrementResults.some((r) => r.status === "ok")) {
      await Promise.allSettled([
        tasks.trigger("bandcamp-inventory-push", {}),
        tasks.trigger("multi-store-inventory-push", {}),
      ]).catch(() => {
        /* non-critical */
      });
    }
  }

  await supabase
    .from("webhook_events")
    .update({ status: "processed" })
    .eq("id", event.id as string);

  return { processed: true, orderId: newOrder?.id };
}
