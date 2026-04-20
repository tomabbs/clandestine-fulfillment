// Shopify product/variant ID normalization helper.
//
// Background:
// Shopify exposes product IDs in two formats depending on which API is used:
//   - REST Admin API:    "9947238072635" (numeric string)
//   - GraphQL Admin API: "gid://shopify/Product/9947238072635" (Global Object ID)
//
// Both are valid identifiers for the SAME object — but treated as different
// strings by string-equality comparisons (which is what every dedup index +
// lookup in our DB uses).
//
// Mixed-format storage caused a real production bug (2026-04-20):
// 1,452 duplicate `warehouse_products` groups (2,905 rows total) accumulated
// because two sync code paths stored different formats for the same product.
//
// Fix: normalize to the SHORT (numeric) form everywhere — at write time AND
// at lookup time. The numeric form is:
//   - Backward compatible with the older sync data (less to backfill on the
//     other axis)
//   - Shorter (better for index size + URL params if ever surfaced)
//   - Trivially convertible BACK to GID via `toShopifyProductGid()` for any
//     code that needs to call GraphQL with it.

const PRODUCT_GID_PREFIX = "gid://shopify/Product/";
const VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

/**
 * Convert a Shopify product ID (either format) to the canonical numeric
 * string form used in our DB.
 *
 *   normalizeShopifyProductId("gid://shopify/Product/123")  // "123"
 *   normalizeShopifyProductId("123")                        // "123"
 *   normalizeShopifyProductId(null)                         // null
 */
export function normalizeShopifyProductId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith(PRODUCT_GID_PREFIX)) return id.slice(PRODUCT_GID_PREFIX.length);
  return id;
}

/**
 * Convert a numeric Shopify product ID back to a GraphQL GID.
 * Used when calling Shopify's GraphQL API with an ID we have stored.
 *
 *   toShopifyProductGid("123")                       // "gid://shopify/Product/123"
 *   toShopifyProductGid("gid://shopify/Product/123") // "gid://shopify/Product/123"
 */
export function toShopifyProductGid(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith(PRODUCT_GID_PREFIX)) return id;
  return PRODUCT_GID_PREFIX + id;
}

/**
 * Same idea but for variant IDs.
 */
export function normalizeShopifyVariantId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith(VARIANT_GID_PREFIX)) return id.slice(VARIANT_GID_PREFIX.length);
  return id;
}

export function toShopifyVariantGid(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith(VARIANT_GID_PREFIX)) return id;
  return VARIANT_GID_PREFIX + id;
}
