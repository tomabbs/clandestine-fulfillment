/**
 * Stripe webhook Route Handler.
 *
 * Rule #36: req.text() for raw body.
 * Rule #63: Verify Stripe-Signature header.
 * Rule #62: INSERT INTO webhook_events for dedup.
 */

import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";

export async function POST(request: NextRequest) {
  const rawBody = await readWebhookBody(request);

  // Verify Stripe signature (Rule #63)
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signatureHeader = request.headers.get("Stripe-Signature");

  if (webhookSecret && signatureHeader) {
    // Stripe uses a composite signature format: t=timestamp,v1=signature
    const parts = Object.fromEntries(
      signatureHeader.split(",").map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      }),
    );

    const timestamp = parts.t;
    const signature = parts.v1;

    if (timestamp && signature) {
      const signedPayload = `${timestamp}.${rawBody}`;
      const valid = await verifyHmacSignature(signedPayload, webhookSecret, signature);
      if (!valid) {
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    }
  }

  const payload = JSON.parse(rawBody);
  const eventType = payload.type as string;
  const externalId = payload.id as string;

  if (!externalId) {
    return NextResponse.json({ error: "missing event id" }, { status: 400 });
  }

  // Dedup (Rule #62)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "stripe",
      external_webhook_id: externalId,
      topic: eventType,
      metadata: { event_type: eventType },
    })
    .select("id")
    .single();

  if (dedupError) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Handle events
  const invoiceData = payload.data?.object;
  if (!invoiceData) {
    return NextResponse.json({ ok: true });
  }

  const stripeInvoiceId = invoiceData.id as string;

  if (eventType === "invoice.paid") {
    await supabase
      .from("warehouse_billing_snapshots")
      .update({ status: "paid" })
      .eq("stripe_invoice_id", stripeInvoiceId);
  }

  if (eventType === "invoice.payment_failed") {
    await supabase
      .from("warehouse_billing_snapshots")
      .update({ status: "overdue" })
      .eq("stripe_invoice_id", stripeInvoiceId);

    // Find the snapshot to get org info for review queue
    const { data: snapshot } = await supabase
      .from("warehouse_billing_snapshots")
      .select("workspace_id, org_id, billing_period")
      .eq("stripe_invoice_id", stripeInvoiceId)
      .single();

    if (snapshot) {
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: snapshot.workspace_id,
        org_id: snapshot.org_id,
        category: "billing_invoice_failed",
        severity: "high",
        title: `Invoice payment failed: ${snapshot.billing_period}`,
        description: `Stripe invoice ${stripeInvoiceId} payment failed for billing period ${snapshot.billing_period}.`,
        metadata: {
          stripe_invoice_id: stripeInvoiceId,
          billing_period: snapshot.billing_period,
          event_type: eventType,
        },
        group_key: `invoice_failed:${stripeInvoiceId}`,
        status: "open",
      });
    }
  }

  return NextResponse.json({ ok: true });
}
