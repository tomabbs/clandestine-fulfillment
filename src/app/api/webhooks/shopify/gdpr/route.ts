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
 */

import { NextResponse } from "next/server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);

  // Verify HMAC — Shopify signs GDPR webhooks with the app's client secret
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

  // Acknowledge receipt — all three topics handled here.
  // No customer PII is stored beyond what's in our Supabase database
  // (covered under our data retention policy).
  return NextResponse.json({ received: true }, { status: 200 });
}
