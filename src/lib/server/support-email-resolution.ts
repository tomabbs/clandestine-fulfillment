import type { createServiceRoleClient } from "@/lib/server/supabase-server";

type SupabaseServiceClient = ReturnType<typeof createServiceRoleClient>;

export interface SupportEmailResolution {
  source:
    | "bandcamp_transaction"
    | "order_customer_email"
    | "client_login_email"
    | "support_email_mapping"
    | "unmatched";
  orgId: string | null;
  customerEmail: string | null;
  bandcampTransactionId: number | null;
  order: SupportResolvedOrder | null;
  shipment: SupportResolvedShipment | null;
}

export interface SupportResolvedOrder {
  id: string;
  order_number: string | null;
  source: string | null;
  customer_name: string | null;
  customer_email: string | null;
  fulfillment_status: string | null;
  financial_status: string | null;
  total_price: number | null;
  currency: string | null;
  created_at: string;
  bandcamp_payment_id: number | null;
}

export interface SupportResolvedShipment {
  id: string;
  tracking_number: string | null;
  carrier: string | null;
  status: string | null;
  ship_date: string | null;
  delivery_date: string | null;
  public_track_token: string | null;
  easypost_tracker_status: string | null;
  easypost_tracker_public_url: string | null;
}

const EMAIL_RE = /[\w.!#$%&'*+\-/=?^_`{|}~]+@[\w.-]+\.[A-Za-z]{2,}/g;

export function extractSupportEmailAddress(value: string | null | undefined): string {
  if (!value) return "";
  const angled = value.match(/<([^>]+)>/);
  if (angled) return angled[1].trim().toLowerCase();
  return (value.match(EMAIL_RE)?.[0] ?? value.trim()).toLowerCase();
}

export function parseBandcampFanMessage(body: string): {
  bandcampTransactionId: number | null;
  customerEmail: string | null;
} {
  const txMatch = body.match(/Bandcamp\s+transaction\s+(\d+)/i);
  const emails = Array.from(body.matchAll(EMAIL_RE)).map((match) => match[0].toLowerCase());
  const customerEmail =
    emails.find(
      (email) =>
        !email.endsWith("@bandcamp.com") &&
        !email.endsWith("@clandestinedistribution.com") &&
        !email.endsWith("@clandestinedistro.com"),
    ) ?? null;

  return {
    bandcampTransactionId: txMatch ? Number.parseInt(txMatch[1], 10) : null,
    customerEmail,
  };
}

export async function resolveSupportEmailContext({
  supabase,
  workspaceId,
  senderAddress,
  subject,
  body,
}: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  senderAddress?: string | null;
  subject?: string | null;
  body: string;
}): Promise<SupportEmailResolution> {
  const sender = extractSupportEmailAddress(senderAddress);
  const parsedBandcamp = parseBandcampFanMessage(`${subject ?? ""}\n${body}`);

  if (parsedBandcamp.bandcampTransactionId != null) {
    const order = await findOrderByBandcampTransaction(
      supabase,
      workspaceId,
      parsedBandcamp.bandcampTransactionId,
    );
    if (order) {
      return {
        source: "bandcamp_transaction",
        orgId: order.org_id,
        customerEmail: parsedBandcamp.customerEmail ?? order.customer_email,
        bandcampTransactionId: parsedBandcamp.bandcampTransactionId,
        order: toResolvedOrder(order),
        shipment: await findShipmentForOrder(supabase, workspaceId, order.id),
      };
    }
  }

  const candidateEmails = Array.from(
    new Set(
      [parsedBandcamp.customerEmail, sender].filter((value): value is string => Boolean(value)),
    ),
  );

  for (const email of candidateEmails) {
    const order = await findLatestOrderByCustomerEmail(supabase, workspaceId, email);
    if (order) {
      return {
        source: "order_customer_email",
        orgId: order.org_id,
        customerEmail: email,
        bandcampTransactionId: parsedBandcamp.bandcampTransactionId,
        order: toResolvedOrder(order),
        shipment: await findShipmentForOrder(supabase, workspaceId, order.id),
      };
    }
  }

  for (const email of candidateEmails) {
    const orgId = await findOrgByUserEmail(supabase, workspaceId, email);
    if (orgId) {
      return {
        source: "client_login_email",
        orgId,
        customerEmail: email,
        bandcampTransactionId: parsedBandcamp.bandcampTransactionId,
        order: null,
        shipment: null,
      };
    }
  }

  for (const email of candidateEmails) {
    const orgId = await findOrgBySupportEmailMapping(supabase, workspaceId, email);
    if (orgId) {
      return {
        source: "support_email_mapping",
        orgId,
        customerEmail: email,
        bandcampTransactionId: parsedBandcamp.bandcampTransactionId,
        order: null,
        shipment: null,
      };
    }
  }

  return {
    source: "unmatched",
    orgId: null,
    customerEmail: parsedBandcamp.customerEmail ?? (sender || null),
    bandcampTransactionId: parsedBandcamp.bandcampTransactionId,
    order: null,
    shipment: null,
  };
}

async function findOrderByBandcampTransaction(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  bandcampTransactionId: number,
) {
  const { data } = await supabase
    .from("warehouse_orders")
    .select(
      "id, workspace_id, org_id, order_number, source, customer_name, customer_email, fulfillment_status, financial_status, total_price, currency, created_at, bandcamp_payment_id",
    )
    .eq("workspace_id", workspaceId)
    .eq("bandcamp_payment_id", bandcampTransactionId)
    .maybeSingle();
  return data ?? null;
}

async function findLatestOrderByCustomerEmail(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  email: string,
) {
  const { data } = await supabase
    .from("warehouse_orders")
    .select(
      "id, workspace_id, org_id, order_number, source, customer_name, customer_email, fulfillment_status, financial_status, total_price, currency, created_at, bandcamp_payment_id",
    )
    .eq("workspace_id", workspaceId)
    .ilike("customer_email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function findShipmentForOrder(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  orderId: string,
): Promise<SupportResolvedShipment | null> {
  const { data } = await supabase
    .from("warehouse_shipments")
    .select(
      "id, tracking_number, carrier, status, ship_date, delivery_date, public_track_token, easypost_tracker_status, easypost_tracker_public_url",
    )
    .eq("workspace_id", workspaceId)
    .eq("order_id", orderId)
    .eq("voided", false)
    .order("ship_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SupportResolvedShipment | null) ?? null;
}

async function findOrgByUserEmail(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  email: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("users")
    .select("org_id")
    .eq("workspace_id", workspaceId)
    .ilike("email", email)
    .not("org_id", "is", null)
    .limit(1)
    .maybeSingle();
  return (data?.org_id as string | null | undefined) ?? null;
}

async function findOrgBySupportEmailMapping(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  email: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("support_email_mappings")
    .select("org_id")
    .eq("workspace_id", workspaceId)
    .ilike("email_address", email)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return (data?.org_id as string | null | undefined) ?? null;
}

function toResolvedOrder(order: {
  id: string;
  order_number: string | null;
  source: string | null;
  customer_name: string | null;
  customer_email: string | null;
  fulfillment_status: string | null;
  financial_status: string | null;
  total_price: number | string | null;
  currency: string | null;
  created_at: string;
  bandcamp_payment_id: number | null;
}): SupportResolvedOrder {
  return {
    ...order,
    total_price: order.total_price == null ? null : Number(order.total_price),
  };
}
