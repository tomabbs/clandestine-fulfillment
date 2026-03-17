import { z } from "zod/v4";

// WooCommerce REST API v3 client
// Auth: Basic Auth (consumer_key:consumer_secret)
// Rule #44: WooCommerce uses absolute quantities, not deltas

// === Types ===

export interface WooCommerceCredentials {
  consumerKey: string;
  consumerSecret: string;
  siteUrl: string;
}

// === Zod schemas (Rule #5) ===

const wooProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  sku: z.string(),
  stock_quantity: z.number().nullable(),
  stock_status: z.string(),
  manage_stock: z.boolean(),
  price: z.string(),
  permalink: z.string().optional(),
});

const wooOrderSchema = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  date_created: z.string(),
  date_modified: z.string(),
  total: z.string(),
  currency: z.string(),
  line_items: z.array(
    z.object({
      id: z.number(),
      product_id: z.number(),
      variation_id: z.number(),
      name: z.string(),
      sku: z.string(),
      quantity: z.number(),
      price: z.string(),
    }),
  ),
});

export type WooProduct = z.infer<typeof wooProductSchema>;
export type WooOrder = z.infer<typeof wooOrderSchema>;

// === API helpers ===

function buildAuthHeader(credentials: WooCommerceCredentials): string {
  const encoded = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString(
    "base64",
  );
  return `Basic ${encoded}`;
}

async function wooFetch(
  credentials: WooCommerceCredentials,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const baseUrl = credentials.siteUrl.replace(/\/$/, "");
  const url = `${baseUrl}/wp-json/wc/v3${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: buildAuthHeader(credentials),
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WooCommerce API error ${res.status}: ${body}`);
  }

  return res;
}

// === Public API ===

export async function getProductBySku(
  credentials: WooCommerceCredentials,
  sku: string,
): Promise<WooProduct | null> {
  const res = await wooFetch(credentials, `/products?sku=${encodeURIComponent(sku)}`);
  const data = z.array(wooProductSchema).parse(await res.json());
  return data[0] ?? null;
}

// Rule #44: stock_quantity is absolute value, not delta
export async function updateStockQuantity(
  credentials: WooCommerceCredentials,
  productId: number,
  quantity: number,
): Promise<WooProduct> {
  const res = await wooFetch(credentials, `/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({
      stock_quantity: quantity,
      manage_stock: true,
    }),
  });
  return wooProductSchema.parse(await res.json());
}

export async function getOrders(
  credentials: WooCommerceCredentials,
  params?: { after?: string; page?: number; perPage?: number; status?: string },
): Promise<WooOrder[]> {
  const searchParams = new URLSearchParams();
  if (params?.after) searchParams.set("after", params.after);
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.perPage) searchParams.set("per_page", String(params.perPage));
  if (params?.status) searchParams.set("status", params.status);

  const qs = searchParams.toString();
  const path = `/orders${qs ? `?${qs}` : ""}`;
  const res = await wooFetch(credentials, path);
  return z.array(wooOrderSchema).parse(await res.json());
}
