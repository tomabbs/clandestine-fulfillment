/**
 * Local backfill: update Bandcamp-mapped variants with prices and images from Bandcamp API.
 * Run: npx tsx scripts/backfill-bandcamp-prices.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function refreshToken(workspaceId: string): Promise<string> {
  const { data: creds } = await supabase
    .from("bandcamp_credentials")
    .select("access_token, refresh_token")
    .eq("workspace_id", workspaceId)
    .single();

  if (!creds?.access_token) throw new Error("No Bandcamp credentials");

  // Try existing token first
  const testRes = await fetch("https://bandcamp.com/api/account/1/my_bands", {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const testJson = await testRes.json();
  if (!testJson.error) return creds.access_token;

  // Refresh
  const res = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.BANDCAMP_CLIENT_ID!,
      client_secret: process.env.BANDCAMP_CLIENT_SECRET!,
      refresh_token: creds.refresh_token!,
    }),
  });
  const tokenData = await res.json();
  await supabase
    .from("bandcamp_credentials")
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
    })
    .eq("workspace_id", workspaceId);
  return tokenData.access_token;
}

async function main() {
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) { console.error("No workspace"); process.exit(1); }

  const accessToken = await refreshToken(ws.id);
  console.log("Token ready\n");

  // Get all active Bandcamp connections
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("band_id, band_name, org_id")
    .eq("workspace_id", ws.id)
    .eq("is_active", true);

  let pricesUpdated = 0;
  let costsUpdated = 0;
  let imagesAdded = 0;
  let skipped = 0;

  for (const conn of connections ?? []) {
    process.stdout.write(`\n${conn.band_name} (${conn.band_id}): `);

    let items: any[];
    try {
      const res = await fetch("https://bandcamp.com/api/merchorders/1/get_merch_details", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ band_id: conn.band_id, start_time: "2000-01-01 00:00:00" }),
      });
      const json = await res.json();
      if (json.error) { process.stdout.write(`API error: ${json.error_message}`); continue; }
      items = json.items ?? [];
    } catch (err) {
      process.stdout.write(`fetch error`);
      continue;
    }

    for (const item of items) {
      if (!item.sku) continue;

      // Find variant by SKU
      const { data: variant } = await supabase
        .from("warehouse_product_variants")
        .select("id, price, cost, product_id")
        .eq("workspace_id", ws.id)
        .eq("sku", item.sku)
        .maybeSingle();

      if (!variant) { skipped++; continue; }

      // Update price if missing or 0
      const updates: Record<string, unknown> = {};
      if ((variant.price == null || variant.price === 0) && item.price != null) {
        updates.price = item.price;
        pricesUpdated++;
      }
      if ((variant.cost == null || variant.cost === 0) && item.price != null) {
        const p = (updates.price as number | undefined) ?? item.price;
        updates.cost = Math.round(p * 0.5 * 100) / 100;
        costsUpdated++;
      }

      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        await supabase.from("warehouse_product_variants").update(updates).eq("id", variant.id);
      }

      // Add image if product has none
      if (item.image_url && variant.product_id) {
        const { count } = await supabase
          .from("warehouse_product_images")
          .select("id", { count: "exact", head: true })
          .eq("product_id", variant.product_id);

        if ((count ?? 0) === 0) {
          const { error: imgErr } = await supabase.from("warehouse_product_images").insert({
            product_id: variant.product_id,
            workspace_id: ws.id,
            src: item.image_url,
            alt: item.title,
            position: 0,
          });
          if (!imgErr) {
            await supabase
              .from("warehouse_products")
              .update({ images: [{ src: item.image_url }] })
              .eq("id", variant.product_id);
            imagesAdded++;
          } else {
            process.stdout.write(`!img(${imgErr.message}) `);
          }
        }
      }
    }
    process.stdout.write(`${items.length} items`);
  }

  console.log(`\n\nDone!`);
  console.log(`  Prices updated: ${pricesUpdated}`);
  console.log(`  Costs updated: ${costsUpdated}`);
  console.log(`  Images added: ${imagesAdded}`);
  console.log(`  Skipped (no variant): ${skipped}`);

  // Verify
  const { data: sample } = await supabase
    .from("bandcamp_product_mappings")
    .select("variant_id, warehouse_product_variants!inner(sku, price, cost)")
    .limit(5);
  console.log("\nSample after backfill:");
  for (const m of sample ?? []) {
    const v = m.warehouse_product_variants as any;
    console.log(`  ${v.sku}: price=$${v.price} cost=$${v.cost}`);
  }
}

main().catch(console.error);
