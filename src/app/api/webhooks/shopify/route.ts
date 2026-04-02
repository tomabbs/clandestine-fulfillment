/**
 * First-party Shopify webhook Route Handler.
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #62: INSERT INTO webhook_events for dedup (ON CONFLICT skip).
 * Rule #65: Echo cancellation — drop webhooks that echo back our own inventory pushes.
 * Rule #66: Return 200 within 5s (target <500ms) — heavy processing via Trigger task.
 */

import { tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  // Step 1: Read raw body first (Rule #36 — can only read once)
  const rawBody = await readWebhookBody(req);

  // Step 2: Verify HMAC signature (Rule #63)
  const { SHOPIFY_WEBHOOK_SECRET } = env();
  if (SHOPIFY_WEBHOOK_SECRET) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const valid = await verifyHmacSignature(rawBody, SHOPIFY_WEBHOOK_SECRET, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const topic = req.headers.get("X-Shopify-Topic") ?? "unknown";
  const shopifyWebhookId = req.headers.get("X-Shopify-Webhook-Id") ?? `shopify:${Date.now()}`;

  // Step 3: Resolve workspace from shop domain via client_store_connections.
  // Using store_url ILIKE match is more reliable than slug matching (slugs can drift
  // if workspace names change; store_url is immutable for a given Shopify store).
  const supabase = createServiceRoleClient();
  const shopDomain = req.headers.get("X-Shopify-Shop-Domain");
  let resolvedWorkspaceId: string | null = null;
  if (shopDomain) {
    const { data: conn } = await supabase
      .from("client_store_connections")
      .select("workspace_id")
      .eq("platform", "shopify")
      .ilike("store_url", `%${shopDomain}%`)
      .limit(1)
      .maybeSingle();
    resolvedWorkspaceId = conn?.workspace_id ?? null;
  }

  // Step 4: Dedup via webhook_events (Rule #62)
  const { data: inserted } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: shopifyWebhookId,
      topic,
      status: "pending",
      workspace_id: resolvedWorkspaceId,
      metadata: { topic, payload },
    })
    .select("id")
    .single();

  if (!inserted) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Step 5: Echo cancellation (Rule #65)
  // When we push inventory TO Shopify, Shopify fires a webhook back.
  // If the webhook quantity matches what we last pushed, it's our own echo.
  if (topic === "inventory_levels/update") {
    const inventoryItemId = payload.inventory_item_id as number | undefined;
    const available = payload.available as number | undefined;

    if (inventoryItemId != null && available != null) {
      // Look up SKU mapping by remote variant ID to check last_pushed_quantity
      const { data: mapping } = await supabase
        .from("client_store_sku_mappings")
        .select("id, last_pushed_quantity")
        .eq("remote_variant_id", String(inventoryItemId))
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

      if (mapping?.last_pushed_quantity === available) {
        // This is our own push echoing back — mark and skip
        await supabase
          .from("webhook_events")
          .update({ status: "echo_cancelled" })
          .eq("id", inserted.id);

        return NextResponse.json({ ok: true, status: "echo_cancelled" });
      }
    }
  }

  // Step 6: Enqueue async processing (Rule #66)
  await tasks.trigger("process-shopify-webhook", {
    webhookEventId: inserted.id,
    topic,
    payload,
  });

  // Step 7: Return 200 OK immediately
  return NextResponse.json({ ok: true });
}
