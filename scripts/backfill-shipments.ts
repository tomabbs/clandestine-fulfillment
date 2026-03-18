/**
 * One-time backfill: enrich existing warehouse_shipments with:
 *   1. label_data (shipTo address) from ShipStation list API
 *   2. order_id by matching ShipStation orderNumber → warehouse_orders.order_number
 *   3. shipment_items from ShipStation individual shipment detail API
 *
 * Run: npx tsx scripts/backfill-shipments.ts
 *
 * Safe to re-run — skips rows that already have data.
 * Respects ShipStation rate limits via the client's built-in limiter.
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
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// --- Rate limiting ---

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

// --- Types ---

interface SSShipment {
  shipmentId: number;
  orderNumber?: string | null;
  trackingNumber?: string | null;
  shipTo?: {
    name?: string | null;
    company?: string | null;
    street1?: string | null;
    street2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
    phone?: string | null;
  } | null;
  shipmentItems?: Array<{
    sku?: string | null;
    name?: string | null;
    quantity: number;
  }> | null;
}

interface SSListResponse {
  shipments: SSShipment[];
  total: number;
  page: number;
  pages: number;
}

// --- Main ---

async function main() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Step 1: Fetch all shipments from ShipStation (paginated)
  console.log("Fetching shipments from ShipStation (last 90 days)...\n");
  const allShipments: SSShipment[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await ssFetch<SSListResponse>(
      `/shipments?shipDateStart=${toSSDate(ninetyDaysAgo)}&pageSize=500&page=${page}&sortBy=ShipDate&sortDir=ASC`,
    );
    allShipments.push(...data.shipments);
    console.log(`  Page ${page}/${data.pages}: ${data.shipments.length} shipments (${allShipments.length} total)`);
    hasMore = page < data.pages;
    page++;
  }

  console.log(`\nFetched ${allShipments.length} shipments from ShipStation.\n`);

  // Build lookup: shipstationShipmentId → SSShipment
  const ssLookup = new Map<string, SSShipment>();
  for (const s of allShipments) {
    ssLookup.set(String(s.shipmentId), s);
  }

  // Step 2: Load existing warehouse_shipments that need backfill
  const { data: dbShipments, error: dbErr } = await supabase
    .from("warehouse_shipments")
    .select("id, shipstation_shipment_id, label_data, order_id, tracking_number")
    .not("shipstation_shipment_id", "is", null);

  if (dbErr) {
    console.error("Failed to load warehouse_shipments:", dbErr.message);
    process.exit(1);
  }

  console.log(`Found ${dbShipments.length} warehouse_shipments with shipstation_shipment_id.\n`);

  // Pre-load order_number → order_id mapping for order matching
  const { data: orders } = await supabase
    .from("warehouse_orders")
    .select("id, order_number")
    .eq("workspace_id", WORKSPACE_ID)
    .not("order_number", "is", null);

  const orderNumberToId = new Map<string, string>();
  for (const o of orders ?? []) {
    if (o.order_number) orderNumberToId.set(o.order_number, o.id);
  }
  console.log(`Loaded ${orderNumberToId.size} warehouse_orders for order matching.\n`);

  // Pre-load existing shipment_items to know which shipments already have items
  const { data: existingItems } = await supabase
    .from("warehouse_shipment_items")
    .select("shipment_id");

  const shipmentsWithItems = new Set((existingItems ?? []).map((i) => i.shipment_id));

  // Step 3: Process each shipment
  let labelUpdated = 0;
  let orderLinked = 0;
  let itemsBackfilled = 0;
  let detailFetched = 0;
  let skipped = 0;

  for (const dbShipment of dbShipments) {
    const ssId = dbShipment.shipstation_shipment_id;
    const ss = ssLookup.get(ssId);

    if (!ss) {
      skipped++;
      continue;
    }

    const updates: Record<string, unknown> = {};

    // 3a. Backfill label_data
    if (!dbShipment.label_data && ss.shipTo) {
      updates.label_data = { shipTo: ss.shipTo };
    }

    // 3b. Backfill order_id
    if (!dbShipment.order_id && ss.orderNumber) {
      const orderId = orderNumberToId.get(ss.orderNumber);
      if (orderId) {
        updates.order_id = orderId;
      }
    }

    // Apply updates if any
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from("warehouse_shipments")
        .update(updates)
        .eq("id", dbShipment.id);

      if (updateErr) {
        console.error(`  [ERROR] Update failed for ${ssId}: ${updateErr.message}`);
      } else {
        if (updates.label_data) labelUpdated++;
        if (updates.order_id) orderLinked++;
      }
    }

    // 3c. Backfill shipment_items (need detail API for full items)
    if (!shipmentsWithItems.has(dbShipment.id)) {
      // The list API often returns null items — fetch individual shipment detail
      let items = ss.shipmentItems;

      if (!items || items.length === 0) {
        try {
          const detail = await ssFetch<SSShipment>(`/shipments/${ssId}`);
          detailFetched++;
          items = detail.shipmentItems;
        } catch (err) {
          console.error(`  [ERROR] Detail fetch failed for ${ssId}: ${err}`);
          continue;
        }
      }

      if (items && items.length > 0) {
        const rows = items.map((item) => ({
          shipment_id: dbShipment.id,
          workspace_id: WORKSPACE_ID,
          sku: item.sku ?? "UNKNOWN",
          quantity: item.quantity,
          product_title: item.name ?? null,
          variant_title: null,
        }));

        const { error: insertErr } = await supabase
          .from("warehouse_shipment_items")
          .insert(rows);

        if (insertErr) {
          console.error(`  [ERROR] Items insert failed for ${ssId}: ${insertErr.message}`);
        } else {
          itemsBackfilled += rows.length;
        }
      }
    }
  }

  console.log("\n=== Backfill Complete ===\n");
  console.log(`  label_data updated:    ${labelUpdated}`);
  console.log(`  order_id linked:       ${orderLinked}`);
  console.log(`  shipment_items added:  ${itemsBackfilled}`);
  console.log(`  detail API calls:      ${detailFetched}`);
  console.log(`  not found in SS:       ${skipped}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
