import { z } from "zod/v4";

// WooCommerce REST API v3 client
// Auth: Basic Auth (consumer_key:consumer_secret)
// Rule #44: WooCommerce uses absolute quantities, not deltas
// Operational hardening (2026-04-24): some live stores returned empty/invalid
// bodies at higher `per_page` values, so catalog readers cap page size to 20.

// === Types ===

export interface WooCommerceCredentials {
  consumerKey: string;
  consumerSecret: string;
  siteUrl: string;
  connectionId?: string;
  preferredAuthMode?: WooAuthMode | null;
  onPreferredAuthMode?: (mode: WooAuthMode) => Promise<void> | void;
}

export type WooAuthMode = "basic" | "query_param";

export type WooApiErrorCode =
  | "auth_failed"
  | "auth_failed_both_methods"
  | "rest_api_disabled"
  | "rate_limited"
  | "not_found"
  | "server_error"
  | "network";

export class WooCommerceApiError extends Error {
  constructor(
    message: string,
    public readonly code: WooApiErrorCode,
    public readonly status: number | null,
    public readonly authMethodTried: WooAuthMode | "both" | null,
  ) {
    super(message);
    this.name = "WooCommerceApiError";
  }
}

export interface WooCatalogItem {
  id: number;
  productId: number;
  variationId: number | null;
  name: string;
  sku: string;
  stock_quantity: number | null;
  stock_status: string | null;
  manage_stock: boolean;
  price: string | null;
  permalink: string | null;
}

// === Zod schemas (Rule #5) ===

const wooAttributeSchema = z.object({
  name: z.string().optional(),
  option: z.string().nullish(),
});

const wooProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  sku: z.string().nullish(),
  stock_quantity: z.number().nullable().optional(),
  stock_status: z.string().nullish(),
  manage_stock: z.boolean().optional(),
  price: z.string().nullish(),
  permalink: z.string().optional(),
  type: z.string().optional(),
  variations: z.array(z.number()).optional(),
});

const wooVariationSchema = z.object({
  id: z.number(),
  sku: z.string().nullish(),
  stock_quantity: z.number().nullable().optional(),
  stock_status: z.string().nullish(),
  manage_stock: z.boolean().optional(),
  price: z.string().nullish(),
  permalink: z.string().optional(),
  attributes: z.array(wooAttributeSchema).optional(),
});

const wooOrderSchema = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  date_created: z.string(),
  date_modified: z.string(),
  date_created_gmt: z.string().nullish(),
  date_modified_gmt: z.string().nullish(),
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

export type WooProduct = WooCatalogItem;
export type WooOrder = z.infer<typeof wooOrderSchema>;

const WOO_CATALOG_PAGE_SIZE = 20;

// === API helpers ===

function buildAuthHeader(credentials: WooCommerceCredentials): string {
  const encoded = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString(
    "base64",
  );
  return `Basic ${encoded}`;
}

export function redactWooUrl(url: string): string {
  return url
    .replace(/([?&]consumer_key=)[^&]+/g, "$1REDACTED")
    .replace(/([?&]consumer_secret=)[^&]+/g, "$1REDACTED");
}

function appendQueryAuth(url: string, credentials: WooCommerceCredentials): string {
  const next = new URL(url);
  next.searchParams.set("consumer_key", credentials.consumerKey);
  next.searchParams.set("consumer_secret", credentials.consumerSecret);
  return next.toString();
}

function classifyWooFailure(status: number, body: string): WooApiErrorCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) {
    const lower = body.toLowerCase();
    if (lower.includes("<html") || lower.includes("rest_no_route")) return "rest_api_disabled";
    return "not_found";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "server_error";
}

function buildWooError(input: {
  status: number;
  body: string;
  url: string;
  authMode: WooAuthMode | "both";
  code?: WooApiErrorCode;
}): WooCommerceApiError {
  const code = input.code ?? classifyWooFailure(input.status, input.body);
  return new WooCommerceApiError(
    `WooCommerce API error ${input.status} (${code}, auth=${input.authMode}) at ${redactWooUrl(input.url)}: ${input.body.slice(0, 500)}`,
    code,
    input.status,
    input.authMode,
  );
}

async function tryWooFetch(
  url: string,
  credentials: WooCommerceCredentials,
  authMode: WooAuthMode,
  options?: RequestInit,
): Promise<Response | WooCommerceApiError> {
  const targetUrl = authMode === "query_param" ? appendQueryAuth(url, credentials) : url;
  try {
    const res = await fetch(targetUrl, {
      ...options,
      headers: {
        ...(authMode === "basic" ? { Authorization: buildAuthHeader(credentials) } : {}),
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    return buildWooError({
      status: res.status,
      body,
      url: targetUrl,
      authMode,
    });
  } catch (err) {
    return new WooCommerceApiError(
      `WooCommerce API network error at ${redactWooUrl(targetUrl)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "network",
      null,
      authMode,
    );
  }
}

async function wooFetch(
  credentials: WooCommerceCredentials,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const baseUrl = credentials.siteUrl.replace(/\/$/, "");
  const url = `${baseUrl}/wp-json/wc/v3${path}`;

  const primaryMode = credentials.preferredAuthMode ?? "basic";
  const primary = await tryWooFetch(url, credentials, primaryMode, options);
  if (!(primary instanceof WooCommerceApiError)) return primary;

  const canFallback =
    primaryMode === "basic" &&
    primary.code === "auth_failed" &&
    credentials.siteUrl.toLowerCase().startsWith("https://");
  if (!canFallback) throw primary;

  const fallback = await tryWooFetch(url, credentials, "query_param", options);
  if (!(fallback instanceof WooCommerceApiError)) {
    await credentials.onPreferredAuthMode?.("query_param");
    return fallback;
  }

  if (fallback.code === "auth_failed") {
    throw buildWooError({
      status: fallback.status ?? 403,
      body: fallback.message,
      url,
      authMode: "both",
      code: "auth_failed_both_methods",
    });
  }

  throw fallback;
}

function normalizeWooSku(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeCatalogPageSize(value?: number): number {
  if (!value || value <= 0) return WOO_CATALOG_PAGE_SIZE;
  return Math.min(value, WOO_CATALOG_PAGE_SIZE);
}

function buildVariationName(
  productName: string,
  attributes: Array<z.infer<typeof wooAttributeSchema>> | undefined,
): string {
  const descriptor = (attributes ?? [])
    .map((attr) => attr.option?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" / ");
  return descriptor ? `${productName} - ${descriptor}` : productName;
}

function toWooCatalogItem(
  product: z.infer<typeof wooProductSchema>,
  variation?: z.infer<typeof wooVariationSchema>,
): WooCatalogItem | null {
  const sku = normalizeWooSku(variation?.sku ?? product.sku);
  if (!sku) return null;

  return {
    id: variation?.id ?? product.id,
    productId: product.id,
    variationId: variation?.id ?? null,
    name: variation ? buildVariationName(product.name, variation.attributes) : product.name,
    sku,
    stock_quantity: variation?.stock_quantity ?? product.stock_quantity ?? null,
    stock_status: variation?.stock_status ?? product.stock_status ?? null,
    manage_stock: variation?.manage_stock ?? product.manage_stock ?? false,
    price: variation?.price ?? product.price ?? null,
    permalink: variation?.permalink ?? product.permalink ?? null,
  };
}

export async function listProductsPage(
  credentials: WooCommerceCredentials,
  params?: { page?: number; perPage?: number; search?: string },
): Promise<Array<z.infer<typeof wooProductSchema>>> {
  const searchParams = new URLSearchParams();
  searchParams.set("page", String(params?.page ?? 1));
  searchParams.set("per_page", String(safeCatalogPageSize(params?.perPage)));
  if (params?.search) searchParams.set("search", params.search);
  const res = await wooFetch(credentials, `/products?${searchParams.toString()}`);
  return z.array(wooProductSchema).parse(await res.json());
}

export async function listProductVariationsPage(
  credentials: WooCommerceCredentials,
  productId: number,
  params?: { page?: number; perPage?: number },
): Promise<Array<z.infer<typeof wooVariationSchema>>> {
  const searchParams = new URLSearchParams();
  searchParams.set("page", String(params?.page ?? 1));
  searchParams.set("per_page", String(safeCatalogPageSize(params?.perPage)));
  const res = await wooFetch(
    credentials,
    `/products/${productId}/variations?${searchParams.toString()}`,
  );
  return z.array(wooVariationSchema).parse(await res.json());
}

export async function listCatalogItems(
  credentials: WooCommerceCredentials,
  params?: { search?: string; perPage?: number },
): Promise<WooCatalogItem[]> {
  const perPage = safeCatalogPageSize(params?.perPage);
  const items: WooCatalogItem[] = [];

  for (let page = 1; ; page++) {
    const products = await listProductsPage(credentials, {
      page,
      perPage,
      search: params?.search,
    });
    if (products.length === 0) break;

    for (const product of products) {
      const productItem = toWooCatalogItem(product);
      if (productItem) items.push(productItem);

      const hasVariations = product.type === "variable" || (product.variations?.length ?? 0) > 0;
      if (!hasVariations) continue;

      for (let variationPage = 1; ; variationPage++) {
        const variations = await listProductVariationsPage(credentials, product.id, {
          page: variationPage,
          perPage,
        });
        if (variations.length === 0) break;

        for (const variation of variations) {
          const variationItem = toWooCatalogItem(product, variation);
          if (variationItem) items.push(variationItem);
        }

        if (variations.length < perPage) break;
      }
    }

    if (products.length < perPage) break;
  }

  return items;
}

// === Public API ===

export async function getProductBySku(
  credentials: WooCommerceCredentials,
  sku: string,
): Promise<WooProduct | null> {
  const normalizedSku = normalizeWooSku(sku);
  if (!normalizedSku) return null;

  const items = await listCatalogItems(credentials, { search: normalizedSku });
  return items.find((item) => item.sku === normalizedSku) ?? null;
}

// Rule #44: stock_quantity is absolute value, not delta
export async function updateStockQuantity(
  credentials: WooCommerceCredentials,
  productId: number,
  quantity: number,
  variationId?: number | null,
): Promise<WooProduct> {
  const targetPath = variationId
    ? `/products/${productId}/variations/${variationId}`
    : `/products/${productId}`;
  const res = await wooFetch(credentials, targetPath, {
    method: "PUT",
    body: JSON.stringify({
      stock_quantity: quantity,
      manage_stock: true,
    }),
  });

  if (variationId) {
    const variation = wooVariationSchema.parse(await res.json());
    return {
      id: variation.id,
      productId,
      variationId,
      name: buildVariationName(`Product ${productId}`, variation.attributes),
      sku: normalizeWooSku(variation.sku) ?? "",
      stock_quantity: variation.stock_quantity ?? null,
      stock_status: variation.stock_status ?? null,
      manage_stock: variation.manage_stock ?? true,
      price: variation.price ?? null,
      permalink: variation.permalink ?? null,
    };
  }

  const product = wooProductSchema.parse(await res.json());
  return {
    id: product.id,
    productId: product.id,
    variationId: null,
    name: product.name,
    sku: normalizeWooSku(product.sku) ?? "",
    stock_quantity: product.stock_quantity ?? null,
    stock_status: product.stock_status ?? null,
    manage_stock: product.manage_stock ?? true,
    price: product.price ?? null,
    permalink: product.permalink ?? null,
  };
}

export async function getOrders(
  credentials: WooCommerceCredentials,
  params?: {
    after?: string;
    modifiedAfter?: string;
    page?: number;
    perPage?: number;
    status?: string;
    orderby?: "date" | "id" | "include" | "title" | "slug" | "modified";
    order?: "asc" | "desc";
  },
): Promise<WooOrder[]> {
  const searchParams = new URLSearchParams();
  if (params?.after) searchParams.set("after", params.after);
  if (params?.modifiedAfter) searchParams.set("modified_after", params.modifiedAfter);
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.perPage) searchParams.set("per_page", String(params.perPage));
  if (params?.status) searchParams.set("status", params.status);
  if (params?.orderby) searchParams.set("orderby", params.orderby);
  if (params?.order) searchParams.set("order", params.order);

  const qs = searchParams.toString();
  const path = `/orders${qs ? `?${qs}` : ""}`;
  const res = await wooFetch(credentials, path);
  return z.array(wooOrderSchema).parse(await res.json());
}
