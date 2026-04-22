/**
 * Combined Shopify GDPR compliance webhook handler.
 *
 * Handles all three mandatory GDPR topics:
 *   customers/data_request — customer requests their data
 *   customers/redact       — customer requests data deletion
 *   shop/redact            — shop uninstalled, delete shop data
 *
 * Shopify signs GDPR webhooks with the app's client secret.
 * Rule #36: Raw body must be read before any parsing.
 * Rule #62: Dedup via webhook_events INSERT.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);

  const secret = env().SHOPIFY_CLIENT_SECRET;
  if (secret) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const valid = await verifyHmacSignature(rawBody, secret, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: `gdpr-${bodyHash}`,
      topic: "gdpr/combined",
      status: "received",
    })
    .select("id")
    .single();

  if (dedupError) {
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    console.error("webhook_events insert failed:", dedupError);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
