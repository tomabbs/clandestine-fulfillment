/**
 * One-time backfill: fetch ALL historical Bandcamp orders for all connections
 * and import them into warehouse_orders.
 *
 * The Bandcamp get_orders API supports start_time back to 2000-01-01.
 * Current bandcamp-order-sync only fetches 30 days; this fetches everything.
 *
 * Dedup: skips orders already in DB via bandcamp_payment_id (idempotent).
 *
 * Run: node scripts/backfill-bandcamp-orders.mjs
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://yspmgzphxlkcnfalndbh.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => { throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var"); })();

const envContent = readFileSync(".env.production", "utf8");
const getEnv = (k) => envContent.match(new RegExp(`^${k}=["']?(.+?)["']?$`, "m"))?.[1]?.trim();

const BANDCAMP_CLIENT_ID = getEnv("BANDCAMP_CLIENT_ID");
const BANDCAMP_CLIENT_SECRET = getEnv("BANDCAMP_CLIENT_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function refreshToken(workspaceId) {
  const { data: creds } = await supabase
    .from("bandcamp_credentials")
    .select("refresh_token")
    .eq("workspace_id", workspaceId)
    .single();

  const res = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BANDCAMP_CLIENT_ID,
      client_secret: BANDCAMP_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));

  await supabase.from("bandcamp_credentials").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  }).eq("workspace_id", workspaceId);

  return data.access_token;
}

async function fetchOrders(bandId, accessToken, startTime = "2000-01-01 00:00:00") {
  const res = await fetch("https://bandcamp.com/api/merchorders/4/get_orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ band_id: bandId, start_time: startTime }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`get_orders error: ${data.error_message}`);
  return data.items ?? [];
}

async function main() {
  const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
  const workspaceId = workspace.id;
  console.log("Workspace:", workspaceId);

  const accessToken = await refreshToken(workspaceId);
  console.log("Token refreshed");

  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("id, org_id, band_id, band_name")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);

  console.log(`Processing ${connections.length} connections\n`);

  let totalNew = 0, totalSkipped = 0;

  for (const conn of connections) {
    console.log(`=== ${conn.band_name} (band_id: ${conn.band_id}) ===`);

    let items;
    try {
      items = await fetchOrders(conn.band_id, accessToken);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      continue;
    }

    // Group by payment_id
    const byPayment = new Map();
    for (const item of items) {
      const list = byPayment.get(item.payment_id) ?? [];
      list.push(item);
      byPayment.set(item.payment_id, list);
    }

    console.log(`  ${byPayment.size} total orders from Bandcamp API`);

    let connNew = 0, connSkipped = 0;
    for (const [paymentId, orderItems] of byPayment) {
      const { data: existing } = await supabase
        .from("warehouse_orders")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("bandcamp_payment_id", paymentId)
        .maybeSingle();

      if (existing) { connSkipped++; continue; }

      const first = orderItems[0];
      const lineItems = orderItems.map(i => ({
        sku: i.sku,
        title: i.item_name,
        quantity: i.quantity ?? 1,
        price: i.sub_total,
      }));

      // Determine org_id from SKUs
      const skus = orderItems.map(i => i.sku).filter(Boolean);
      let resolvedOrgId = conn.org_id;
      if (skus.length > 0) {
        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("sku, warehouse_products!inner(org_id)")
          .eq("workspace_id", workspaceId)
          .in("sku", skus)
          .limit(1);
        const firstV = variants?.[0];
        if (firstV) {
          const product = firstV.warehouse_products;
          if (product?.org_id) resolvedOrgId = product.org_id;
        }
      }

      const orderDate = first.order_date ? new Date(first.order_date).toISOString() : new Date().toISOString();

      const { error } = await supabase.from("warehouse_orders").insert({
        workspace_id: workspaceId,
        org_id: resolvedOrgId,
        bandcamp_payment_id: paymentId,
        order_number: `BC-${paymentId}`,
        customer_name: first.buyer_name,
        customer_email: first.buyer_email,
        financial_status: "paid",
        fulfillment_status: first.ship_date ? "fulfilled" : "unfulfilled",
        total_price: first.order_total ?? 0,
        currency: first.currency ?? "USD",
        line_items: lineItems,
        shipping_address: first.ship_to_name ? {
          name: first.ship_to_name,
          street1: first.ship_to_street,
          street2: first.ship_to_street_2,
          city: first.ship_to_city,
          state: first.ship_to_state,
          postalCode: first.ship_to_zip,
          country: first.ship_to_country,
          countryCode: first.ship_to_country_code,
        } : null,
        source: "bandcamp",
        created_at: orderDate,
        synced_at: new Date().toISOString(),
      });

      if (error) {
        console.log(`  INSERT ERROR for payment ${paymentId}:`, error.message);
      } else {
        connNew++;
        totalNew++;
      }

      await new Promise(r => setTimeout(r, 50)); // gentle rate limit
    }

    console.log(`  New: ${connNew} | Skipped (already in DB): ${connSkipped}`);
    totalSkipped += connSkipped;
  }

  console.log(`\n=== Done ===`);
  console.log(`Total new orders imported: ${totalNew}`);
  console.log(`Total skipped (already existed): ${totalSkipped}`);

  // Summarize date range
  const { data: oldest } = await supabase
    .from("warehouse_orders")
    .select("created_at")
    .eq("source", "bandcamp")
    .order("created_at", { ascending: true })
    .limit(1);
  const { data: newest } = await supabase
    .from("warehouse_orders")
    .select("created_at")
    .eq("source", "bandcamp")
    .order("created_at", { ascending: false })
    .limit(1);
  const { count } = await supabase
    .from("warehouse_orders")
    .select("id", { count: "exact", head: true })
    .eq("source", "bandcamp");

  console.log(`\nBandcamp orders in DB now: ${count}`);
  console.log(`Date range: ${oldest?.[0]?.created_at?.slice(0,10)} → ${newest?.[0]?.created_at?.slice(0,10)}`);
}

main().catch(console.error);
