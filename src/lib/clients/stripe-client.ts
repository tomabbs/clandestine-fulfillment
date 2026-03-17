import { env } from "@/lib/shared/env";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

interface StripeLineItem {
  description: string;
  amount: number; // in cents
  quantity?: number;
}

interface StripeInvoice {
  id: string;
  status: string;
  hosted_invoice_url: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  customer: string;
  metadata: Record<string, string>;
  created: number;
}

async function stripeRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: URLSearchParams;
  } = {},
): Promise<T> {
  const { STRIPE_SECRET_KEY } = env();
  const { method = "GET", body } = options;

  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body?.toString(),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`Stripe API error: ${error.error?.message ?? res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export async function createInvoice(
  customerId: string,
  items: StripeLineItem[],
  metadata: Record<string, string> = {},
): Promise<StripeInvoice> {
  // Create the invoice
  const invoiceParams = new URLSearchParams();
  invoiceParams.set("customer", customerId);
  invoiceParams.set("auto_advance", "false");
  for (const [key, value] of Object.entries(metadata)) {
    invoiceParams.set(`metadata[${key}]`, value);
  }

  const invoice = await stripeRequest<StripeInvoice>("/invoices", {
    method: "POST",
    body: invoiceParams,
  });

  // Add line items
  for (const item of items) {
    const itemParams = new URLSearchParams();
    itemParams.set("invoice", invoice.id);
    itemParams.set("description", item.description);
    itemParams.set("amount", String(item.amount));
    itemParams.set("currency", "usd");
    itemParams.set("quantity", String(item.quantity ?? 1));

    await stripeRequest("/invoiceitems", {
      method: "POST",
      body: itemParams,
    });
  }

  // Re-fetch to get updated totals
  return getInvoice(invoice.id);
}

export async function getInvoice(invoiceId: string): Promise<StripeInvoice> {
  return stripeRequest<StripeInvoice>(`/invoices/${encodeURIComponent(invoiceId)}`);
}

export async function listInvoices(
  customerId: string,
  limit = 10,
): Promise<{ data: StripeInvoice[]; has_more: boolean }> {
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("limit", String(limit));

  return stripeRequest(`/invoices?${params.toString()}`);
}
