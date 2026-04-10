/**
 * Create Shopify DRAFT products for Bandcamp-only items in the warehouse DB.
 *
 * Only processes products that:
 * - Have NO shopify_product_id (not already in Shopify)
 * - Have at least one variant with a SKU
 *
 * Uses productSet (Rule #1: CREATE only) with complete payloads.
 *
 * Usage:
 *   npx tsx scripts/push-bandcamp-to-shopify.ts --dry-run
 *   npx tsx scripts/push-bandcamp-to-shopify.ts --apply
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (!apply && !dryRun) {
  console.error("Usage: npx tsx scripts/push-bandcamp-to-shopify.ts [--dry-run|--apply]");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SHOPIFY_URL = process.env.SHOPIFY_STORE_URL!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN!;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01";

async function shopifyProductSetCreate(input: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`${SHOPIFY_URL}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({
      query: `mutation ProductSet($input: ProductSetInput!) {
        productSet(input: $input) {
          product {
            id
            variants(first: 10) { edges { node { id sku } } }
          }
          userErrors { field message }
        }
      }`,
      variables: { input },
    }),
  });

  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: {
      productSet?: {
        product?: { id: string; variants: { edges: { node: { id: string; sku: string } }[] } };
        userErrors?: { field: string[]; message: string }[];
      };
    };
  };

  if (json.data?.productSet?.userErrors?.length) {
    console.error("  Shopify errors:", json.data.productSet.userErrors.map((e) => e.message).join(", "));
    return null;
  }

  return json.data?.productSet?.product?.id ?? null;
}

async function fetchAll(table: string, select: string) {
  let all: Record<string, unknown>[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from(table).select(select).range(page * 1000, (page + 1) * 1000 - 1);
    if (!data || data.length === 0) break;
    all = all.concat(data as unknown as Record<string, unknown>[]);
    page++;
  }
  return all;
}

async function main() {
  console.log(`\nPush Bandcamp-Only Products to Shopify — ${dryRun ? "DRY RUN" : "APPLY MODE"}\n`);

  const products = await fetchAll("warehouse_products",
    "id, title, vendor, product_type, status, shopify_product_id, description_html");
  const variants = await fetchAll("warehouse_product_variants",
    "id, sku, title, price, cost, weight, weight_unit, barcode, format_name, product_id, shopify_variant_id");
  const images = await fetchAll("warehouse_product_images",
    "product_id, src, alt, position");

  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const pid = v.product_id as string;
    if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
    variantsByProduct.get(pid)!.push(v);
  }

  const imagesByProduct = new Map<string, typeof images>();
  for (const img of images) {
    const pid = img.product_id as string;
    if (!imagesByProduct.has(pid)) imagesByProduct.set(pid, []);
    imagesByProduct.get(pid)!.push(img);
  }

  const bcOnly = products.filter((p) => !p.shopify_product_id);
  const withVariants = bcOnly.filter((p) => {
    const pvs = variantsByProduct.get(p.id as string) ?? [];
    return pvs.some((v) => v.sku);
  });

  console.log(`Total products without Shopify ID: ${bcOnly.length}`);
  console.log(`With at least one SKU variant: ${withVariants.length}`);

  let created = 0;
  let failed = 0;
  let skipped = 0;

  for (const product of withVariants) {
    const pvs = variantsByProduct.get(product.id as string) ?? [];
    const pimgs = (imagesByProduct.get(product.id as string) ?? [])
      .sort((a, b) => (a.position as number) - (b.position as number));

    const variantsWithSku = pvs.filter((v) => v.sku);
    if (variantsWithSku.length === 0) { skipped++; continue; }

    const productInput: Record<string, unknown> = {
      title: product.title as string,
      status: "DRAFT",
      vendor: product.vendor as string,
      productType: (product.product_type as string) ?? "Merch",
      productOptions: [{ name: "Title", values: variantsWithSku.map((v) => ({ name: (v.title as string) || "Default Title" })) }],
      variants: variantsWithSku.map((v) => ({
        optionValues: [{ optionName: "Title", name: (v.title as string) || "Default Title" }],
        sku: v.sku as string,
        price: v.price != null ? String(v.price) : undefined,
        inventoryPolicy: "DENY",
        ...(v.barcode ? { barcode: v.barcode as string } : {}),
        ...(v.weight ? {
          inventoryItem: {
            measurement: {
              weight: { value: v.weight as number, unit: ((v.weight_unit as string) ?? "lb").toUpperCase() },
            },
          },
        } : {}),
      })),
    };

    if ((product.description_html as string)?.trim()) {
      productInput.descriptionHtml = product.description_html as string;
    }

    if (dryRun) {
      console.log(`[DRY] ${product.title} | ${variantsWithSku.length} variant(s)`);
      created++;
      continue;
    }

    await new Promise((r) => setTimeout(r, 350));

    const shopifyProductId = await shopifyProductSetCreate(productInput);

    if (shopifyProductId) {
      await supabase
        .from("warehouse_products")
        .update({ shopify_product_id: shopifyProductId, updated_at: new Date().toISOString() })
        .eq("id", product.id as string);

      created++;
      if (created % 50 === 0) console.log(`  ... created ${created}/${withVariants.length}`);
    } else {
      failed++;
      console.error(`  FAILED: ${product.title} (${variantsWithSku[0]?.sku})`);
    }
  }

  if (apply) {
    const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
    await supabase.from("channel_sync_log").insert({
      workspace_id: ws?.id,
      channel: "shopify",
      sync_type: "bandcamp_to_shopify_push",
      status: failed > 0 ? "partial" : "completed",
      items_processed: created,
      items_failed: failed,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
  }

  console.log(`\n=== PUSH SUMMARY (${dryRun ? "DRY RUN" : "APPLIED"}) ===`);
  console.log(`Products processed: ${withVariants.length}`);
  console.log(`Created in Shopify:  ${created}`);
  console.log(`Failed:              ${failed}`);
  console.log(`Skipped:             ${skipped}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
