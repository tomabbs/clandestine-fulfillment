/**
 * One-time backfill: push all warehouse_product_images with shopify_image_id = NULL
 * to their corresponding Shopify product via productCreateMedia.
 *
 * Safe to re-run — only processes rows where shopify_image_id IS NULL.
 * On success, writes the returned Shopify media ID back to the DB row.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const SHOPIFY_ENDPOINT = `${process.env.SHOPIFY_STORE_URL}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

const BATCH_DELAY_MS = 600; // ~1.6 products/sec — well under Shopify's 40 req/s

async function shopifyGql(query, variables) {
  const res = await fetch(SHOPIFY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After") ?? 2) * 1000;
    console.warn(`  ⏳ Rate limited — waiting ${wait}ms`);
    await sleep(wait);
    return shopifyGql(query, variables);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(", "));
  return json.data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toGid(numericId) {
  return numericId.startsWith("gid://") ? numericId : `gid://shopify/Product/${numericId}`;
}

const CREATE_MEDIA = `
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id status }
      mediaUserErrors { field message }
    }
  }
`;

async function main() {
  // 1. Load all pending images joined to their product's shopify_product_id
  const { data: images, error } = await supabase
    .from("warehouse_product_images")
    .select("id, product_id, src, alt, position")
    .is("shopify_image_id", null)
    .order("product_id")
    .order("position");

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  // 2. Load shopify_product_id for all affected products
  const productIds = [...new Set(images.map((i) => i.product_id))];
  const { data: products, error: pErr } = await supabase
    .from("warehouse_products")
    .select("id, shopify_product_id, title")
    .in("id", productIds);

  if (pErr) throw new Error(`Supabase products query failed: ${pErr.message}`);

  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

  // 3. Group images by product
  const byProduct = {};
  for (const img of images) {
    if (!byProduct[img.product_id]) byProduct[img.product_id] = [];
    byProduct[img.product_id].push(img);
  }

  const productEntries = Object.entries(byProduct);
  console.log(`\n📦 Backfilling ${images.length} images across ${productEntries.length} products\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < productEntries.length; i++) {
    const [productId, imgs] = productEntries[i];
    const product = productMap[productId];

    if (!product?.shopify_product_id) {
      console.log(`  ⚠️  [${i + 1}/${productEntries.length}] SKIP (no Shopify ID): ${product?.title ?? productId}`);
      skipped++;
      continue;
    }

    try {
      const gid = toGid(product.shopify_product_id);
      const media = imgs.map((img) => ({
        originalSource: img.src,
        alt: img.alt ?? "",
        mediaContentType: "IMAGE",
      }));

      const data = await shopifyGql(CREATE_MEDIA, { productId: gid, media });
      const errs = data.productCreateMedia.mediaUserErrors;

      if (errs.length > 0) {
        console.error(`  ❌ [${i + 1}/${productEntries.length}] Shopify error for "${product.title}": ${errs.map((e) => e.message).join(", ")}`);
        failed++;
      } else {
        // Write returned Shopify media IDs back to DB rows
        const returnedMedia = data.productCreateMedia.media ?? [];
        for (let j = 0; j < imgs.length; j++) {
          const shopifyMediaId = returnedMedia[j]?.id;
          if (shopifyMediaId) {
            const numericId = shopifyMediaId.replace(/^gid:\/\/shopify\/MediaImage\//, "");
            await supabase
              .from("warehouse_product_images")
              .update({ shopify_image_id: numericId })
              .eq("id", imgs[j].id);
          }
        }
        console.log(`  ✅ [${i + 1}/${productEntries.length}] ${imgs.length} image(s) → "${product.title}"`);
        ok++;
      }
    } catch (err) {
      console.error(`  ❌ [${i + 1}/${productEntries.length}] Exception for "${product?.title}": ${err.message}`);
      failed++;
    }

    if (i < productEntries.length - 1) await sleep(BATCH_DELAY_MS);
  }

  console.log(`\n📊 Done: ${ok} pushed, ${skipped} skipped (no Shopify ID), ${failed} failed`);
  if (failed > 0) console.log("   Re-run the script to retry failures (only rows with shopify_image_id=null are processed).");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
