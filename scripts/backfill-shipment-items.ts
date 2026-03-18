/**
 * One-time backfill: populate warehouse_shipment_items from ShipStation order details.
 *
 * The /shipments list API returns null for shipmentItems.
 * Items must be fetched from /orders/{orderId} which includes the full items array.
 *
 * Run: npx tsx scripts/backfill-shipment-items.ts
 *
 * Safe to re-run — skips shipments that already have items.
 * Respects ShipStation rate limits (40 req/min).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SHIPSTATION_BASE = "https://ssapi.shipstation.com";
const AUTH_HEADER = `Basic ${Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString("base64")}`;
const WORKSPACE_ID = "1e59b9ca-ab4e-442b-952b-a649e2aadb0e";

let rateLimitRemaining = 40;
let rateLimitResetAt = Date.now() + 60_000;

async function ssWait(): Promise<void> {
  if (rateLimitRemaining > 2) return;
  const waitMs = Math.max(0, rateLimitResetAt - Date.now()) + 1000;
  console.log(`  [rate-limit] Waiting ${Math.round(waitMs / 1000)}s...`);
  await new Promise((r) => setTimeout(r, waitMs));
  rateLimitRemaining = 40;
}

async function ssFetch<T>(path: string): Promise<T> {
  await ssWait();
  const res = await fetch(`${SHIPSTATION_BASE}${path}`, {
    headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
  });

  const remaining = res.headers.get("X-Rate-Limit-Remaining");
  const reset = res.headers.get("X-Rate-Limit-Reset");
  if (remaining !== null) rateLimitRemaining = Number.parseInt(remaining, 10);
  if (reset !== null) rateLimitResetAt = Number.parseInt(reset, 10) * 1000;

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000;
    rateLimitRemaining = 0;
    rateLimitResetAt = Date.now() + waitMs;
    return ssFetch<T>(path);
  }

  if (!res.ok) {
    throw new Error(`ShipStation ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<T>;
}

function toSSDate(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

interface SSShipment {
  shipmentId: number;
  orderId?: number | null;
  orderNumber?: string | null;
}

interface SSOrder {
  orderId: number;
  orderNumber: string;
  items: Array<{
    sku?: string | null;
    name?: string | null;
    quantity: number;
  }>;
}

interface SSListResponse {
  shipments: SSShipment[];
  total: number;
  page: number;
  pages: number;
}

async function main() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Step 1: Fetch all shipments from ShipStation to get orderId mapping
  console.log("Fetching shipment list from ShipStation (last 90 days)...\n");
  const allShipments: SSShipment[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await ssFetch<SSListResponse>(
      `/shipments?shipDateStart=${toSSDate(ninetyDaysAgo)}&pageSize=500&page=${page}&sortBy=ShipDate&sortDir=ASC`,
    );
    allShipments.push(...data.shipments);
    console.log(`  Page ${page}/${data.pages}: ${data.shipments.length} shipments`);
    hasMore = page < data.pages;
    page++;
  }

  // Build lookup: ssShipmentId → orderId
  const shipmentToOrderId = new Map<string, number>();
  for (const s of allShipments) {
    if (s.orderId) shipmentToOrderId.set(String(s.shipmentId), s.orderId);
  }

  console.log(`\n${allShipments.length} shipments fetched, ${shipmentToOrderId.size} have orderId.\n`);

  // Step 2: Load DB shipments that DON'T have items yet
  const { data: existingItems } = await supabase
    .from("warehouse_shipment_items")
    .select("shipment_id");

  const shipmentsWithItems = new Set((existingItems ?? []).map((i) => i.shipment_id));

  const { data: dbShipments } = await supabase
    .from("warehouse_shipments")
    .select("id, shipstation_shipment_id")
    .not("shipstation_shipment_id", "is", null);

  const needsItems = (dbShipments ?? []).filter((s) => !shipmentsWithItems.has(s.id));
  console.log(`${needsItems.length} shipments need items backfilled.\n`);

  if (needsItems.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Step 3: Collect unique orderIds we need to fetch
  const orderIdToShipmentDbIds = new Map<number, Array<{ dbId: string; ssId: string }>>();
  let noOrderId = 0;

  for (const s of needsItems) {
    const ssOrderId = shipmentToOrderId.get(s.shipstation_shipment_id);
    if (!ssOrderId) {
      noOrderId++;
      continue;
    }
    const existing = orderIdToShipmentDbIds.get(ssOrderId) ?? [];
    existing.push({ dbId: s.id, ssId: s.shipstation_shipment_id });
    orderIdToShipmentDbIds.set(ssOrderId, existing);
  }

  const uniqueOrderIds = Array.from(orderIdToShipmentDbIds.keys());
  console.log(`${uniqueOrderIds.length} unique orders to fetch (${noOrderId} shipments have no orderId).\n`);

  // Step 4: Fetch orders and backfill items
  let itemsInserted = 0;
  let ordersFetched = 0;
  let ordersFailed = 0;

  for (const orderId of uniqueOrderIds) {
    let order: SSOrder;
    try {
      order = await ssFetch<SSOrder>(`/orders/${orderId}`);
      ordersFetched++;
    } catch (err) {
      console.error(`  [ERROR] Order ${orderId}: ${err}`);
      ordersFailed++;
      continue;
    }

    if (!order.items || order.items.length === 0) continue;

    // Insert items for each shipment that came from this order
    const shipments = orderIdToShipmentDbIds.get(orderId) ?? [];
    for (const { dbId } of shipments) {
      const rows = order.items.map((item) => ({
        shipment_id: dbId,
        workspace_id: WORKSPACE_ID,
        sku: item.sku ?? "UNKNOWN",
        quantity: item.quantity,
        product_title: item.name ?? null,
        variant_title: null,
      }));

      const { error: insertErr } = await supabase.from("warehouse_shipment_items").insert(rows);

      if (insertErr) {
        console.error(`  [ERROR] Insert items for shipment ${dbId}: ${insertErr.message}`);
      } else {
        itemsInserted += rows.length;
      }
    }

    // Progress log every 50 orders
    if (ordersFetched % 50 === 0) {
      console.log(`  Progress: ${ordersFetched}/${uniqueOrderIds.length} orders fetched, ${itemsInserted} items inserted`);
    }
  }

  console.log("\n=== Backfill Complete ===\n");
  console.log(`  Orders fetched:       ${ordersFetched}`);
  console.log(`  Orders failed:        ${ordersFailed}`);
  console.log(`  Items inserted:       ${itemsInserted}`);
  console.log(`  No orderId (skipped): ${noOrderId}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
