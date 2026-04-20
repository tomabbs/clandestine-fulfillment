// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: Use service_role for Trigger tasks
// Rule #12: Payloads are IDs only — tasks fetch their own data

import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";
import { normalizeShopifyProductId } from "@/lib/shared/shopify-id";

const payloadSchema = z.object({
  inboundItemIds: z.array(z.string().uuid()).min(1),
});

export const inboundProductCreate = task({
  id: "inbound-product-create",
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { inboundItemIds } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();
    const { SHOPIFY_STORE_URL, SHOPIFY_ADMIN_API_TOKEN, SHOPIFY_API_VERSION } = env();

    // Fetch inbound items with their shipment data for org context
    const { data: items, error: itemsError } = await supabase
      .from("warehouse_inbound_items")
      .select("*, warehouse_inbound_shipments!inner(org_id, workspace_id)")
      .in("id", inboundItemIds);

    if (itemsError || !items?.length) {
      throw new Error(`Failed to fetch inbound items: ${itemsError?.message ?? "no items found"}`);
    }

    const results: { itemId: string; productId: string | null; error: string | null }[] = [];

    for (const item of items) {
      try {
        const shipment = item.warehouse_inbound_shipments as {
          org_id: string;
          workspace_id: string;
        };

        // Rule #1: productSet for CREATE only with complete payloads
        // Rule #8: One Shopify product per SKU
        const productSetInput = {
          title: item.sku.startsWith("PENDING-") ? `New Inbound Item (${item.sku})` : item.sku,
          status: "DRAFT",
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: [
            {
              optionValues: [{ optionName: "Title", name: "Default Title" }],
              sku: item.sku,
              inventoryPolicy: "DENY",
            },
          ],
        };

        const response = await fetch(
          `${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
            },
            body: JSON.stringify({
              query: `mutation productSet($input: ProductSetInput!) {
                productSet(input: $input) {
                  product {
                    id
                    variants(first: 1) {
                      edges {
                        node {
                          id
                          sku
                        }
                      }
                    }
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
              variables: { input: productSetInput },
            }),
          },
        );

        const json = (await response.json()) as {
          data?: {
            productSet?: {
              product?: {
                id: string;
                variants: { edges: { node: { id: string; sku: string } }[] };
              };
              userErrors?: { field: string[]; message: string }[];
            };
          };
        };

        const productSetResult = json.data?.productSet;

        if (productSetResult?.userErrors?.length) {
          const errorMsg = productSetResult.userErrors.map((e) => e.message).join(", ");
          results.push({ itemId: item.id, productId: null, error: errorMsg });
          continue;
        }

        const shopifyProduct = productSetResult?.product;
        if (!shopifyProduct) {
          results.push({ itemId: item.id, productId: null, error: "No product returned" });
          continue;
        }

        const shopifyVariant = shopifyProduct.variants.edges[0]?.node;

        // Create warehouse product and variant records
        const { data: product, error: productError } = await supabase
          .from("warehouse_products")
          .insert({
            workspace_id: shipment.workspace_id,
            org_id: shipment.org_id,
            shopify_product_id: normalizeShopifyProductId(shopifyProduct.id),
            title: item.sku.startsWith("PENDING-") ? `New Inbound Item (${item.sku})` : item.sku,
            status: "draft",
            tags: ["inbound-created"],
          })
          .select("id")
          .single();

        if (productError || !product) {
          results.push({
            itemId: item.id,
            productId: null,
            error: `DB product insert failed: ${productError?.message}`,
          });
          continue;
        }

        const { data: variant, error: variantError } = await supabase
          .from("warehouse_product_variants")
          .insert({
            product_id: product.id,
            workspace_id: shipment.workspace_id,
            sku: item.sku,
            shopify_variant_id: shopifyVariant?.id ?? null,
            title: "Default Title",
            weight_unit: "lb",
          })
          .select("id")
          .single();

        if (variantError || !variant) {
          results.push({
            itemId: item.id,
            productId: product.id,
            error: `DB variant insert failed: ${variantError?.message ?? "no data returned"}`,
          });
          continue;
        }

        const { error: levelError } = await supabase.from("warehouse_inventory_levels").insert({
          variant_id: variant.id,
          workspace_id: shipment.workspace_id,
          sku: item.sku,
          available: 0,
          committed: 0,
          incoming: item.expected_quantity ?? 0,
        });

        if (levelError) {
          console.error(
            `[inbound-product-create] Failed to create inventory level for SKU ${item.sku}: ${levelError.message}`,
          );
        }

        results.push({ itemId: item.id, productId: product.id, error: null });
      } catch (err) {
        results.push({
          itemId: item.id,
          productId: null,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    // Create review queue items for any failures
    const failures = results.filter((r) => r.error);
    if (failures.length > 0) {
      const firstItem = items[0];
      const shipment = firstItem.warehouse_inbound_shipments as {
        workspace_id: string;
        org_id: string;
      };

      for (const failure of failures) {
        await supabase.from("warehouse_review_queue").insert({
          workspace_id: shipment.workspace_id,
          org_id: shipment.org_id,
          category: "inbound_product_create_failure",
          severity: "medium",
          title: `Failed to create product for inbound item ${failure.itemId}`,
          description: failure.error,
          metadata: { inbound_item_id: failure.itemId },
          status: "open",
          group_key: `inbound_product_create:${failure.itemId}`,
          occurrence_count: 1,
        });
      }
    }

    return {
      total: results.length,
      succeeded: results.filter((r) => !r.error).length,
      failed: failures.length,
      results,
    };
  },
});
