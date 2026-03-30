/**
 * AfterShip API client.
 * Uses AFTERSHIP_API_KEY from env. Zod validation on responses (Rule #5).
 */

import { z } from "zod";
import { env } from "@/lib/shared/env";

const trackingSchema = z.object({
  id: z.string(),
  tracking_number: z.string(),
  slug: z.string(),
  active: z.boolean().optional(),
  tag: z.string().optional(),
  title: z.string().optional(),
  checkpoints: z
    .array(
      z.object({
        slug: z.string().optional(),
        tag: z.string(),
        message: z.string().optional(),
        location: z.string().nullish(),
        checkpoint_time: z.string(),
        subtag: z.string().optional(),
        subtag_message: z.string().optional(),
        city: z.string().nullish(),
        state: z.string().nullish(),
        country_name: z.string().nullish(),
      }),
    )
    .optional()
    .default([]),
});

// New 2024-07 API: tracking object is directly at data, not nested at data.tracking
const createTrackingResponseSchema = z.object({
  meta: z.object({ code: z.number() }),
  data: trackingSchema.or(z.object({ tracking: trackingSchema })).or(z.object({})),
});

const getTrackingResponseSchema = z.object({
  meta: z.object({ code: z.number() }).optional(),
  data: z.object({
    tracking: trackingSchema.optional(),
    trackings: z.array(trackingSchema).optional(),
  }).optional(),
});

export type AfterShipTracking = z.infer<typeof trackingSchema>;
export type AfterShipCheckpoint = AfterShipTracking["checkpoints"][number];

function getApiKey(): string {
  return env().AFTERSHIP_API_KEY;
}

async function aftershipFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const apiKey = getApiKey();
  // AfterShip migrated to versioned API — asat_ keys require the new endpoint + as-api-key header
  const res = await fetch(`https://api.aftership.com/tracking/2024-07${path}`, {
    method: options.method ?? "GET",
    headers: {
      "as-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AfterShip API ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

export interface CreateTrackingOptions {
  title?: string;
  orderId?: string;
  emails?: string[];
  customerName?: string;
}

export async function createTracking(
  trackingNumber: string,
  carrier: string,
  options?: CreateTrackingOptions,
): Promise<AfterShipTracking> {
  // New 2024-07 API: body is flat (no nested "tracking" wrapper)
  const response = await aftershipFetch<z.infer<typeof createTrackingResponseSchema>>(
    "/trackings",
    {
      method: "POST",
      body: {
        tracking_number: trackingNumber,
        slug: normalizeCarrierSlug(carrier),
        ...(options?.title ? { title: options.title } : {}),
        ...(options?.orderId ? { order_id: options.orderId } : {}),
        ...(options?.emails?.length ? { emails: options.emails } : {}),
        ...(options?.customerName ? { customer_name: options.customerName } : {}),
      },
    },
  );

  const parsed = createTrackingResponseSchema.parse(response);
  // New API returns tracking directly at data; old API nested it at data.tracking
  const data = parsed.data as Record<string, unknown>;
  if (data && "id" in data) {
    return trackingSchema.parse(data);
  }
  if (data && "tracking" in data) {
    return trackingSchema.parse(data.tracking);
  }
  throw new Error("Unexpected AfterShip create response shape");
}

export async function getTracking(
  trackingNumber: string,
  carrier: string,
): Promise<AfterShipTracking> {
  const slug = normalizeCarrierSlug(carrier);
  // New 2024-07 API: use query params instead of slug/number path
  const response = await aftershipFetch<z.infer<typeof getTrackingResponseSchema>>(
    `/trackings?tracking_number=${encodeURIComponent(trackingNumber)}&slug=${encodeURIComponent(slug)}&limit=1`,
  );
  // Response is a list — take first match
  const trackings = (response as unknown as { data: { trackings?: AfterShipTracking[] } })?.data?.trackings;
  if (trackings?.length) {
    return trackings[0];
  }
  return getTrackingResponseSchema.parse(response).data.tracking;
}

/**
 * Normalize carrier names to AfterShip slugs.
 */
export function normalizeCarrierSlug(carrier: string): string {
  const normalized = carrier.toLowerCase().trim();
  const slugMap: Record<string, string> = {
    usps: "usps",
    ups: "ups",
    fedex: "fedex",
    dhl: "dhl",
    "dhl express": "dhl",
    "dhl ecommerce": "dhl-ecommerce",
    "canada post": "canada-post",
    "royal mail": "royal-mail",
    "australia post": "australia-post",
    pirateship: "usps",
    "pirate ship": "usps",
    // Stamps.com ships via USPS — all ShipStation Stamps.com labels are USPS
    stamps_com: "usps",
    "stamps.com": "usps",
    stamps: "usps",
  };
  return slugMap[normalized] ?? normalized;
}
