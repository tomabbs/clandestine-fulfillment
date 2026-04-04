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

// Exported for testing
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, rateLimitState, shipStationShipmentSchema };
