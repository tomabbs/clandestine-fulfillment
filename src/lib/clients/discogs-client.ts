/**
 * Discogs API client.
 *
 * Used for both:
 *   - Clandestine master catalog (Personal Access Token via discogs_credentials)
 *   - Client store connections (OAuth 1.0a tokens via client_store_connections)
 *
 * IMPORTANT: Redis-backed rate limiting is applied before EVERY API call.
 * In-memory rate limiting does not work across serverless instances.
 *
 * Rule #5: Zod validation on all API responses.
 */

import { z } from "zod";
import { waitForDiscogsRateLimit } from "./discogs-rate-limiter";

const DISCOGS_BASE_URL = "https://api.discogs.com";
const USER_AGENT = "ClandestineFulfillment/1.0";

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface DiscogsAuthConfig {
  /** Personal Access Token (Clandestine master catalog) */
  accessToken?: string;
  /** OAuth 1.0a — consumer key/secret from env */
  consumerKey?: string;
  consumerSecret?: string;
  /** OAuth 1.0a — per-org token from client_store_connections */
  oauthToken?: string;
  oauthTokenSecret?: string;
}

function buildAuthHeader(config: DiscogsAuthConfig): string {
  if (config.accessToken) {
    return `Discogs token=${config.accessToken}`;
  }

  if (config.oauthToken && config.oauthTokenSecret && config.consumerKey && config.consumerSecret) {
    // OAuth 1.0a PLAINTEXT signature
    return (
      `OAuth oauth_consumer_key="${config.consumerKey}", ` +
      `oauth_token="${config.oauthToken}", ` +
      `oauth_signature_method="PLAINTEXT", ` +
      `oauth_signature="${config.consumerSecret}&${config.oauthTokenSecret}", ` +
      `oauth_timestamp="${Math.floor(Date.now() / 1000)}", ` +
      `oauth_nonce="${Math.random().toString(36).slice(2)}"`
    );
  }

  throw new Error("DiscogsAuthConfig must provide accessToken OR full OAuth credentials");
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const releaseSearchResultSchema = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string(),
  thumb: z.string().optional(),
  cover_image: z.string().optional(),
  uri: z.string(),
  catno: z.string().optional(),
  format: z.array(z.string()).optional(),
  label: z.array(z.string()).optional(),
  year: z.string().optional(),
  country: z.string().optional(),
  barcode: z.array(z.string()).optional(),
  master_id: z.number().optional(),
  resource_url: z.string(),
});

const listingSchema = z.object({
  id: z.number(),
  status: z.string(),
  condition: z.string(),
  sleeve_condition: z.string().optional(),
  price: z.object({ value: z.number(), currency: z.string() }),
  release: z.object({
    id: z.number(),
    description: z.string(),
  }),
  external_id: z.string().optional(),
});

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  created: z.string(),
  last_activity: z.string(),
  buyer: z.object({
    id: z.number(),
    username: z.string(),
  }),
  total: z.object({ value: z.number(), currency: z.string() }),
  shipping: z
    .object({
      value: z.number(),
      currency: z.string(),
      method: z.string().optional(),
    })
    .optional(),
  shipping_address: z.string().optional(),
  items: z.array(
    z.object({
      id: z.number(),
      release: z.object({
        id: z.number(),
        description: z.string(),
      }),
      price: z.object({ value: z.number(), currency: z.string() }),
      media_condition: z.string(),
      sleeve_condition: z.string().optional(),
    }),
  ),
});

const messageSchema = z.object({
  from: z.object({
    id: z.number(),
    username: z.string(),
  }),
  timestamp: z.string(),
  message: z.string().optional(),
  type: z.string(),
  status: z.string().optional(),
});

export type DiscogsRelease = z.infer<typeof releaseSearchResultSchema>;
export type DiscogsListing = z.infer<typeof listingSchema>;
export type DiscogsOrder = z.infer<typeof orderSchema>;
export type DiscogsMessage = z.infer<typeof messageSchema>;

// ── Core fetch ────────────────────────────────────────────────────────────────

async function discogsFetch<T>(
  path: string,
  config: DiscogsAuthConfig,
  options: { method?: string; body?: unknown } = {},
  retryCount = 0,
): Promise<T> {
  // CRITICAL: Wait for rate limit BEFORE every request (Redis-backed, serverless-safe)
  await waitForDiscogsRateLimit();

  const res = await fetch(`${DISCOGS_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: buildAuthHeader(config),
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 429) {
    // Discogs rate-limited us despite our own tracking — wait 60s and retry once
    if (retryCount >= 1) {
      throw new Error("Discogs API: rate limited even after 60s wait — aborting");
    }
    console.warn("[discogs-client] Got 429 despite rate limiting, waiting 60s");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return discogsFetch<T>(path, config, options, retryCount + 1);
  }

  if (res.status === 204) {
    return {} as T;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discogs API ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchReleases(
  config: DiscogsAuthConfig,
  params: {
    barcode?: string;
    catno?: string;
    artist?: string;
    title?: string;
    label?: string;
    format?: string;
    perPage?: number;
  },
): Promise<DiscogsRelease[]> {
  const query = new URLSearchParams({ type: "release" });

  if (params.barcode) query.set("barcode", params.barcode.replace(/[\s-]/g, ""));
  if (params.catno) query.set("catno", params.catno);
  if (params.artist) query.set("artist", params.artist);
  if (params.title) query.set("release_title", params.title);
  if (params.label) query.set("label", params.label);
  if (params.format) query.set("format", params.format);
  query.set("per_page", String(params.perPage ?? 25));

  const response = await discogsFetch<{ results: unknown[] }>(`/database/search?${query}`, config);

  return response.results.map((r) => releaseSearchResultSchema.parse(r));
}

// ── Listings ──────────────────────────────────────────────────────────────────

export async function createListing(
  config: DiscogsAuthConfig,
  params: {
    releaseId: number;
    condition: string;
    sleeveCondition?: string;
    price: number;
    status?: "For Sale" | "Draft";
    comments?: string;
    allowOffers?: boolean;
    externalId?: string;
    location?: string;
  },
): Promise<{ listingId: number }> {
  const response = await discogsFetch<{ listing_id: number }>("/marketplace/listings", config, {
    method: "POST",
    body: {
      release_id: params.releaseId,
      condition: params.condition,
      sleeve_condition: params.sleeveCondition,
      price: params.price,
      status: params.status ?? "For Sale",
      comments: params.comments,
      allow_offers: params.allowOffers ?? true,
      external_id: params.externalId,
      location: params.location,
    },
  });

  return { listingId: response.listing_id };
}

export async function deleteListing(config: DiscogsAuthConfig, listingId: number): Promise<void> {
  await discogsFetch(`/marketplace/listings/${listingId}`, config, { method: "DELETE" });
}

export async function getInventory(
  config: DiscogsAuthConfig,
  username: string,
  params?: { status?: string; page?: number; perPage?: number },
): Promise<{ listings: DiscogsListing[]; pages: number }> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  query.set("page", String(params?.page ?? 1));
  query.set("per_page", String(params?.perPage ?? 100));

  const response = await discogsFetch<{
    listings: unknown[];
    pagination: { pages: number };
  }>(`/users/${username}/inventory?${query}`, config);

  return {
    listings: response.listings.map((l) => listingSchema.parse(l)),
    pages: response.pagination.pages,
  };
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function getOrders(
  config: DiscogsAuthConfig,
  params?: {
    status?: string;
    createdAfter?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    page?: number;
    perPage?: number;
  },
): Promise<{ orders: DiscogsOrder[]; pages: number }> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.createdAfter) query.set("created_after", params.createdAfter);
  query.set("sort", params?.sortBy ?? "last_activity");
  query.set("sort_order", params?.sortOrder ?? "desc");
  query.set("page", String(params?.page ?? 1));
  query.set("per_page", String(params?.perPage ?? 50));

  const response = await discogsFetch<{
    orders: unknown[];
    pagination: { pages: number };
  }>(`/marketplace/orders?${query}`, config);

  return {
    orders: response.orders.map((o) => orderSchema.parse(o)),
    pages: response.pagination.pages,
  };
}

export async function getOrder(config: DiscogsAuthConfig, orderId: string): Promise<DiscogsOrder> {
  const response = await discogsFetch<unknown>(`/marketplace/orders/${orderId}`, config);
  return orderSchema.parse(response);
}

export async function getOrderMessages(
  config: DiscogsAuthConfig,
  orderId: string,
): Promise<DiscogsMessage[]> {
  const response = await discogsFetch<{ messages: unknown[] }>(
    `/marketplace/orders/${orderId}/messages`,
    config,
  );
  return response.messages.map((m) => messageSchema.parse(m));
}

export async function sendOrderMessage(
  config: DiscogsAuthConfig,
  orderId: string,
  params: {
    message?: string;
    status?: string;
  },
): Promise<void> {
  await discogsFetch(`/marketplace/orders/${orderId}/messages`, config, {
    method: "POST",
    body: params,
  });
}

export async function markOrderShipped(
  config: DiscogsAuthConfig,
  orderId: string,
  trackingNumber: string,
  carrier?: string,
): Promise<void> {
  await sendOrderMessage(config, orderId, {
    message: `Your order has shipped! Tracking: ${trackingNumber}${carrier ? ` via ${carrier}` : ""}`,
    status: "Shipped",
  });
}

// ── Identity ──────────────────────────────────────────────────────────────────

export async function getIdentity(
  config: DiscogsAuthConfig,
): Promise<{ username: string; id: number }> {
  const response = await discogsFetch<{ username: string; id: number }>("/oauth/identity", config);
  return response;
}
