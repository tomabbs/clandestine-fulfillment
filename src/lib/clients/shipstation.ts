import { z } from "zod";
import { env } from "@/lib/shared/env";

// === Rate Limiter ===

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 40;

interface RateLimitState {
  remaining: number;
  resetAt: number;
}

const rateLimitState: RateLimitState = {
  remaining: RATE_LIMIT_MAX,
  resetAt: Date.now() + RATE_LIMIT_WINDOW_MS,
};

function updateRateLimitFromHeaders(headers: Headers): void {
  const remaining = headers.get("X-Rate-Limit-Remaining");
  const reset = headers.get("X-Rate-Limit-Reset");
  if (remaining !== null) {
    rateLimitState.remaining = Number.parseInt(remaining, 10);
  }
  if (reset !== null) {
    rateLimitState.resetAt = Number.parseInt(reset, 10) * 1000;
  }
}

async function waitForRateLimit(): Promise<void> {
  if (rateLimitState.remaining > 0) return;
  const waitMs = Math.max(0, rateLimitState.resetAt - Date.now()) + 500;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  rateLimitState.remaining = RATE_LIMIT_MAX;
}

// === Auth ===

function getAuthHeader(): string {
  const { SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET } = env();
  const credentials = Buffer.from(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`).toString(
    "base64",
  );
  return `Basic ${credentials}`;
}

// === Core Fetch ===

const SHIPSTATION_BASE_URL = "https://ssapi.shipstation.com";

async function shipstationFetch<T>(path: string, options?: RequestInit): Promise<T> {
  await waitForRateLimit();

  const response = await fetch(`${SHIPSTATION_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  updateRateLimitFromHeaders(response.headers);

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000;
    rateLimitState.remaining = 0;
    rateLimitState.resetAt = Date.now() + waitMs;
    await waitForRateLimit();
    return shipstationFetch<T>(path, options);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ShipStation API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

// === Zod Schemas ===

const shipStationAddressSchema = z.object({
  name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  street1: z.string().nullable().optional(),
  street2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

const shipStationItemSchema = z.object({
  orderItemId: z.number().nullable().optional(),
  lineItemKey: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  quantity: z.number(),
  unitPrice: z.number().nullable().optional(),
  warehouseLocation: z.string().nullable().optional(),
});

const shipStationShipmentSchema = z.object({
  shipmentId: z.number(),
  orderId: z.number().nullable().optional(),
  orderNumber: z.string().nullable().optional(),
  orderKey: z.string().nullable().optional(),
  trackingNumber: z.string().nullable().optional(),
  carrierCode: z.string().nullable().optional(),
  serviceCode: z.string().nullable().optional(),
  shipDate: z.string().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  shipmentCost: z.number().nullable().optional(),
  voidDate: z.string().nullable().optional(),
  voided: z.boolean().optional(),
  shipTo: shipStationAddressSchema.nullable().optional(),
  weight: z
    .object({
      value: z.number().nullable().optional(),
      units: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  dimensions: z
    .object({
      length: z.number().nullable().optional(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      units: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  shipmentItems: z.preprocess((v) => v ?? [], z.array(shipStationItemSchema)),
  storeId: z.number().nullable().optional(),
  advancedOptions: z
    .object({
      storeId: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  createDate: z.string().nullable().optional(),
});

export type ShipStationShipment = z.infer<typeof shipStationShipmentSchema>;

const shipmentsListResponseSchema = z.object({
  shipments: z.array(shipStationShipmentSchema),
  total: z.number(),
  page: z.number(),
  pages: z.number(),
});

// === Orders Schema (separate from Shipments — different shape) ===
// advancedOptions.storeId overrides storeId for marketplace integrations
// (Amazon, eBay, etc.). Always resolve via: advancedOptions?.storeId ?? storeId

const shipStationOrderSchema = z.object({
  orderId: z.number(),
  orderNumber: z.string(),
  orderKey: z.string().nullable().optional(),
  orderDate: z.string().nullable().optional(),
  orderStatus: z.string(),
  customerUsername: z.string().nullable().optional(),
  customerEmail: z.string().nullable().optional(),
  shipTo: shipStationAddressSchema.nullable().optional(),
  items: z.preprocess((v) => v ?? [], z.array(shipStationItemSchema)),
  amountPaid: z.number().nullable().optional(),
  shippingAmount: z.number().nullable().optional(),
  taxAmount: z.number().nullable().optional(),
  storeId: z.number().nullable().optional(),
  advancedOptions: z
    .object({
      storeId: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  createDate: z.string().nullable().optional(),
  modifyDate: z.string().nullable().optional(),
});

export type ShipStationOrder = z.infer<typeof shipStationOrderSchema>;

const ordersListResponseSchema = z.object({
  orders: z.array(shipStationOrderSchema),
  total: z.number(),
  page: z.number(),
  pages: z.number(),
});

const shipStationStoreSchema = z.object({
  storeId: z.number(),
  storeName: z.string(),
  marketplaceName: z.string(),
  active: z.boolean().optional(),
});

export type ShipStationStore = z.infer<typeof shipStationStoreSchema>;

// SHIP_NOTIFY webhook payload
const shipNotifyPayloadSchema = z.object({
  resource_url: z.string(),
  resource_type: z.literal("SHIP_NOTIFY"),
});

export type ShipNotifyPayload = z.infer<typeof shipNotifyPayloadSchema>;

// === Signature Verification ===

export async function verifyShipStationSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = Buffer.from(sig).toString("base64");
  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// === API Methods ===

export interface FetchShipmentsParams {
  shipDateStart?: string;
  shipDateEnd?: string;
  page?: number;
  pageSize?: number;
  storeId?: number;
  sortBy?: string;
  sortDir?: "ASC" | "DESC";
  includeShipmentItems?: boolean;
}

/**
 * Convert any date string to ShipStation format: "YYYY-MM-DD HH:MM:SS"
 * ShipStation rejects ISO 8601 T-separator and timezone suffixes.
 */
function toShipStationDate(iso: string): string {
  const d = new Date(iso);
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

export async function fetchShipments(params: FetchShipmentsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.shipDateStart)
    searchParams.set("shipDateStart", toShipStationDate(params.shipDateStart));
  if (params.shipDateEnd) searchParams.set("shipDateEnd", toShipStationDate(params.shipDateEnd));
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pageSize) searchParams.set("pageSize", String(params.pageSize));
  if (params.storeId) searchParams.set("storeId", String(params.storeId));
  if (params.sortBy) searchParams.set("sortBy", params.sortBy);
  if (params.sortDir) searchParams.set("sortDir", params.sortDir);
  if (params.includeShipmentItems) searchParams.set("includeShipmentItems", "True");

  const query = searchParams.toString();
  const path = `/shipments${query ? `?${query}` : ""}`;
  const raw = await shipstationFetch<unknown>(path);
  return shipmentsListResponseSchema.parse(raw);
}

export interface FetchOrdersParams {
  orderStatus?: string; // 'awaiting_shipment' | 'shipped' | 'awaiting_payment' | 'all'
  page?: number;
  pageSize?: number;
  storeId?: number;
  sortBy?: string;
  sortDir?: "ASC" | "DESC";
  createDateStart?: string;
  createDateEnd?: string;
  modifyDateStart?: string;
  modifyDateEnd?: string;
}

export async function fetchOrders(params: FetchOrdersParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.orderStatus) searchParams.set("orderStatus", params.orderStatus);
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pageSize) searchParams.set("pageSize", String(params.pageSize));
  if (params.storeId) searchParams.set("storeId", String(params.storeId));
  if (params.sortBy) searchParams.set("sortBy", params.sortBy);
  if (params.sortDir) searchParams.set("sortDir", params.sortDir);
  if (params.createDateStart)
    searchParams.set("createDateStart", toShipStationDate(params.createDateStart));
  if (params.createDateEnd)
    searchParams.set("createDateEnd", toShipStationDate(params.createDateEnd));
  if (params.modifyDateStart)
    searchParams.set("modifyDateStart", toShipStationDate(params.modifyDateStart));
  if (params.modifyDateEnd)
    searchParams.set("modifyDateEnd", toShipStationDate(params.modifyDateEnd));

  const query = searchParams.toString();
  const path = `/orders${query ? `?${query}` : ""}`;
  const raw = await shipstationFetch<unknown>(path);
  return ordersListResponseSchema.parse(raw);
}

export async function fetchStores() {
  const raw = await shipstationFetch<unknown[]>("/stores");
  return z.array(shipStationStoreSchema).parse(raw);
}

export function parseShipNotifyPayload(rawBody: string): ShipNotifyPayload {
  const parsed = JSON.parse(rawBody);
  return shipNotifyPayloadSchema.parse(parsed);
}

/**
 * Fetch the shipments listed in a SHIP_NOTIFY `resource_url`.
 *
 * SHIP_NOTIFY does NOT inline the shipment payload — it sends a URL that
 * the receiver must call back with the same Basic auth used for `/shipments`.
 * The URL ShipStation sends always lives under `ssapi.shipstation.com`
 * (validated below) so we never follow an attacker-controlled host.
 *
 * Returns the parsed list (the URL typically resolves to a single
 * shipment but ShipStation can batch multiple recently-shipped shipments
 * into one notification, so callers MUST iterate the array).
 */
export async function fetchShipmentsByResourceUrl(
  resourceUrl: string,
): Promise<ShipStationShipment[]> {
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl);
  } catch {
    throw new Error(`Invalid SHIP_NOTIFY resource_url: ${resourceUrl}`);
  }
  // Refuse anything outside the v1 host; SHIP_NOTIFY is a v1 webhook and
  // the URL is always rooted at ssapi.shipstation.com per ShipStation's docs.
  if (parsed.host !== "ssapi.shipstation.com") {
    throw new Error(
      `Refusing to follow SHIP_NOTIFY resource_url outside ssapi.shipstation.com: host=${parsed.host}`,
    );
  }

  // Always include shipment items so the processor sees SKUs without a
  // second round-trip per shipment.
  if (!parsed.searchParams.has("includeShipmentItems")) {
    parsed.searchParams.set("includeShipmentItems", "True");
  }

  const path = `${parsed.pathname}${parsed.search}`;
  const raw = await shipstationFetch<unknown>(path);
  return shipmentsListResponseSchema.parse(raw).shipments;
}

// === Products + Aliases (Phase 0.5 SKU rectify) ============================
//
// ShipStation v1 `/products` is the ONLY surface that exposes the
// `aliases[]` array used by Inventory Sync to map cross-store SKUs onto a
// single master product. v2 has no equivalent — aliases are a v1-only
// concept. See plan §10 / §7.1.10 for why aliases beat renames as the
// primary rectify primitive.
//
// CRITICAL: `PUT /products/{productId}` is a FULL-RESOURCE replacement, not
// a patch. Every caller MUST first GET the current resource, mutate the
// fields it owns, then PUT the entire merged body back. Any field omitted
// from the PUT body is cleared. Concurrency hazards (lost-update on the
// aliases array) are addressed at the task layer via a per-product Redis
// mutex (see `src/trigger/lib/redis-mutex.ts` and the rectify task).

const shipStationProductAliasSchema = z.object({
  // ShipStation's docs use `name` for the alias SKU string. We re-export it
  // as `sku` for ergonomic call-sites; the wire format keeps `name`.
  name: z.string(),
  storeId: z.number().nullable().optional(),
  storeName: z.string().nullable().optional(),
});

export type ShipStationProductAlias = z.infer<typeof shipStationProductAliasSchema>;

const shipStationProductSchema = z
  .object({
    productId: z.number(),
    sku: z.string(),
    name: z.string().nullable().optional(),
    // Aliases is the field we mutate in rectify. Always treat as an array;
    // ShipStation returns `null` for products with no aliases configured.
    aliases: z.preprocess((v) => v ?? [], z.array(shipStationProductAliasSchema)),
    // We pass these through unchanged so the full-resource PUT does not
    // accidentally clear them. New fields ShipStation may return in the
    // future are preserved via `.passthrough()` on the parent object below.
    price: z.number().nullable().optional(),
    defaultCost: z.number().nullable().optional(),
    weightOz: z.number().nullable().optional(),
    length: z.number().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    active: z.boolean().nullable().optional(),
    productCategory: z
      .object({
        categoryId: z.number().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    productType: z.string().nullable().optional(),
    warehouseLocation: z.string().nullable().optional(),
    defaultCarrierCode: z.string().nullable().optional(),
    defaultServiceCode: z.string().nullable().optional(),
    defaultPackageCode: z.string().nullable().optional(),
    defaultIntlCarrierCode: z.string().nullable().optional(),
    defaultIntlServiceCode: z.string().nullable().optional(),
    defaultIntlPackageCode: z.string().nullable().optional(),
    defaultConfirmation: z.string().nullable().optional(),
    defaultIntlConfirmation: z.string().nullable().optional(),
    customsDescription: z.string().nullable().optional(),
    customsValue: z.number().nullable().optional(),
    customsTariffNo: z.string().nullable().optional(),
    customsCountryCode: z.string().nullable().optional(),
    noCustoms: z.boolean().nullable().optional(),
    tags: z.array(z.unknown()).nullable().optional(),
    createDate: z.string().nullable().optional(),
    modifyDate: z.string().nullable().optional(),
  })
  // Critical: passthrough preserves ShipStation fields we don't yet model so
  // the full-resource PUT round-trip does not silently drop them.
  .passthrough();

export type ShipStationProduct = z.infer<typeof shipStationProductSchema>;

const productsListResponseSchema = z.object({
  products: z.array(shipStationProductSchema),
  total: z.number(),
  page: z.number(),
  pages: z.number(),
});

export interface FetchProductsParams {
  sku?: string;
  productCategoryId?: number;
  productTypeId?: number;
  tagId?: number;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortDir?: "ASC" | "DESC";
  page?: number;
  pageSize?: number;
  showInactive?: boolean;
}

/**
 * Search products with filters. Used by the audit task to walk the catalog
 * page-by-page and by `getProductBySku()` below for exact lookups.
 */
export async function fetchProducts(params: FetchProductsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.sku) searchParams.set("sku", params.sku);
  if (params.productCategoryId !== undefined)
    searchParams.set("productCategoryId", String(params.productCategoryId));
  if (params.productTypeId !== undefined)
    searchParams.set("productTypeId", String(params.productTypeId));
  if (params.tagId !== undefined) searchParams.set("tagId", String(params.tagId));
  if (params.startDate) searchParams.set("startDate", toShipStationDate(params.startDate));
  if (params.endDate) searchParams.set("endDate", toShipStationDate(params.endDate));
  if (params.sortBy) searchParams.set("sortBy", params.sortBy);
  if (params.sortDir) searchParams.set("sortDir", params.sortDir);
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pageSize) searchParams.set("pageSize", String(params.pageSize));
  if (params.showInactive !== undefined)
    searchParams.set("showInactive", params.showInactive ? "True" : "False");

  const query = searchParams.toString();
  const path = `/products${query ? `?${query}` : ""}`;
  const raw = await shipstationFetch<unknown>(path);
  return productsListResponseSchema.parse(raw);
}

/**
 * Exact-match lookup by master SKU. Returns the single product if exactly
 * one match exists, null if none, throws if multiple (ShipStation should
 * never return multiple but the validation surfaces upstream data integrity
 * issues immediately rather than letting them propagate into rectify).
 */
export async function getProductBySku(sku: string): Promise<ShipStationProduct | null> {
  const result = await fetchProducts({ sku, pageSize: 50 });
  const exact = result.products.filter((p) => p.sku === sku);
  if (exact.length === 0) return null;
  if (exact.length > 1) {
    throw new Error(
      `ShipStation v1 returned ${exact.length} products with sku=${sku}; expected at most 1`,
    );
  }
  return exact[0];
}

export async function getProduct(productId: number): Promise<ShipStationProduct> {
  const raw = await shipstationFetch<unknown>(`/products/${productId}`);
  return shipStationProductSchema.parse(raw);
}

/**
 * Full-resource PUT. Caller MUST pass a complete product body — every list
 * field (notably `aliases[]`) that should survive must be in the payload.
 * Returns the parsed response so the caller can verify the write landed.
 */
export async function putProduct(
  productId: number,
  body: ShipStationProduct,
): Promise<ShipStationProduct> {
  const raw = await shipstationFetch<unknown>(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return shipStationProductSchema.parse(raw);
}

/**
 * GET-merge-PUT helper for adding a single alias to a product. The `current`
 * argument is REQUIRED — callers MUST pass the resource snapshot they took
 * inside their mutex window (see plan §7.1.10). Pass `current` even if you
 * just GET it one line above to make the contract explicit at the call-site.
 *
 * Idempotent: if `aliasSku` already exists in `current.aliases`, this
 * returns `current` without issuing a PUT.
 */
export async function addAliasToProduct({
  current,
  aliasSku,
  storeId,
  storeName,
}: {
  current: ShipStationProduct;
  aliasSku: string;
  storeId?: number;
  storeName?: string;
}): Promise<ShipStationProduct> {
  if (current.aliases.some((a) => a.name === aliasSku)) {
    return current;
  }
  const next: ShipStationProduct = {
    ...current,
    aliases: [
      ...current.aliases,
      {
        name: aliasSku,
        storeId: storeId ?? null,
        storeName: storeName ?? null,
      },
    ],
  };
  return putProduct(current.productId, next);
}

/**
 * GET-merge-PUT helper for removing a single alias. Idempotent: if the SKU
 * is not in the aliases array, returns `current` without a PUT.
 */
export async function removeAliasFromProduct({
  current,
  aliasSku,
}: {
  current: ShipStationProduct;
  aliasSku: string;
}): Promise<ShipStationProduct> {
  if (!current.aliases.some((a) => a.name === aliasSku)) {
    return current;
  }
  const next: ShipStationProduct = {
    ...current,
    aliases: current.aliases.filter((a) => a.name !== aliasSku),
  };
  return putProduct(current.productId, next);
}

// Exported for testing
export {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  rateLimitState,
  shipStationProductSchema,
  shipStationShipmentSchema,
};
