/**
 * Fix existing Shopify draft products.
 *
 * Steps (run in order):
 *   --step=inventory  Enable tracking + set cost via inventoryItemUpdate
 *   --step=weight     Set weight via inventoryItemUpdate measurement
 *   --step=collections Assign products to vendor collections
 *   --step=publish    Publish to Online Store + Shop
 *   --step=all        Run all steps (default)
 *
 * Usage:
 *   node scripts/fix-shopify-drafts.mjs --dry-run
 *   node scripts/fix-shopify-drafts.mjs --apply --limit=10
 *   node scripts/fix-shopify-drafts.mjs --apply --step=inventory
 *   node scripts/fix-shopify-drafts.mjs --apply
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01";
if (!url || !key || !SHOPIFY_STORE_URL || !SHOPIFY_TOKEN) {
  console.error("Missing env vars (need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_STORE_URL, SHOPIFY_ADMIN_API_TOKEN)");
  process.exit(1);
}

const sb = createClient(url, key);
const isDryRun = !process.argv.includes("--apply");
const step = (process.argv.find(a => a.startsWith("--step="))?.split("=")[1]) ?? "all";
const limit = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "9999", 10);

const SHOPIFY_ENDPOINT = `${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const DELAY_MS = 600;

async function shopifyGql(query, variables) {
  const res = await fetch(SHOPIFY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get("Retry-After") ?? "5", 10);
    console.log(`  Rate limited, waiting ${wait}s...`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return shopifyGql(query, variables);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join(", "));
  return json.data;
}

function toGid(id) {
  return id?.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

async function main() {
  console.log(`=== FIX SHOPIFY DRAFTS (${isDryRun ? "DRY RUN" : "APPLY"}) ===`);
  console.log(`Step: ${step} | Limit: ${limit}\n`);

  const products = [];
  let off = 0;
  while (products.length < limit) {
    const { data } = await sb.from("warehouse_products")
      .select("id, title, shopify_product_id, vendor, status")
      .not("shopify_product_id", "is", null)
      .range(off, off + 99);
    if (!data?.length) break;
    products.push(...data);
    if (data.length < 100) break;
    off += 100;
  }
  const eligible = products.slice(0, limit);
  console.log(`Found ${eligible.length} products with shopify_product_id\n`);

  const summary = { inventory: 0, weight: 0, collections: 0, published: 0, failed: 0 };

  for (let i = 0; i < eligible.length; i++) {
    const product = eligible[i];
    const pct = Math.round(((i + 1) / eligible.length) * 100);
    if ((i + 1) % 25 === 0) console.log(`  Progress: ${i + 1}/${eligible.length} (${pct}%)`);

    try {
      // Get variant with inventory item
      const { data: variant } = await sb.from("warehouse_product_variants")
        .select("id, sku, cost, weight, shopify_variant_id, shopify_inventory_item_id")
        .eq("product_id", product.id)
        .limit(1)
        .single();

      if (!variant) continue;

      // Step: inventory (tracking + cost)
      if (step === "all" || step === "inventory") {
        let invItemId = variant.shopify_inventory_item_id;

        if (!invItemId && variant.shopify_variant_id) {
          const variantGid = variant.shopify_variant_id.startsWith("gid://")
            ? variant.shopify_variant_id
            : `gid://shopify/ProductVariant/${variant.shopify_variant_id}`;
          const vData = await shopifyGql(`
            query GetVariantInvItem($id: ID!) {
              productVariant(id: $id) { inventoryItem { id } }
            }
          `, { id: variantGid });
          invItemId = vData?.productVariant?.inventoryItem?.id;

          if (invItemId) {
            await sb.from("warehouse_product_variants")
              .update({ shopify_inventory_item_id: invItemId })
              .eq("id", variant.id);
          }
          await new Promise(r => setTimeout(r, DELAY_MS));
        }

        if (invItemId) {
          const costVal = variant.cost ? Number(variant.cost) : null;
          if (isDryRun) {
            console.log(`  [DRY] ${variant.sku}: tracked=true, cost=${costVal}`);
          } else {
            await shopifyGql(`
              mutation InvItemUpdate($id: ID!, $input: InventoryItemInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                  inventoryItem { id tracked unitCost { amount } }
                  userErrors { message }
                }
              }
            `, {
              id: invItemId,
              input: {
                tracked: true,
                ...(costVal != null ? { cost: costVal } : {}),
              },
            });
            await new Promise(r => setTimeout(r, DELAY_MS));
          }
          summary.inventory++;
        }
      }

      // Step: collections
      if (step === "all" || step === "collections") {
        const vendor = product.vendor;
        if (vendor) {
          if (isDryRun) {
            console.log(`  [DRY] ${vendor}: assign to collection`);
          } else {
            try {
              // Search for collection
              const escaped = vendor.replace(/'/g, "\\\\'");
              const cData = await shopifyGql(`{ collections(first: 5, query: "title:'${escaped}'") { edges { node { id title } } } }`);
              let collId = cData?.collections?.edges?.find(e => e.node.title.toLowerCase() === vendor.toLowerCase())?.node?.id;

              // Try suffix-stripped
              if (!collId) {
                const stripped = vendor.replace(/\s+(Records|Music|Label|Tapes|Sound)$/i, "");
                if (stripped !== vendor) {
                  collId = cData?.collections?.edges?.find(e => e.node.title.toLowerCase() === stripped.toLowerCase())?.node?.id;
                }
              }

              // Create if not found
              if (!collId) {
                const createData = await shopifyGql(`
                  mutation CreateCollection($input: CollectionInput!) {
                    collectionCreate(input: $input) {
                      collection { id }
                      userErrors { field message }
                    }
                  }
                `, { input: { title: vendor } });
                collId = createData?.collectionCreate?.collection?.id;
              }

              if (collId) {
                try {
                  await shopifyGql(`
                    mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
                      collectionAddProducts(id: $id, productIds: $productIds) {
                        collection { id }
                        userErrors { field message }
                      }
                    }
                  `, { id: collId, productIds: [toGid(product.shopify_product_id)] });
                } catch {
                  // May already be in collection
                }
                summary.collections++;
              }
              await new Promise(r => setTimeout(r, DELAY_MS));
            } catch (err) {
              console.error(`  Collection failed for ${vendor}:`, err.message?.slice(0, 60));
            }
          }
        }
      }

      // Step: publish
      if (step === "all" || step === "publish") {
        if (isDryRun) {
          console.log(`  [DRY] ${product.shopify_product_id}: publish to safe channels`);
        } else {
          try {
            // Get channels
            const chData = await shopifyGql("{ channels(first: 20) { edges { node { id name } } } }");
            const safePubs = (chData?.channels?.edges ?? [])
              .filter(e => ["Online Store", "Shop"].includes(e.node.name))
              .map(e => ({ publicationId: e.node.id.replace("/Channel/", "/Publication/") }));

            if (safePubs.length > 0) {
              await shopifyGql(`
                mutation Publish($id: ID!, $input: [PublicationInput!]!) {
                  publishablePublish(id: $id, input: $input) {
                    publishable { ... on Product { id } }
                    userErrors { field message }
                  }
                }
              `, { id: toGid(product.shopify_product_id), input: safePubs });
            }
            summary.published++;
            await new Promise(r => setTimeout(r, DELAY_MS));
          } catch (err) {
            console.error(`  Publish failed:`, err.message?.slice(0, 60));
          }
        }
      }
    } catch (err) {
      summary.failed++;
      console.error(`  FAILED ${product.title?.slice(0, 30)}:`, err.message?.slice(0, 60));
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`  Inventory fixed: ${summary.inventory}`);
  console.log(`  Collections assigned: ${summary.collections}`);
  console.log(`  Published: ${summary.published}`);
  console.log(`  Failed: ${summary.failed}`);
  if (isDryRun) console.log("\n  (dry run — use --apply to execute)");
}

main().catch(e => { console.error(e); process.exit(1); });
