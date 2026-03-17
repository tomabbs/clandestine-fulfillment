import { z } from "zod/v4";

// Squarespace Commerce API client
// Auth: Bearer token (API key)

// === Zod schemas (Rule #5) ===

const inventoryItemSchema = z.object({
  variantId: z.string(),
  sku: z.string().nullish(),
  quantity: z.number(),
  isUnlimited: z.boolean().optional(),
});

const inventoryResponseSchema = z.object({
  inventory: z.array(inventoryItemSchema),
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
  pagination: z
    .object({
      nextPageCursor: z.string().nullish(),
      hasNextPage: z.boolean(),
    })
    .optional(),
});

export type SquarespaceInventoryItem = z.infer<typeof inventoryItemSchema>;
export type SquarespaceOrder = z.infer<typeof orderSchema>;

// === API helpers ===

async function sqspFetch(
  apiKey: string,
  storeUrl: string,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const baseUrl = storeUrl.replace(/\/$/, "");
  const url = `${baseUrl}/api/1.0${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
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
  storeUrl: string,
): Promise<SquarespaceInventoryItem[]> {
  const res = await sqspFetch(apiKey, storeUrl, "/commerce/inventory");
  const data = inventoryResponseSchema.parse(await res.json());
  return data.inventory;
}

// Rule #15: Idempotency keys must be stable per logical adjustment
export async function adjustInventory(
  apiKey: string,
  storeUrl: string,
  variantId: string,
  quantity: number,
  idempotencyKey: string,
): Promise<void> {
  await sqspFetch(apiKey, storeUrl, "/commerce/inventory/adjustments", {
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
  storeUrl: string,
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
  const path = `/commerce/orders${qs ? `?${qs}` : ""}`;
  const res = await sqspFetch(apiKey, storeUrl, path);
  const data = ordersResponseSchema.parse(await res.json());

  return {
    orders: data.result,
    nextCursor: data.pagination?.nextPageCursor ?? null,
  };
}
