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

const shipStationStoreSchema = z.object({
  storeId: z.number(),
  storeName: z.string(),
  marketplaceName: z.string(),
  active: z.boolean().optional(),
});

export type ShipStationStore = z.infer<typeof shipStationStoreSchema>;

// === API Methods ===

export async function fetchStores() {
  const raw = await shipstationFetch<unknown[]>("/stores");
  return z.array(shipStationStoreSchema).parse(raw);
}
