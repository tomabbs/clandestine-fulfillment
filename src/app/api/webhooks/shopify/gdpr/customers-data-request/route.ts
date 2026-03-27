import { NextResponse } from "next/server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);
  const secret = env().SHOPIFY_CLIENT_SECRET;
  if (secret) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    const valid = await verifyHmacSignature(rawBody, secret, signature);
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  return NextResponse.json({ received: true }, { status: 200 });
}
