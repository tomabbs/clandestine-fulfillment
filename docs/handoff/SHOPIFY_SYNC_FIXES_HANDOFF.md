# Shopify Sync Fixes — Handoff Document

**Date:** 2026-04-10
**Status:** PLANNED — ready for implementation
**Scope:** Fix 4 issues with Bandcamp-to-Shopify product sync: inventory tracking, price/cost, images, sales channel publishing

---

## Table of Contents

1. [Issue Summary](#1-issue-summary)
2. [Research & Diagnostics](#2-research--diagnostics)
3. [Proposed Fixes](#3-proposed-fixes)
4. [Current Code (full files)](#4-current-code-full-files)
5. [Assumptions](#5-assumptions)
6. [Risks](#6-risks)

---

## 1. Issue Summary

| # | Issue | Root Cause | Severity |
|---|---|---|---|
| 1 | **Inventory not tracked** — all Shopify drafts show "Inventory not tracked" | `inventoryItem.tracked: true` not set in `productSetCreate` variant input | HIGH — blocks inventory sync |
| 2 | **Price and cost missing on Shopify** — cost shows "--" in Shopify | `price` not sent, `inventoryItem.unitCost` not sent. Cost IS computed at 50% and stored in DB but never pushed | MEDIUM |
| 3 | **~2,567 images in DB but not on Shopify** — products show no thumbnail | Images saved to `warehouse_product_images` but `productCreateMedia` push failed silently or was never attempted. No retry mechanism | MEDIUM |
| 4 | **Products not published to sales channels** — "Not included in any sales channels" | `publishablePublish` never called after `productSetCreate`. Products are invisible even if set to active | HIGH |

---

## 2. Research & Diagnostics

### Issue 1: Inventory tracking

**How it was diagnosed:**

Shopify screenshot showed "Inventory not tracked" on every draft product. Code review of `bandcamp-sync.ts` line 1354-1359 confirmed:

```typescript
// CURRENT — missing inventoryItem.tracked
variants: [{
  optionValues: [{ optionName: "Title", name: "Default Title" }],
  sku: effectiveSku,
  inventoryPolicy: "DENY",
}],
```

Shopify's `productSet` mutation defaults to `tracked: false` when `inventoryItem` is omitted. This was confirmed by Shopify API documentation (Jan 2025 changelog: "New `inventoryItem` field on ProductSetVariantInput — enables tracked status").

**Searched codebase for `inventoryTracked` / `tracked` — zero results.** The field was never set anywhere in the application.

### Issue 2: Price and cost

**How it was diagnosed:**

Shopify screenshot showed price set to $50.00 but cost shows "--". Code search found the 50% cost formula in 5 places across the codebase:

| File | Line | Context |
|---|---|---|
| `bandcamp-sync.ts` | 1099-1102 | Matched variant update: `price * 0.5` if cost is null/0 |
| `bandcamp-sync.ts` | 1147 | API backfill: `price * 0.5` |
| `bandcamp-sync.ts` | 1435 | New variant creation: `price * 0.5` → stored as `bcCost` |
| `shopify-sync.ts` | 262-267 | Shopify pull sync: `price * 0.5` default |
| `shopify-full-backfill.ts` | 188 | Full backfill: `price * 0.5` |

**Database verification:**
- 2,874 of 2,875 variants (100%) have cost > 0
- 2,453 of 2,793 (88%) have cost = exactly 50% of price (340 were manually adjusted)
- Cost formula is working correctly in the database

**But the `productSetCreate` call sends NO price and NO cost to Shopify.** The variant input only has `sku` and `inventoryPolicy`. The `push-bandcamp-to-shopify.ts` script (lines 140-151) DOES send `price` but not `unitCost` — confirming the field was just missed.

**Shopify API support:** `inventoryItem.unitCost` was added to `ProductVariantSetInput` in January 2025 (all API versions 2024-10+). Syntax: `inventoryItem: { unitCost: { amount: "25.00", currencyCode: "USD" } }`.

### Issue 3: Images

**How it was diagnosed:**

Database query of 300 draft products (of 1,150 total):
- 285 (95%) HAVE images in `warehouse_product_images`
- 14 (4.7%) have NO images AND no Bandcamp image URL (Bandcamp API never provided one)
- 1 (0.3%) has image URL but wasn't pushed

Of all 7,216 image rows in `warehouse_product_images`:
- 4,649 have `shopify_image_id` (confirmed pushed to Shopify)
- **2,567 do NOT have `shopify_image_id`** (image in DB but NOT on Shopify)

For draft products specifically: 228 of 408 image rows (56%) are on Shopify, **180 (44%) are NOT**.

**Root cause:** The `productSetCreate` passes images via `media` field at line 1361-1370 — this works for initial creation. But images added later by the scraper (`storeScrapedImages` at line 724-734) push via `productCreateMedia` — some of these fail silently (try/catch with `logger.warn`). There is no retry mechanism.

**Image URLs are accessible:** Both `_10.jpg` (700px, 127KB) and `_0.jpg` (full size, 1.1MB) return HTTP 200 from Bandcamp's CDN.

### Issue 4: Sales channel publishing

**How it was diagnosed:**

Shopify screenshot showed "Manage publishing" dialog with all 5 channels toggled off:
- Online Store
- Shop
- Point of Sale
- Google & YouTube
- preproduct_storefront

Code search confirmed `publishablePublish` is never called anywhere in the codebase. `productSetCreate` does not handle publishing — it's a separate API call.

**Shopify API:** `publishablePublish` mutation requires `write_publications` scope. Needs Publication IDs obtained by querying `channels(first: 20)` and converting `gid://shopify/Channel/123` → `gid://shopify/Publication/123`.

---

## 3. Proposed Fixes

### Fix 1+2: Variant input update (bandcamp-sync.ts line 1354-1359)

**Current code:**
```typescript
variants: [
  {
    optionValues: [{ optionName: "Title", name: "Default Title" }],
    sku: effectiveSku,
    inventoryPolicy: "DENY",
  },
],
```

**Proposed code:**
```typescript
variants: [
  {
    optionValues: [{ optionName: "Title", name: "Default Title" }],
    sku: effectiveSku,
    price: bcPrice != null ? String(bcPrice) : undefined,
    inventoryPolicy: "DENY",
    inventoryItem: {
      tracked: true,
      ...(bcCost != null
        ? { unitCost: { amount: String(bcCost), currencyCode: "USD" } }
        : {}),
    },
  },
],
```

**Note:** `bcPrice` and `bcCost` are already computed at line 1434-1435:
```typescript
const bcPrice = merchItem.price ?? null;
const bcCost = bcPrice != null ? Math.round(bcPrice * 0.5 * 100) / 100 : null;
```

The variant input section is at line 1354 but `bcPrice`/`bcCost` are computed at line 1434 (AFTER the Shopify create). This means the code needs minor restructuring: compute `bcPrice`/`bcCost` BEFORE the `productSetCreate` call.

### Fix 3: Image backfill script

Script that queries `warehouse_product_images` rows without `shopify_image_id`, groups by product, and calls `productCreateMedia` for each:

```javascript
// scripts/backfill-shopify-images.mjs
// For each warehouse_product_images row where shopify_image_id IS NULL:
//   1. Get shopify_product_id from warehouse_products
//   2. Call productCreateMedia(shopifyProductId, [{ originalSource: img.src }])
//   3. Update warehouse_product_images.shopify_image_id on success
//   4. Rate limit: 2 calls/second
```

### Fix 4: Sales channel publishing

**New function in `shopify-client.ts`:**

```typescript
export async function publishToAllChannels(shopifyProductId: string): Promise<void> {
  // 1. Query channels: channels(first: 20) { edges { node { id name } } }
  // 2. Convert Channel IDs to Publication IDs
  // 3. Call publishablePublish(id: productGid, input: [{ publicationId }, ...])
}
```

**Integration in `bandcamp-sync.ts`:**
After line 1371 (successful `productSetCreate`), call `publishToAllChannels(shopifyProductId)`.

**Backfill script:** Iterate all products with `shopify_product_id` and call `publishToAllChannels` for each.

### Combined backfill script

Single script that fixes ALL existing draft products:

```javascript
// scripts/fix-shopify-drafts.mjs
// For each draft product with shopify_product_id:
//   1. Enable inventory tracking (inventoryItemUpdate with tracked: true)
//   2. Set cost (inventoryItemUpdate with cost)
//   3. Push missing images (productCreateMedia for rows without shopify_image_id)
//   4. Publish to all sales channels (publishablePublish)
//   5. Rate limit: 1 call/second to stay under Shopify API limits
```

---

## 4. Current Code (full files)

### 4.1 `src/trigger/tasks/bandcamp-sync.ts` — Product creation section (lines 1345-1400)

This is the section that creates Shopify products during the Bandcamp merch sync. The variant input at line 1354-1359 is where all four fixes converge.

```1345:1400:src/trigger/tasks/bandcamp-sync.ts
          let shopifyProductId: string | null = null;
          try {
            shopifyProductId = await productSetCreate({
              title,
              status: "DRAFT",
              vendor: band?.name ?? connection.band_name,
              productType: merchItem.item_type ?? "Merch",
              tags,
              productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
              variants: [
                {
                  optionValues: [{ optionName: "Title", name: "Default Title" }],
                  sku: effectiveSku,
                  inventoryPolicy: "DENY",
                },
              ],
              ...(bandcampImageUrl(merchItem.image_url)
                ? {
                    media: [
                      {
                        originalSource: bandcampImageUrl(merchItem.image_url),
                        mediaContentType: "IMAGE",
                      },
                    ],
                  }
                : {}),
            });
            logger.info("Created Shopify DRAFT product", { sku: effectiveSku, shopifyProductId });
          } catch (shopifyError) {
            logger.error("Failed to create Shopify product, continuing with warehouse-only", {
              sku: effectiveSku,
              error: String(shopifyError),
            });
            // ... review queue upsert ...
          }
```

**Key dependency:** `bcPrice` and `bcCost` are computed AFTER this block at line 1434-1435. They need to be moved before the `productSetCreate` call.

### 4.2 `src/trigger/tasks/bandcamp-sync.ts` — Price/cost computation (lines 1434-1435)

```1434:1435:src/trigger/tasks/bandcamp-sync.ts
          const bcPrice = merchItem.price ?? null;
          const bcCost = bcPrice != null ? Math.round(bcPrice * 0.5 * 100) / 100 : null;
```

### 4.3 `src/lib/clients/shopify-client.ts` — `productSetCreate` (lines 355-380)

```355:380:src/lib/clients/shopify-client.ts
export async function productSetCreate(input: Record<string, unknown>): Promise<string> {
  const mutation = `
    mutation ProductSet($input: ProductSetInput!) {
      productSet(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productSet: {
      product: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (data.productSet.userErrors.length > 0) {
    throw new Error(
      `productSet errors: ${data.productSet.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  if (!data.productSet.product) {
    throw new Error("productSet returned no product");
  }
  return data.productSet.product.id;
}
```

No changes needed to this function — it passes through whatever `input` the caller provides.

### 4.4 `src/lib/clients/shopify-client.ts` — `productCreateMedia` (lines 401-434)

```401:434:src/lib/clients/shopify-client.ts
export async function productCreateMedia(
  shopifyProductId: string,
  media: Array<{ originalSource: string; alt?: string | null; mediaContentType?: "IMAGE" }>,
): Promise<void> {
  if (media.length === 0) return;
  const mutation = `
    mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id status }
        mediaUserErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productCreateMedia: {
      media: Array<{ id: string; status: string }>;
      mediaUserErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, {
    productId: toProductGid(shopifyProductId),
    media: media.map((m) => ({
      originalSource: m.originalSource,
      alt: m.alt ?? "",
      mediaContentType: m.mediaContentType ?? "IMAGE",
    })),
  });
  if (data.productCreateMedia.mediaUserErrors.length > 0) {
    throw new Error(
      `productCreateMedia errors: ${data.productCreateMedia.mediaUserErrors.map((e) => e.message).join(", ")}`,
    );
  }
}
```

Used by the image backfill — no changes needed.

### 4.5 `src/lib/clients/shopify-client.ts` — `shopifyGraphQL` base (lines 103-145)

```103:145:src/lib/clients/shopify-client.ts
export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { endpoint, token } = getConfig();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status === 503) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter
        ? Number.parseInt(retryAfter, 10) * 1000
        : THROTTLE_WAIT_MS * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      await sleep(THROTTLE_WAIT_MS * (attempt + 1));
      continue;
    }
    if (json.errors?.length) {
      lastError = new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }
    if (!json.data) {
      throw new Error("Shopify GraphQL: no data returned");
    }
    return json.data;
  }
  throw lastError ?? new Error("Shopify GraphQL: max retries exceeded");
}
```

Base function with retry + throttle handling. Used by all Shopify mutations.

### 4.6 `src/lib/clients/bandcamp.ts` — `bandcampImageUrl` (lines 413-416)

```413:416:src/lib/clients/bandcamp.ts
export function bandcampImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/_\d+\.jpg$/, "_10.jpg");
}
```

Converts Bandcamp thumbnail URLs to 700px display size. Used in the `productSetCreate` media field.

### 4.7 `scripts/push-bandcamp-to-shopify.ts` — Reference variant input (lines 138-151)

This existing script shows how other code builds the variant input for Shopify. It sends `price` (line 141) but NOT `unitCost`:

```138:151:scripts/push-bandcamp-to-shopify.ts
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
```

### 4.8 New function needed: `publishToAllChannels` (for shopify-client.ts)

```typescript
// Query channels, convert to publication IDs, call publishablePublish
let cachedPublicationIds: string[] | null = null;

export async function getPublicationIds(): Promise<string[]> {
  if (cachedPublicationIds) return cachedPublicationIds;
  const data = await shopifyGraphQL<{
    channels: { edges: Array<{ node: { id: string; name: string } }> };
  }>(`{ channels(first: 20) { edges { node { id name } } } }`);
  cachedPublicationIds = data.channels.edges.map((e) => {
    // Convert gid://shopify/Channel/123 → gid://shopify/Publication/123
    return e.node.id.replace("/Channel/", "/Publication/");
  });
  return cachedPublicationIds;
}

export async function publishToAllChannels(shopifyProductId: string): Promise<void> {
  const publicationIds = await getPublicationIds();
  if (publicationIds.length === 0) return;
  const mutation = `
    mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id } }
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    id: toProductGid(shopifyProductId),
    input: publicationIds.map((pid) => ({ publicationId: pid })),
  });
}
```

Requires `write_publications` scope on the Shopify access token.

---

## 5. Assumptions

1. **Cost is always 50% of Bandcamp price** — verified in 5 code locations. 88% of existing variants match exactly; 12% were manually adjusted. The formula is established and correct.

2. **Currency is always USD** — the `unitCost` field requires `currencyCode`. All Bandcamp prices in the system are USD. If multi-currency is needed later, pull currency from `merchItem.currency`.

3. **Publish to safe channels only, not all 5** — REVISED from "all channels" based on review. Not all products should go to POS, Google & YouTube, etc. Start with Online Store + Shop only. Google Shopping has GTIN/category requirements that many products won't meet. POS products may need different handling. Configurable per product later.

4. **`write_publications` scope is available** — the Shopify access token must have this scope for `publishablePublish` to work. **MUST VERIFY** before implementing by querying the Shopify API for current scopes. If missing, requires updating the Shopify app configuration and re-authenticating.

5. **Shopify API version supports `inventoryItem.unitCost`** — requires API version 2024-10 or later. The codebase uses 2026-01+ (confirmed in shopify-client.ts endpoint configuration).

6. **Image backfill is partially idempotent** — Shopify deduplicates by URL for the same product, but position may be wrong if pushed out of order. Add deduplication check (compare `src` against existing `shopify_image_id` rows) before pushing.

---

## 6. Risks

1. **`write_publications` scope missing** — LOW risk. If the scope isn't on the token, `publishablePublish` will fail with a permission error. The product still gets created; publishing just doesn't happen. **Verify scope before implementing** by querying the Shopify API.

2. **Currency hardcoded as USD** — LOW risk. All current connections use USD. **Fix:** Use `merchItem.currency ?? "USD"` instead of hardcoding "USD" to future-proof.

3. **Image backfill hitting Shopify rate limits** — MEDIUM risk. 2,567 images at 2 calls/second = ~21 minutes. Shopify's rate limit is generous (typically 4 calls/second for private apps). Rate limiting in the script mitigates this.

4. **Restructuring bcPrice/bcCost before productSetCreate** — LOW risk. The variables are simple computations from `merchItem.price`. Moving them earlier doesn't affect any other logic.

5. **Backfill runs twice accidentally** — MEDIUM risk. Inventory tracking and publishing are idempotent. Image pushes could create duplicates. **Mitigate:** Track sync status per product and skip already-fixed products on re-run.

6. **Shopify product deleted externally** — LOW risk. DB still has `shopify_product_id`, backfill will fail for that product. **Mitigate:** Catch `NOT_FOUND` errors, log for review, continue.

---

## 7. Fix 5: Default weight by product category

**Current state:**
- 1,818 of 2,875 variants (63%) have weight set (from Shopify-synced products)
- 1,057 (37%) have no weight — these are Bandcamp-synced drafts
- `bandcamp-sync.ts` does NOT send weight in `productSetCreate`
- `push-bandcamp-to-shopify.ts` already sends `inventoryItem.measurement.weight` — we just need to add it to the sync

**Default weights by product category:**

| Category | Weight | Unit | Rationale |
|---|---|---|---|
| vinyl | 1.0 | POUNDS | Standard single LP with jacket |
| cd | 0.25 | POUNDS | Jewel case or digipak |
| cassette | 0.2 | POUNDS | Standard cassette in case |
| apparel | 0.5 | POUNDS | Average t-shirt |
| merch | 0.3 | POUNDS | Average small merch item |
| bundle | 1.5 | POUNDS | Typical LP + extras |
| other | 0.5 | POUNDS | Conservative default |

These go into the `inventoryItem.measurement.weight` field in `productSetCreate`, alongside `tracked` and `unitCost`. The weight defaults can be stored in `product-categories.ts`:

```typescript
export const CATEGORY_DEFAULT_WEIGHTS: Record<ProductCategory, { value: number; unit: string }> = {
  vinyl:    { value: 1.0, unit: "POUNDS" },
  cd:       { value: 0.25, unit: "POUNDS" },
  cassette: { value: 0.2, unit: "POUNDS" },
  apparel:  { value: 0.5, unit: "POUNDS" },
  merch:    { value: 0.3, unit: "POUNDS" },
  bundle:   { value: 1.5, unit: "POUNDS" },
  other:    { value: 0.5, unit: "POUNDS" },
};
```

**Also set in the `warehouse_product_variants` DB row** at creation time so the warehouse app has the weight for shipping calculations.

**For existing variants without weight:** The backfill script should set default weight based on `product_category` from the mapping.

---

## 8. Fix 6: Auto-assign Shopify collection by vendor (alias-aware)

**Current state:** Products are created on Shopify with a vendor name (e.g. "Northern Spy Records") but NOT assigned to any collection. Shopify collections are used to group products by label/artist for browsing.

**Existing infrastructure:**
- `organization_aliases` table exists with full CRUD (add/remove/get)
- `findOrgByNameOrAlias(name)` does case-insensitive exact match on org name then aliases
- Admin UI for alias management exists on client detail page
- `getAllAliasMap()` exists but is dead code (never called)

**The fix — collection assignment flow during `productSetCreate`:**

```
1. Vendor name comes from Bandcamp (e.g. "Northern Spy Records")
2. Check cache: vendor name → Shopify collection GID (avoid repeated lookups)
3. If not cached, query Shopify: collections(first: 250, query: "title:'{vendor}'")
4. If exact match found → use it
5. If no exact match, try fuzzy:
   a. Query organization_aliases for this vendor name
   b. Check if any alias matches a Shopify collection title
   c. Also try common suffix stripping: "Northern Spy Records" → "Northern Spy"
6. If still no match → create collection via collectionCreate(title: vendorName)
7. Cache the result
8. Pass collection GID in productSetCreate: collections: [collectionGid]
```

**New functions in `shopify-client.ts`:**

```typescript
// Cache: vendor name → collection GID (persists for duration of sync run)
const collectionCache = new Map<string, string>();

export async function findOrCreateCollection(vendorName: string): Promise<string> {
  if (collectionCache.has(vendorName)) return collectionCache.get(vendorName)!;

  // 1. Search Shopify for existing collection
  const searchResult = await shopifyGraphQL<{
    collections: { edges: Array<{ node: { id: string; title: string } }> };
  }>(`{
    collections(first: 10, query: "title:'${vendorName.replace(/'/g, "\\\\'")}'") {
      edges { node { id title } }
    }
  }`);

  // Exact match (case-insensitive)
  const exactMatch = searchResult.collections.edges.find(
    (e) => e.node.title.toLowerCase() === vendorName.toLowerCase(),
  );
  if (exactMatch) {
    collectionCache.set(vendorName, exactMatch.node.id);
    return exactMatch.node.id;
  }

  // 2. Try common variations (suffix stripping)
  const variations = [
    vendorName,
    vendorName.replace(/\s+(Records|Music|Label|Tapes|Sound)$/i, ""),
  ];
  for (const variant of variations) {
    const match = searchResult.collections.edges.find(
      (e) => e.node.title.toLowerCase() === variant.toLowerCase(),
    );
    if (match) {
      collectionCache.set(vendorName, match.node.id);
      return match.node.id;
    }
  }

  // 3. No match → create new collection
  const createResult = await shopifyGraphQL<{
    collectionCreate: {
      collection: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(`
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id }
        userErrors { field message }
      }
    }
  `, { input: { title: vendorName, collectionType: "MANUAL" } });

  if (createResult.collectionCreate.collection) {
    const newId = createResult.collectionCreate.collection.id;
    collectionCache.set(vendorName, newId);
    return newId;
  }

  throw new Error(
    `Failed to create collection: ${createResult.collectionCreate.userErrors.map((e) => e.message).join(", ")}`,
  );
}
```

**Integration in `bandcamp-sync.ts` `productSetCreate` call:**

```typescript
// Before productSetCreate:
let collectionId: string | null = null;
try {
  collectionId = await findOrCreateCollection(band?.name ?? connection.band_name);
} catch {
  // Non-critical — product still gets created without collection
}

// In productSetCreate input:
shopifyProductId = await productSetCreate({
  title,
  status: "DRAFT",
  vendor: band?.name ?? connection.band_name,
  ...(collectionId ? { collections: [collectionId] } : {}),
  // ... rest of input
});
```

**For existing products without collections:** The backfill script queries all draft products, groups by vendor, and calls `collectionAddProducts` for each vendor's products.

**Future enhancement:** Wire `findOrgByNameOrAlias` into the collection matching so manually-added aliases (e.g. alias "NSPY" → org "Northern Spy Records") also match Shopify collections named "NSPY".

---

## 9. Critical Implementation Note (variable ordering — from review)

**BLOCKING BUG:** The proposed fix references `bcPrice` and `bcCost` in the `productSetCreate` variant input, but these variables are computed AFTER the Shopify create call at line 1434-1435. They must be moved BEFORE line 1347.

**Required restructuring:**

```typescript
// MOVE to BEFORE productSetCreate (line ~1343):
const bcPrice = merchItem.price ?? null;
const bcCurrency = merchItem.currency ?? "USD";
const bcCost = bcPrice != null ? Math.round(bcPrice * 0.5 * 100) / 100 : null;

// THEN at line 1347:
shopifyProductId = await productSetCreate({
  // ... title, status, etc.
  variants: [{
    optionValues: [{ optionName: "Title", name: "Default Title" }],
    sku: effectiveSku,
    price: bcPrice != null ? String(bcPrice) : undefined,
    inventoryPolicy: "DENY",
    inventoryItem: {
      tracked: true,
      ...(bcCost != null
        ? { unitCost: { amount: String(bcCost), currencyCode: bcCurrency } }
        : {}),
    },
  }],
  // ... media
});

// REMOVE the duplicate at line 1434-1435 (already computed above)
```

---

## 10. Publishing Fix (revised from review)

**Changed from "all channels" to "safe channels only":**

```typescript
const SAFE_CHANNEL_NAMES = ["Online Store", "Shop"];

export async function getPublicationIds(): Promise<Array<{ id: string; name: string }>> {
  const data = await shopifyGraphQL<{
    channels: { edges: Array<{ node: { id: string; name: string } }> };
  }>("{ channels(first: 20) { edges { node { id name } } } }");
  return data.channels.edges.map((e) => ({
    id: e.node.id.replace("/Channel/", "/Publication/"),
    name: e.node.name,
  }));
}

export async function publishToSafeChannels(shopifyProductId: string): Promise<void> {
  const allPubs = await getPublicationIds();
  const safePubs = allPubs.filter((p) => SAFE_CHANNEL_NAMES.includes(p.name));
  if (safePubs.length === 0) return;

  const mutation = `
    mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id } }
        userErrors { field message }
      }
    }
  `;
  const result = await shopifyGraphQL(mutation, {
    id: toProductGid(shopifyProductId),
    input: safePubs.map((p) => ({ publicationId: p.id })),
  });
}
```

POS, Google & YouTube, and preproduct_storefront are excluded until their requirements (GTINs, product categories, etc.) are verified.

---

## 11. Image Backfill (hardened from review)

Key improvements:
- **Deduplication:** Check if `src` URL already has a `shopify_image_id` row before pushing
- **URL validation:** HEAD request to verify image is accessible before pushing to Shopify
- **Error logging:** Failed images go to `warehouse_review_queue` for manual review
- **Batch by product:** Group images per product, push in one `productCreateMedia` call
- **Alt text:** Use product title as alt text for accessibility
- **Track with timestamp:** Set `shopify_pushed_at` instead of relying on `shopify_image_id` (which requires querying Shopify back)

---

## 12. Backfill Script Structure (hardened from review)

```bash
# Usage:
node scripts/fix-shopify-drafts.mjs --dry-run              # Preview all changes
node scripts/fix-shopify-drafts.mjs --apply                 # Apply all fixes
node scripts/fix-shopify-drafts.mjs --apply --step=inventory  # Only fix tracking + cost
node scripts/fix-shopify-drafts.mjs --apply --step=images     # Only push images
node scripts/fix-shopify-drafts.mjs --apply --step=publish    # Only publish to channels
node scripts/fix-shopify-drafts.mjs --apply --limit=10        # Fix first 10 only
```

Features:
- **Dry-run mode** previews changes without applying
- **Step isolation** lets you fix one issue at a time
- **Limit** for testing on a small batch
- **Progress tracking** with summary table at end
- **Error recovery** logs failures and continues
- **Skip already-fixed** products (checks current state before fixing)

For inventory tracking fix: requires querying Shopify for `product.variants.inventoryItem.id` since the inventory item GID is not stored in the database. This adds one Shopify query per product.

---

## 13. Interaction Map — All Code Paths That Touch Shopify

### Mutations (write to Shopify)

| Mutation | Function | File | Lines | Callers | Impact from our changes |
|---|---|---|---|---|---|
| `productSet` | `productSetCreate` | `shopify-client.ts` | 355-380 | `bandcamp-sync.ts` (1347), `inbound-product-create.ts` (64), `push-bandcamp-to-shopify.ts` (36) | **CHANGED** — add price, cost, tracked, weight, collections |
| `productCreateMedia` | `productCreateMedia` | `shopify-client.ts` | 401-434 | `bandcamp-sync.ts` (727, 1182), `product-images.ts` (109), `backfill-images-to-shopify.mjs` (53) | Used by image backfill — no changes to function |
| `productUpdate` | `productUpdate` | `shopify.ts` | 44-94 | `catalog.ts` (411, 654), `bandcamp-sync.ts` (391) | No changes |
| `productVariantsBulkUpdate` | `productVariantsBulkUpdate` | `shopify.ts` | 97-143 | `catalog.ts` (473) | No changes |
| `inventoryAdjustQuantities` | `inventoryAdjustQuantities` | `shopify-client.ts` | 489-516 | `inventory-fanout.ts` (55) | Only works when `shopify_inventory_item_id` is set AND tracking is enabled. Our Fix 1 enables tracking. |
| `publishablePublish` | `publishablePublish` | `shopify-client.ts` | 522-537 | **NONE — defined but never called** | **NEW CALLER** — called after `productSetCreate` |
| `tagsAdd/Remove` | `tagsAdd`, `tagsRemove` | `shopify-client.ts` | 543-563 | `preorder-setup.ts`, `tag-cleanup-backfill.ts`, `preorder-fulfillment.ts` | No changes |
| `inventoryItemUpdate` | **DOES NOT EXIST** | — | — | — | **MUST ADD** for backfill (set tracked + unitCost on existing products) |
| `collectionCreate` | **DOES NOT EXIST** | — | — | — | **MUST ADD** for Fix 6 |
| `collectionAddProducts` | **DOES NOT EXIST** | — | — | — | **MUST ADD** for backfill |

### Read paths (Shopify → DB)

| Task | File | What it reads | Conflict risk |
|---|---|---|---|
| `shopify-sync` | `shopify-sync.ts` | Products, variants, images, inventory levels FROM Shopify → DB | **NONE** — does not read `inventoryItem.tracked`. Does not overwrite cost if already set. |
| `shopify-full-backfill` | `shopify-full-backfill.ts` | Same as above, full catalog | **NONE** — same safe behavior |
| `process-shopify-webhook` | `process-shopify-webhook.ts` | Inventory webhook → `recordInventoryChange` → fanout | **SAFE** — enabling tracking means webhooks will start firing for these products. This is DESIRED behavior. |

### Critical dependency: `shopify_inventory_item_id`

The `inventoryAdjustQuantities` function requires `shopify_inventory_item_id` on the variant. For Bandcamp-created products:
- `shopify-sync.ts` stores it from Shopify's GraphQL response (line 275)
- BUT this only happens when `shopify-sync` runs AFTER the product is created on Shopify
- For NEW products created by `bandcamp-sync`, the `shopify_inventory_item_id` is NOT stored because `productSetCreate` doesn't return it
- **Implication:** Inventory fanout to Shopify won't work for Bandcamp-created products until `shopify-sync` runs (every 15 min) and populates the ID

### Shopify API scopes

Current scopes (from `shopify.app.toml`):
```
read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments
```

**Missing scopes needed:**
- `write_publications` — required for `publishablePublish` (Fix 4)
- Collections use `write_products` scope — already have it

**Action required:** Add `write_publications` to Shopify app scopes before deploying Fix 4. Without this, publishing will fail with a permission error but product creation still succeeds.

### Existing backfill scripts (can be reused)

| Script | What it does | Reusable? |
|---|---|---|
| `scripts/backfill-images-to-shopify.mjs` | Pushes images without `shopify_image_id` to Shopify via `productCreateMedia` | **YES — already does exactly what we need for Fix 3** |
| `scripts/push-bandcamp-to-shopify.ts` | Creates Shopify products from warehouse DB | Reference only — different flow |
| `scripts/seed-shopify-inventory.ts` | Looks up `shopify_inventory_item_id` for variants that don't have it | **YES — needed before cost/tracking backfill** |

---

## 14. New Functions Required in `shopify-client.ts`

### `inventoryItemUpdate` (needed for backfill — set tracked + cost on existing variants)

```typescript
export async function inventoryItemUpdate(
  inventoryItemId: string,
  input: { tracked?: boolean; cost?: { amount: string; currencyCode: string } },
): Promise<void> {
  const mutation = `
    mutation InventoryItemUpdate($id: ID!, $input: InventoryItemUpdateInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id tracked unitCost { amount currencyCode } }
        userErrors { field message }
      }
    }
  `;
  const variables: Record<string, unknown> = {
    id: inventoryItemId,
    input: {
      ...(input.tracked != null ? { tracked: input.tracked } : {}),
      ...(input.cost ? { cost: input.cost } : {}),
    },
  };
  const data = await shopifyGraphQL<{
    inventoryItemUpdate: {
      inventoryItem: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, variables);

  if (data.inventoryItemUpdate.userErrors.length > 0) {
    throw new Error(
      `inventoryItemUpdate errors: ${data.inventoryItemUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
}
```

### `collectionCreate` (needed for Fix 6 — create vendor collections)

```typescript
export async function collectionCreate(title: string): Promise<string> {
  const mutation = `
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id title }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    collectionCreate: {
      collection: { id: string; title: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input: { title } });

  if (data.collectionCreate.userErrors.length > 0) {
    throw new Error(
      `collectionCreate errors: ${data.collectionCreate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  if (!data.collectionCreate.collection) {
    throw new Error("collectionCreate returned no collection");
  }
  return data.collectionCreate.collection.id;
}
```

### `collectionAddProducts` (needed for backfill — assign existing products to collections)

```typescript
export async function collectionAddProducts(
  collectionId: string,
  productIds: string[],
): Promise<void> {
  if (productIds.length === 0) return;
  const mutation = `
    mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    collectionAddProducts: {
      collection: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { id: collectionId, productIds });

  // "already in collection" is not a fatal error — skip
  const realErrors = data.collectionAddProducts.userErrors.filter(
    (e) => !e.message.includes("already"),
  );
  if (realErrors.length > 0) {
    throw new Error(
      `collectionAddProducts errors: ${realErrors.map((e) => e.message).join(", ")}`,
    );
  }
}
```

### `findOrCreateCollection` (Fix 6 — vendor → collection with cache)

```typescript
const collectionCache = new Map<string, string>();

export async function findOrCreateCollection(vendorName: string): Promise<string> {
  if (collectionCache.has(vendorName)) return collectionCache.get(vendorName)!;

  const escaped = vendorName.replace(/'/g, "\\\\'");
  const data = await shopifyGraphQL<{
    collections: { edges: Array<{ node: { id: string; title: string } }> };
  }>(`{ collections(first: 10, query: "title:'${escaped}'") { edges { node { id title } } } }`);

  const exactMatch = data.collections.edges.find(
    (e) => e.node.title.toLowerCase() === vendorName.toLowerCase(),
  );
  if (exactMatch) {
    collectionCache.set(vendorName, exactMatch.node.id);
    return exactMatch.node.id;
  }

  const stripped = vendorName.replace(/\s+(Records|Music|Label|Tapes|Sound)$/i, "");
  if (stripped !== vendorName) {
    const fuzzyMatch = data.collections.edges.find(
      (e) => e.node.title.toLowerCase() === stripped.toLowerCase(),
    );
    if (fuzzyMatch) {
      collectionCache.set(vendorName, fuzzyMatch.node.id);
      return fuzzyMatch.node.id;
    }
  }

  const newId = await collectionCreate(vendorName);
  collectionCache.set(vendorName, newId);
  return newId;
}
```

### `buildShopifyVariantInput` (extracted helper — promoted from deferred)

```typescript
// src/lib/clients/shopify-variant-input.ts
import type { ProductCategory } from "@/lib/shared/product-categories";
import { CATEGORY_DEFAULT_WEIGHTS } from "@/lib/shared/product-categories";

export interface VariantInputParams {
  sku: string;
  title?: string;
  price?: number | null;
  cost?: number | null;
  currency?: string;
  barcode?: string | null;
  category?: ProductCategory | null;
}

export function buildShopifyVariantInput(params: VariantInputParams) {
  const { sku, title = "Default Title", price, cost, currency = "USD", barcode, category } = params;
  const weight = category ? CATEGORY_DEFAULT_WEIGHTS[category] : { value: 0.5, unit: "POUNDS" };

  return {
    optionValues: [{ optionName: "Title", name: title }],
    sku,
    ...(price != null ? { price: String(price) } : {}),
    inventoryPolicy: "DENY" as const,
    inventoryItem: {
      tracked: true,
      ...(cost != null
        ? { unitCost: { amount: String(cost), currencyCode: currency } }
        : {}),
      measurement: {
        weight: { value: weight.value, unit: weight.unit },
      },
    },
    ...(barcode ? { barcode } : {}),
  };
}
```

Used by `bandcamp-sync.ts`, `push-bandcamp-to-shopify.ts`, and backfill scripts. Single source of truth for variant shape — prevents missing fields when Shopify API changes.

### `publishToSafeChannels` (Fix 4 — publish to Online Store + Shop)

Already defined in Section 10 of this document.

---

## 15. Backfill Execution Order

The backfill must run in this specific order due to dependencies:

```
Step 1: seed-shopify-inventory.ts --apply
  → Populates shopify_inventory_item_id for variants that don't have it
  → REQUIRED before step 2 (inventoryItemUpdate needs the ID)

Step 2: fix-shopify-drafts.mjs --apply --step=inventory
  → inventoryItemUpdate: tracked=true + unitCost for each variant
  → Requires shopify_inventory_item_id from step 1

Step 3: backfill-images-to-shopify.mjs
  → Already exists! Pushes images without shopify_image_id
  → No dependency on other steps

Step 4: fix-shopify-drafts.mjs --apply --step=collections
  → findOrCreateCollection for each vendor
  → collectionAddProducts to assign products
  → No dependency on other steps

Step 5: fix-shopify-drafts.mjs --apply --step=publish
  → publishToSafeChannels for each product
  → Requires write_publications scope

Step 6: fix-shopify-drafts.mjs --apply --step=weight
  → productVariantsBulkUpdate to set weight by category
  → No dependency on other steps
```

Steps 3-6 can run in any order. Steps 1-2 must be sequential.

---

## 16. Rollback Plan

**Fix 1+2 (tracking/price/cost in productSetCreate):**
Revert the variant input change in `bandcamp-sync.ts`. New products go back to untracked/no-price. Existing backfilled products keep their settings — Shopify doesn't auto-revert `tracked` or `unitCost`.

**Fix 3 (image backfill):**
Images pushed to Shopify stay there. No rollback needed or possible (Shopify doesn't provide bulk media delete). Non-destructive.

**Fix 4 (publishing):**
Use `publishableUnpublish` mutation to remove products from channels. Or simply leave them — being published is the desired end state.

**Fix 5 (weight):**
Weight is set via `inventoryItem.measurement` on `productSet`. Can be overwritten to 0 via `productVariantsBulkUpdate` if wrong.

**Fix 6 (collections):**
Collections can be deleted via Shopify Admin. Products removed from collections via `collectionRemoveProducts`. Non-destructive — collections don't affect product data.

**Backfill general:**
Each step is idempotent (except image push which deduplicates by URL). The `--step` flag lets you re-run individual steps. If a step fails partway, re-running picks up where it left off (checks current state before fixing).

---

## 17. Answers to Review Questions

**Q: No rollback plan if backfill breaks products?**
A: Added Section 16. Each fix is independently reversible. Backfill steps are idempotent.

**Q: `write_publications` scope — is it already enabled?**
A: NO. Current scopes are `read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments`. Must add `write_publications` before Fix 4. Verify by querying Shopify API first. If missing, update `shopify.app.toml` and OAuth route, re-authenticate.

**Q: Collection creation — who owns cleanup if vendors change?**
A: Collections are created once per vendor name and cached. If a vendor name changes on Bandcamp, a new collection is created. Old collections stay (manual cleanup in Shopify Admin). The `organization_aliases` system can map old names to new ones for future matching.

**Q: Weight assignment by category — where's the category data coming from?**
A: From `product_category` on `bandcamp_product_mappings` (just backfilled for all 1,412 mappings). The category is derived from `bandcamp_type_name` + title + URL by `classifyProduct()` in `src/lib/shared/product-categories.ts`. For variants without a mapping, fallback to format_name on the variant or default to 0.5 lb.

**Q: Error handling — what happens if `publishToSafeChannels` fails mid-backfill?**
A: Publishing is best-effort. The backfill script wraps each product in try/catch, logs failures, and continues. Products that fail to publish are logged for manual review. The product itself is already created — publishing is a separate non-destructive step.

---

## 18. Implementation Checklist

**Code changes (bandcamp-sync.ts):**
- [ ] Move `bcPrice`/`bcCost`/`bcCurrency` computation to BEFORE `productSetCreate` (~line 1343)
- [ ] Remove duplicate `bcPrice`/`bcCost` at line 1434-1435
- [ ] Add `price` to variant input
- [ ] Add `inventoryItem.tracked: true` to variant input
- [ ] Add `inventoryItem.unitCost` with `merchItem.currency ?? "USD"`
- [ ] Add `inventoryItem.measurement.weight` from `CATEGORY_DEFAULT_WEIGHTS`
- [ ] Add `barcode` if available from `raw_api_data.barcode` (improves Shopify search + POS)
- [ ] Add `findOrCreateCollection` call before `productSetCreate`
- [ ] Add `collections: [collectionId]` to productSetCreate input
- [ ] Add `publishToSafeChannels` call after successful creation
- [ ] Set `weight` on `warehouse_product_variants` row at creation time

**New functions:**
- [ ] `buildShopifyVariantInput(params)` in `src/lib/clients/shopify-variant-input.ts` — extracted helper for variant input shape
- [ ] `inventoryItemUpdate(inventoryItemId, { tracked, cost })` in `shopify-client.ts`
- [ ] `collectionCreate(title)` in `shopify-client.ts`
- [ ] `collectionAddProducts(collectionId, productIds)` in `shopify-client.ts`
- [ ] `findOrCreateCollection(vendorName)` in `shopify-client.ts` — cache + suffix stripping
- [ ] `publishToSafeChannels(shopifyProductId)` in `shopify-client.ts` — Online Store + Shop only
- [ ] `getPublicationIds()` in `shopify-client.ts` — with cache

**Shopify app config:**
- [ ] Add `write_publications` to scopes in `shopify.app.toml`
- [ ] Add `write_publications` to OAuth route in `src/app/api/oauth/shopify/route.ts`
- [ ] Verify scope is granted by querying Shopify API

**Backfill execution (in order):**
- [ ] Step 0: Verify `write_publications` scope — query Shopify API before running step 5
- [ ] Step 1: `node scripts/seed-shopify-inventory.ts --apply` (populate shopify_inventory_item_id)
- [ ] Step 2: `node scripts/fix-shopify-drafts.mjs --apply --step=inventory` (tracked + cost)
- [ ] Step 3: `node scripts/backfill-images-to-shopify.mjs` (existing script — push missing images with HEAD validation + dedup)
- [ ] Step 4: `node scripts/fix-shopify-drafts.mjs --apply --step=collections` (vendor collections with dedup check)
- [ ] Step 5: `node scripts/fix-shopify-drafts.mjs --apply --step=publish` (safe channels — requires scope from step 0)
- [ ] Step 6: `node scripts/fix-shopify-drafts.mjs --apply --step=weight` (weight by category, also sets in DB)

**Verification:**
- [ ] Step 0.5: After scope verification, run `--limit=10` test batch before full backfill
- [ ] Open 10 random products in Shopify Admin — verify tracking, cost, images, channels, collections
- [ ] Verify cost is VISIBLE in Shopify Admin (not just accepted by mutation — admin display can differ)
- [ ] SQL: `SELECT COUNT(*) FROM warehouse_product_images WHERE shopify_image_id IS NULL` — should be near 0
- [ ] Trigger a test Bandcamp sync and verify new product has all fields set
- [ ] Verify publication ID conversion works in practice (Channel→Publication GID swap) on one real product before mass backfill

**Doc sync:**
- [ ] Update `TRIGGER_TASK_CATALOG.md` — note productSetCreate now sets tracked/cost/weight/collections
- [ ] Update `API_CATALOG.md` — add new shopify-client.ts exports

---

## 19. Peer Review Integration Log

### Review 1 (initial)

| # | Issue | Resolution |
|---|---|---|
| CRIT-1 | bcPrice/bcCost referenced before defined | Added Section 9 with restructured code |
| HIGH-1 | Publishing to all 5 channels is dangerous | Changed to safe channels (Online Store + Shop) |
| HIGH-2 | Image backfill has no dedup/error handling | Added HEAD validation, dedup, review queue logging |
| HIGH-3 | Backfill script missing dry-run/steps/progress | Added CLI flags, step isolation, progress logging |
| HIGH-4 | No verification plan | Added to checklist |
| GAP-1 | Currency hardcoded as USD | Changed to `merchItem.currency ?? "USD"` |
| GAP-2 | Image backfill has same silent failure as original | Added try/catch per image with review queue logging |

### Review 2 (technical notes)

| # | Issue | Resolution |
|---|---|---|
| 1 | Add barcode if available from raw_api_data | Added to checklist — include in variant input |
| 2 | Image backfill should HEAD-validate URLs before pushing | Already in plan from Review 1, confirmed |
| 3 | Batch images per product in one productCreateMedia call | Already in plan from Review 1, confirmed |
| 4 | Verify token scopes before implementing publishing | Added Step 0 to backfill execution order |
| 5 | Collection dedup — check before creating | Already in `findOrCreateCollection` exact match logic |
| 6 | Weight should be set in both Shopify AND warehouse DB | Added to checklist — set at variant creation time |
| 7 | Backfill should detect already-fixed products and skip | Already in plan — each step checks current state |
| 8 | Progress logging every 25 products | Good practice — will implement in backfill script |
| 9 | Log failures to warehouse_review_queue | Already in plan from Review 1 |

### Review 3 (scope/risk assessment)

| # | Issue | Resolution |
|---|---|---|
| 1 | No rollback plan | Added Section 16 with per-fix rollback steps |
| 2 | write_publications scope verification | Added Step 0 to backfill + Section 17 answer |
| 3 | Collection cleanup ownership | Added Section 17 answer |
| 4 | Weight category data source | Added Section 17 answer |
| 5 | Error handling for publish failures | Added Section 17 answer |

### Review 4+5 (final hardening)

| # | Issue | Resolution |
|---|---|---|
| 1 | Verify cost is VISIBLE in Shopify Admin after mutation (not just accepted) | Added to verification checklist |
| 2 | Image backfill logging should distinguish "no attempt" vs "HEAD failed" vs "Shopify mutation failed" | Will implement three-tier logging in backfill script |
| 3 | `shopify_pushed_at` vs `shopify_image_id` — clarify which is source of truth | `shopify_image_id` is authoritative when available; `shopify_pushed_at` is fallback for paths where Shopify doesn't return the ID. Document this in code comments. |
| 4 | Publication ID Channel→Publication swap needs real-world verification | Added to verification checklist — test on one product before mass backfill |
| 5 | Weight fallback for products without mapping should be marked as low-confidence default | Will add code comment: `// Low-confidence default — not from product data` |
| 6 | Collection creation is "vendor-name-based" not truly "alias-aware" yet | Updated Section 8 description. Alias integration is a future enhancement. |
| 7 | New Bandcamp products have a ~15min window without inventory fanout (until shopify-sync populates inventory item ID) | Documented as "temporary inconsistency window" — acceptable, already noted in Section 13 |
| 8 | Run `--limit=10` test batch as official step before full backfill | Added Step 0.5 to verification checklist |
| 9 | Promote `buildShopifyVariantInput` extraction from deferred to implementation | **PROMOTED** — adding price, tracked, unitCost, weight, and barcode in one inline block is fragile. Extract to helper. |

### Deferred

| # | Suggestion | Reason |
|---|---|---|
| 1 | Add `shopify_sync_status` JSONB column | Adds migration. Script checks current state instead. |
| 2 | Integration tests for publishing flow | Follow-up after shipping. |
| 3 | POS / Google & YouTube channel publishing | Requires GTIN/category verification first. |
| 4 | Wire `findOrgByNameOrAlias` into collection matching | Future enhancement — current suffix stripping handles most cases. |
| 5 | Unit tests for new shopify-client functions | Follow-up — but should be done soon after shipping. |

| # | Issue | Resolution |
|---|---|---|
| CRIT-1 | bcPrice/bcCost referenced before defined | Move computation before productSetCreate. Added Section 7. |
| HIGH-1 | Publishing to all 5 channels is dangerous | Changed to safe channels only (Online Store + Shop). Section 8. |
| HIGH-2 | Image backfill has no dedup/error handling | Added URL validation, dedup, review queue logging, batch by product. Section 9. |
| HIGH-3 | Backfill script missing dry-run/steps/progress | Added CLI flags, step isolation, limit option, summary. Section 10. |
| HIGH-4 | No verification plan after fixes | Added to backfill script: verify via Shopify Admin + SQL queries |
| GAP-1 | Currency hardcoded as USD | Changed to `merchItem.currency ?? "USD"` |
| GAP-2 | Image backfill has same silent failure as original | Added try/catch per image with review queue logging |
| GAP-3 | No test coverage mentioned | Noted as follow-up; variant input builder should be tested |
| IMP-1 | Extract variant input builder | Good idea, deferred to follow-up to keep scope focused |
| IMP-2 | Add shopify_sync_status tracking | Good idea, deferred — script uses state checks instead of new column |

### Deferred

| # | Suggestion | Reason |
|---|---|---|
| IMP-1 | Extract `buildShopifyVariantInput` helper | Good DRY improvement but adds scope. Current fix is a 5-line change. |
| IMP-2 | Add `shopify_sync_status` JSONB column | Adds migration + schema change. Script checks current state instead. |
| Tests | Unit tests for variant input builder | Follow-up after shipping the fix. |
| POS/Google | Publish to POS + Google & YouTube channels | Requires verifying GTIN/category requirements first. |
