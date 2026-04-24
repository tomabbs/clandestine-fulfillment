import { z } from "zod/v4";

// Squarespace Commerce API client
// Auth: Bearer token (API key)

// === Zod schemas (Rule #5) ===

const squarespacePaginationSchema = z.object({
  nextPageCursor: z.string().nullish(),
  hasNextPage: z.boolean(),
});

const inventoryItemSchema = z.object({
  variantId: z.string(),
  sku: z.string().nullish(),
  quantity: z.number(),
  isUnlimited: z.boolean().optional(),
});

const inventoryResponseSchema = z.object({
  inventory: z.array(inventoryItemSchema),
  pagination: squarespacePaginationSchema.optional(),
});

const orderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  createdOn: z.string(),
  modifiedOn: z.string(),
  fulfillmentStatus: z.string(),
  lineItems: z.array(
    z.object({
      id: z.string(),
      variantId: z.string().nullish(),
      sku: z.string().nullish(),
      productName: z.string().nullish(),
      quantity: z.number(),
      unitPricePaid: z
        .object({
          value: z.string(),
          currency: z.string(),
        })
        .nullish(),
    }),
  ),
});

const ordersResponseSchema = z.object({
  result: z.array(orderSchema),
  pagination: squarespacePaginationSchema.optional(),
});

export type SquarespaceInventoryItem = z.infer<typeof inventoryItemSchema>;
export type SquarespaceOrder = z.infer<typeof orderSchema>;

const squarespaceProductSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  url: z.string().nullish(),
});

const squarespaceVariantSchema = z
  .object({
    id: z.string(),
    sku: z.string().nullish(),
    stock: z
      .object({
        quantity: z.number().optional(),
        unlimited: z.boolean().optional(),
      })
      .nullish(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const squarespaceProductDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    url: z.string().nullish(),
    variants: z.array(squarespaceVariantSchema).default([]),
  })
  .passthrough();

const productsListResponseSchema = z.object({
  products: z.array(squarespaceProductSummarySchema),
  pagination: squarespacePaginationSchema.optional(),
});

const productsDetailResponseSchema = z.object({
  products: z.array(squarespaceProductDetailSchema),
});

export interface SquarespaceCatalogItem {
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number | null;
  unlimited: boolean;
  productUrl: string | null;
  productType: string | null;
}

// === API helpers ===

const SQUARESPACE_API_BASE = "https://api.squarespace.com";
const SQUARESPACE_USER_AGENT = "clandestine-fulfillment/1.0";

async function sqspFetch(apiKey: string, path: string, options?: RequestInit): Promise<Response> {
  const url = `${SQUARESPACE_API_BASE}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": SQUARESPACE_USER_AGENT,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Squarespace API error ${res.status}: ${body}`);
  }

  return res;
}

// === Public API ===

export async function getInventory(
  apiKey: string,
  _storeUrl: string,
): Promise<SquarespaceInventoryItem[]> {
  const items: SquarespaceInventoryItem[] = [];
  let cursor: string | null = null;

  for (;;) {
    const searchParams = new URLSearchParams();
    if (cursor) searchParams.set("cursor", cursor);
    const path = `/1.0/commerce/inventory${searchParams.size ? `?${searchParams.toString()}` : ""}`;
    const res = await sqspFetch(apiKey, path);
    const data = inventoryResponseSchema.parse(await res.json());
    items.push(...data.inventory);

    if (!data.pagination?.hasNextPage || !data.pagination.nextPageCursor) break;
    cursor = data.pagination.nextPageCursor;
  }

  return items;
}

// Rule #15: Idempotency keys must be stable per logical adjustment
export async function adjustInventory(
  apiKey: string,
  _storeUrl: string,
  variantId: string,
  quantity: number,
  idempotencyKey: string,
): Promise<void> {
  await sqspFetch(apiKey, "/1.0/commerce/inventory/adjustments", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      incrementOperations: [
        {
          variantId,
          quantity,
        },
      ],
    }),
  });
}

export async function getOrders(
  apiKey: string,
  _storeUrl: string,
  params?: { modifiedAfter?: string; cursor?: string },
): Promise<{ orders: SquarespaceOrder[]; nextCursor: string | null }> {
  const searchParams = new URLSearchParams();
  if (params?.modifiedAfter) {
    searchParams.set("modifiedAfter", params.modifiedAfter);
  }
  if (params?.cursor) {
    searchParams.set("cursor", params.cursor);
  }

  const qs = searchParams.toString();
  const path = `/1.0/commerce/orders${qs ? `?${qs}` : ""}`;
  const res = await sqspFetch(apiKey, path);
  const data = ordersResponseSchema.parse(await res.json());

  return {
    orders: data.result,
    nextCursor: data.pagination?.nextPageCursor ?? null,
  };
}

export async function listProductsPage(
  apiKey: string,
  params?: { cursor?: string; query?: string },
): Promise<{
  products: Array<z.infer<typeof squarespaceProductSummarySchema>>;
  nextCursor: string | null;
}> {
  const searchParams = new URLSearchParams();
  if (params?.cursor) searchParams.set("cursor", params.cursor);
  if (params?.query) searchParams.set("query", params.query);
  const path = `/v2/commerce/products${searchParams.size ? `?${searchParams.toString()}` : ""}`;
  const res = await sqspFetch(apiKey, path);
  const data = productsListResponseSchema.parse(await res.json());
  return {
    products: data.products,
    nextCursor: data.pagination?.nextPageCursor ?? null,
  };
}

export async function getProductsByIds(
  apiKey: string,
  productIds: string[],
): Promise<Array<z.infer<typeof squarespaceProductDetailSchema>>> {
  if (productIds.length === 0) return [];
  const path = `/v2/commerce/products/${productIds.join(",")}`;
  const res = await sqspFetch(apiKey, path);
  const data = productsDetailResponseSchema.parse(await res.json());
  return data.products;
}

function buildVariantName(
  productName: string,
  attributes: Record<string, string> | undefined,
): string {
  const descriptor = Object.values(attributes ?? {})
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" / ");
  return descriptor ? `${productName} - ${descriptor}` : productName;
}

export async function listCatalogItems(
  apiKey: string,
  params?: { query?: string },
): Promise<SquarespaceCatalogItem[]> {
  const summaries: Array<z.infer<typeof squarespaceProductSummarySchema>> = [];
  let cursor: string | null = null;

  for (;;) {
    const page = await listProductsPage(apiKey, {
      cursor: cursor ?? undefined,
      query: params?.query,
    });
    summaries.push(...page.products);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const items: SquarespaceCatalogItem[] = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
    const batch = summaries.slice(i, i + BATCH_SIZE);
    const details = await getProductsByIds(
      apiKey,
      batch.map((product) => product.id),
    );

    for (const product of details) {
      for (const variant of product.variants) {
        const sku = variant.sku?.trim();
        if (!sku) continue;
        items.push({
          productId: product.id,
          variantId: variant.id,
          productName: product.name,
          variantName: buildVariantName(product.name, variant.attributes),
          sku,
          quantity: variant.stock?.quantity ?? null,
          unlimited: variant.stock?.unlimited ?? false,
          productUrl: product.url ?? null,
          productType: product.type ?? null,
        });
      }
    }
  }

  return items;
}
