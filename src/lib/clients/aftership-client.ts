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

const createTrackingResponseSchema = z.object({
  data: z.object({ tracking: trackingSchema }),
});

const getTrackingResponseSchema = z.object({
  data: z.object({ tracking: trackingSchema }),
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
  const res = await fetch(`https://api.aftership.com/v4${path}`, {
    method: options.method ?? "GET",
    headers: {
      "aftership-api-key": apiKey,
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

export async function createTracking(
  trackingNumber: string,
  carrier: string,
  metadata?: Record<string, unknown>,
): Promise<AfterShipTracking> {
  const response = await aftershipFetch<z.infer<typeof createTrackingResponseSchema>>(
    "/trackings",
    {
      method: "POST",
      body: {
        tracking: {
          tracking_number: trackingNumber,
          slug: normalizeCarrierSlug(carrier),
          ...(metadata?.title ? { title: metadata.title } : {}),
          ...(metadata?.orderId ? { order_id: metadata.orderId } : {}),
        },
      },
    },
  );

  return createTrackingResponseSchema.parse(response).data.tracking;
}

export async function getTracking(
  trackingNumber: string,
  carrier: string,
): Promise<AfterShipTracking> {
  const slug = normalizeCarrierSlug(carrier);
  const response = await aftershipFetch<z.infer<typeof getTrackingResponseSchema>>(
    `/trackings/${slug}/${trackingNumber}`,
  );

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
  };
  return slugMap[normalized] ?? normalized;
}
