/**
 * Process client store webhook — event trigger.
 *
 * Heavy processing happens here, not in the Route Handler (Rule #66).
 * Rule #65: Echo cancellation for inventory updates.
 * Rule #7: Uses createServiceRoleClient().
 */

import { task } from "@trigger.dev/sdk";
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
  }

  await supabase
    .from("webhook_events")
    .update({ status: "processed" })
    .eq("id", event.id as string);

  return { processed: true, orderId: newOrder?.id };
}
