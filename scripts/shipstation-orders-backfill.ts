/**
 * Phase 1.4 — Seed shipstation_orders from a 60-day SS history window.
 *
 * Run: npx tsx scripts/shipstation-orders-backfill.ts [--dry-run] [--days=60] [--workspace=<id>]
 *
 * What it does:
 *   1. Walks SS /orders for awaiting_shipment + awaiting_payment + shipped (last N days, default 60).
 *   2. Resolves org_id via warehouse_shipstation_stores → SKU fallback (matchShipmentOrg).
 *   3. Upserts into shipstation_orders + replaces shipstation_order_items per row.
 *   4. Seeds warehouse_sync_state cursor so the cron in Phase 1.2 starts polling
 *      from the correct position on first run (not 7 days in the past).
 *
 * Safe to re-run — uses the same upsert path as the cron task.
 *
 * Exit codes:
 *   0 — success (or dry-run)
 *   1 — fatal error (env missing, SS API down, etc.)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const isDryRun = args.has("--dry-run");
const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
const days = daysArg ? Math.max(1, Math.min(365, Number.parseInt(daysArg, 10))) : 60;
const workspaceArg = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];

const supabase = createClient(url, key, { auth: { persistSession: false } });

// We can't import @/trigger/lib/match-shipment-org from a script (it relies on
// the trigger logger). Re-implement the 3-tier match inline; logic mirrors
// src/trigger/lib/match-shipment-org.ts.
async function resolveOrgId(
  storeId: number | null,
  itemSkus: string[],
): Promise<string | null> {
  if (storeId) {
    const { data: store } = await supabase
      .from("warehouse_shipstation_stores")
      .select("org_id")
      .eq("store_id", storeId)
      .not("org_id", "is", null)
      .maybeSingle();
    if (store?.org_id) return store.org_id;
  }
  const validSkus = itemSkus.filter((s) => s && s !== "UNKNOWN");
  if (validSkus.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, warehouse_products!inner(org_id)")
      .in("sku", validSkus);
    if (variants?.length) {
      const counts: Record<string, number> = {};
      for (const v of variants) {
        const product = v.warehouse_products as unknown as { org_id?: string } | null;
        const orgId = product?.org_id;
        if (orgId) counts[orgId] = (counts[orgId] ?? 0) + 1;
      }
      let bestOrg: string | null = null;
      let bestCount = 0;
      for (const [orgId, count] of Object.entries(counts)) {
        if (count > bestCount) {
          bestOrg = orgId;
          bestCount = count;
        }
      }
      if (bestOrg) return bestOrg;
    }
  }
  return null;
}

// Inline SS auth (avoid the env() validator coupling — script uses bare process.env).
const SS_KEY = process.env.SHIPSTATION_API_KEY ?? "";
const SS_SECRET = process.env.SHIPSTATION_API_SECRET ?? "";
if (!SS_KEY || !SS_SECRET) {
  console.error("Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET");
  process.exit(1);
}
const ssAuth = `Basic ${Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64")}`;

interface SSOrder {
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  orderDate?: string | null;
  customerEmail?: string | null;
  customerUsername?: string | null;
  shipTo?: Record<string, unknown> | null;
  items?: Array<{
    sku?: string | null;
    name?: string | null;
    quantity: number;
    unitPrice?: number | null;
  }>;
  amountPaid?: number | null;
  shippingAmount?: number | null;
  modifyDate?: string | null;
  storeId?: number | null;
  advancedOptions?: { storeId?: number | null } | null;
}

async function ssFetchOrders(params: {
  modifyDateStart: string;
  page: number;
  pageSize: number;
  status: string;
}) {
  const sp = new URLSearchParams();
  sp.set("modifyDateStart", params.modifyDateStart.replace("T", " ").replace(/\.\d{3}Z$/, ""));
  sp.set("page", String(params.page));
  sp.set("pageSize", String(params.pageSize));
  sp.set("orderStatus", params.status);
  const r = await fetch(`https://ssapi.shipstation.com/orders?${sp}`, {
    headers: { Authorization: ssAuth },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`SS /orders ${r.status}: ${body}`);
  }
  return (await r.json()) as { orders: SSOrder[]; total: number; page: number; pages: number };
}

async function backfillStatus(workspaceId: string, status: string, sinceISO: string) {
  let page = 1;
  let upserted = 0;
  let unmatched = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await ssFetchOrders({
      modifyDateStart: sinceISO,
      page,
      pageSize: 250,
      status,
    });
    console.log(
      `  [${status}] page=${page}/${result.pages}, total=${result.total}, count=${result.orders.length}`,
    );

    for (const o of result.orders) {
      const storeId = o.advancedOptions?.storeId ?? o.storeId ?? null;
      const skus = (o.items ?? [])
        .map((i) => i.sku)
        .filter((s): s is string => !!s && s !== "UNKNOWN");
      const orgId = await resolveOrgId(storeId, skus);
      if (!orgId) unmatched++;

      if (isDryRun) {
        upserted++;
        continue;
      }

      const { data: row, error: upsertErr } = await supabase
        .from("shipstation_orders")
        .upsert(
          {
            workspace_id: workspaceId,
            org_id: orgId,
            shipstation_order_id: o.orderId,
            order_number: o.orderNumber,
            order_status: o.orderStatus,
            order_date: o.orderDate ?? null,
            customer_email: o.customerEmail ?? null,
            customer_name: o.customerUsername ?? null,
            ship_to: o.shipTo ?? null,
            store_id: storeId,
            amount_paid: o.amountPaid ?? null,
            shipping_paid: o.shippingAmount ?? null,
            last_modified: o.modifyDate ?? null,
            synced_at: new Date().toISOString(),
            advanced_options: o.advancedOptions ?? {},
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,shipstation_order_id" },
        )
        .select("id")
        .single();

      if (upsertErr || !row) {
        console.error(`    order ${o.orderId} upsert failed: ${upsertErr?.message}`);
        continue;
      }

      // Replace items
      await supabase.from("shipstation_order_items").delete().eq("shipstation_order_id", row.id);
      if (o.items?.length) {
        await supabase.from("shipstation_order_items").insert(
          o.items.map((it, idx) => ({
            workspace_id: workspaceId,
            shipstation_order_id: row.id,
            sku: it.sku ?? null,
            name: it.name ?? null,
            quantity: it.quantity,
            unit_price: it.unitPrice ?? null,
            item_index: idx,
          })),
        );
      }

      upserted++;
    }

    hasMore = page < result.pages;
    page++;
  }

  return { upserted, unmatched };
}

async function main() {
  console.log(
    `[shipstation-orders-backfill] mode=${isDryRun ? "DRY-RUN" : "WRITE"} days=${days}${
      workspaceArg ? ` workspace=${workspaceArg}` : ""
    }`,
  );

  // Pick workspace.
  let workspaceId: string;
  if (workspaceArg) {
    workspaceId = workspaceArg;
  } else {
    const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
    if (!ws) {
      console.error("No workspace found");
      process.exit(1);
    }
    workspaceId = ws.id;
  }

  const sinceISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const totals = { upserted: 0, unmatched: 0 };

  // Cover the three statuses the cockpit cares about. SS doesn't accept
  // multiple statuses in one call so we fan out.
  for (const status of ["awaiting_shipment", "awaiting_payment", "shipped"]) {
    console.log(`\n[shipstation-orders-backfill] status=${status} since=${sinceISO}`);
    try {
      const r = await backfillStatus(workspaceId, status, sinceISO);
      totals.upserted += r.upserted;
      totals.unmatched += r.unmatched;
    } catch (err) {
      console.error(`  status=${status} fatal: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!isDryRun) {
    // Seed cursor so the cron starts from "now" rather than re-pulling the
    // 60-day window on its first run.
    const cursor = new Date().toISOString();
    const { data: existing } = await supabase
      .from("warehouse_sync_state")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("sync_type", "shipstation_orders_poll")
      .maybeSingle();
    if (existing) {
      await supabase
        .from("warehouse_sync_state")
        .update({
          last_sync_cursor: cursor,
          last_sync_wall_clock: cursor,
          metadata: { backfill_completed_at: cursor, backfill_days: days },
          updated_at: cursor,
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("warehouse_sync_state").insert({
        workspace_id: workspaceId,
        sync_type: "shipstation_orders_poll",
        last_sync_cursor: cursor,
        last_sync_wall_clock: cursor,
        metadata: { backfill_completed_at: cursor, backfill_days: days },
      });
    }
    console.log(`\n[shipstation-orders-backfill] sync cursor seeded → ${cursor}`);
  }

  console.log(
    `\n[shipstation-orders-backfill] DONE — upserted=${totals.upserted}, unmatched=${totals.unmatched}`,
  );
}

main().catch((err) => {
  console.error("[shipstation-orders-backfill]", err);
  process.exit(1);
});
