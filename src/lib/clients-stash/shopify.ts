"use server";

import { env } from "@/lib/shared/env";

// Minimal Shopify Admin API client for product mutations.
// Rule #1: NEVER use productSet for edits. Use productUpdate + productVariantsBulkUpdate.

interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function shopifyAdmin<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { SHOPIFY_STORE_URL, SHOPIFY_ADMIN_API_TOKEN, SHOPIFY_API_VERSION } = env();
  const url = `${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as ShopifyGraphQLResponse<T>;

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("Shopify returned no data");
  }

  return json.data;
}

// Rule #1: productUpdate for editing existing products (NOT productSet)
export async function productUpdate(input: {
  id: string;
  title?: string;
  productType?: string;
  tags?: string[];
}) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          title
          productType
          tags
          updatedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyAdmin<{
    productUpdate: {
      product: {
        id: string;
        title: string;
        productType: string;
        tags: string[];
        updatedAt: string;
      };
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (result.productUpdate.userErrors.length > 0) {
    throw new Error(
      `productUpdate errors: ${result.productUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  return result.productUpdate.product;
}

// Rule #1: productVariantsBulkUpdate for editing variants (NOT productSet)
export async function productVariantsBulkUpdate(
  productId: string,
  variants: Array<{
    id: string;
    price?: string;
    compareAtPrice?: string | null;
    weight?: number;
  }>,
) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          compareAtPrice
          weight
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyAdmin<{
    productVariantsBulkUpdate: {
      productVariants: Array<{
        id: string;
        price: string;
        compareAtPrice: string | null;
        weight: number;
      }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { productId, variants });

  if (result.productVariantsBulkUpdate.userErrors.length > 0) {
    throw new Error(
      `productVariantsBulkUpdate errors: ${result.productVariantsBulkUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  return result.productVariantsBulkUpdate.productVariants;
}
