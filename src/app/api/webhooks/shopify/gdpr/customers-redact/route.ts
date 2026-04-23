/**
 * Shopify customers/redact GDPR webhook.
 * Phase 0 / §9.1 D6 — verifies against per-connection app Client Secret
 * with env fallback (see `resolveShopifyGdprWebhookSecrets`).
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveShopifyGdprWebhookSecrets } from "@/lib/server/shopify-gdpr-secret";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);

  const { candidates } = await resolveShopifyGdprWebhookSecrets(req);
  if (candidates.length > 0) {
    const signature = req.headers.get("X-Shopify-Hmac-SHA256");
    if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    let valid = false;
    for (const secret of candidates) {
      // eslint-disable-next-line no-await-in-loop -- short-circuit on first match
      if (await verifyHmacSignature(rawBody, secret, signature)) {
        valid = true;
        break;
      }
    }
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shopify",
      external_webhook_id: `gdpr-cr-${bodyHash}`,
      topic: "customers/redact",
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
