/**
 * Client store webhook Route Handler.
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #23: Per-platform HMAC signature verification.
 * Rule #62: INSERT INTO webhook_events for dedup.
 * Rule #66: Return 200 fast — heavy processing in Trigger task.
 */

import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";

export async function POST(request: NextRequest) {
  // Step 1: Read raw body (must be first — can only read once)
  const rawBody = await readWebhookBody(request);

  // Step 2: Determine platform and connection
  const connectionId = request.nextUrl.searchParams.get("connection_id");
  const _platform = request.nextUrl.searchParams.get("platform") ?? "unknown";

  if (!connectionId) {
    return NextResponse.json({ error: "missing connection_id" }, { status: 400 });
  }

  // Get connection for webhook secret (using service role — no RLS)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: connection } = await supabase
    .from("client_store_connections")
    .select("id, workspace_id, platform, webhook_secret")
    .eq("id", connectionId)
    .single();

  if (!connection) {
    return NextResponse.json({ error: "connection not found" }, { status: 404 });
  }

  // Step 3: Verify HMAC per platform (Rule #23)
  if (connection.webhook_secret) {
    let signature: string | null = null;
    const algorithm: "SHA-256" | "SHA-1" = "SHA-256";

    if (connection.platform === "shopify") {
      signature = request.headers.get("X-Shopify-Hmac-SHA256");
    } else if (connection.platform === "woocommerce") {
      signature = request.headers.get("X-WC-Webhook-Signature");
    }

    if (signature) {
      const valid = await verifyHmacSignature(
        rawBody,
        connection.webhook_secret,
        signature,
        algorithm,
      );
      if (!valid) {
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    }
  }

  // Step 4: Dedup via webhook_events (Rule #62)
  const externalWebhookId =
    request.headers.get("X-Shopify-Webhook-Id") ??
    request.headers.get("X-WC-Webhook-ID") ??
    `${connectionId}:${Date.now()}`;

  const { data: insertedEvent, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      workspace_id: connection.workspace_id,
      platform: connection.platform,
      external_webhook_id: externalWebhookId,
      topic: request.headers.get("X-Shopify-Topic") ?? request.headers.get("X-WC-Webhook-Topic"),
      metadata: {
        connection_id: connectionId,
        payload: JSON.parse(rawBody),
      },
    })
    .select("id")
    .single();

  if (dedupError) {
    // Unique constraint violation = already processed
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Step 5: Fire Trigger task for heavy processing (Rule #66)
  if (insertedEvent) {
    await tasks.trigger("process-client-store-webhook", {
      webhookEventId: insertedEvent.id,
    });
  }

  // Step 6: Return 200 fast
  return NextResponse.json({ ok: true });
}
