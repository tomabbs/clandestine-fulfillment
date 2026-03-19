import { z } from "zod";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

// === Zod schemas for API responses (Rule #5) ===

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

const bandSchema = z.object({
  band_id: z.number(),
  name: z.string(),
  subdomain: z.string().optional(),
  member_bands: z
    .array(
      z.object({
        band_id: z.number(),
        name: z.string(),
      }),
    )
    .optional(),
});

const myBandsResponseSchema = z.object({
  bands: z.preprocess((v) => v ?? [], z.array(bandSchema)),
});

const merchItemSchema = z.object({
  package_id: z.number(),
  title: z.string(),
  album_title: z.string().nullish(),
  sku: z.string().nullish(),
  item_type: z.string().nullish(),
  member_band_id: z.number().nullish(),
  new_date: z.string().nullish(),
  price: z.number().nullish(),
  currency: z.string().nullish(),
  quantity_available: z.number().nullish(),
  quantity_sold: z.number().nullish(),
  origin_quantity: z.number().nullish(),
  url: z.string().nullish(),
  image_url: z.string().nullish(),
});

const merchDetailsResponseSchema = z.object({
  items: z.preprocess((v) => v ?? [], z.array(merchItemSchema)),
});

export type BandcampMerchItem = z.infer<typeof merchItemSchema>;
export type BandcampBand = z.infer<typeof bandSchema>;

// === Error handling (Rule #24) ===

async function createReviewQueueItem(
  workspaceId: string,
  orgId: string | null,
  title: string,
  description: string,
  metadata: Record<string, unknown>,
  groupKey: string,
) {
  const supabase = createServiceRoleClient();
  await supabase.from("warehouse_review_queue").upsert(
    {
      workspace_id: workspaceId,
      org_id: orgId,
      category: "bandcamp_sync",
      severity: "medium" as const,
      title,
      description,
      metadata,
      status: "open" as const,
      group_key: groupKey,
      occurrence_count: 1,
    },
    { onConflict: "group_key", ignoreDuplicates: false },
  );
}

// === Token refresh (single-writer via bandcampQueue) ===

export async function refreshBandcampToken(workspaceId: string): Promise<string> {
  const supabase = createServiceRoleClient();
  const { BANDCAMP_CLIENT_ID, BANDCAMP_CLIENT_SECRET } = env();

  const { data: creds, error: credsError } = await supabase
    .from("bandcamp_credentials")
    .select("*")
    .eq("workspace_id", workspaceId)
    .single();

  if (credsError || !creds?.refresh_token) {
    throw new Error(`No Bandcamp credentials found for workspace ${workspaceId}`);
  }

  const response = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BANDCAMP_CLIENT_ID,
      client_secret: BANDCAMP_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    await createReviewQueueItem(
      workspaceId,
      null,
      "Bandcamp token refresh failed",
      `HTTP ${response.status}: ${errorText}`,
      { status: response.status, error: errorText },
      `bandcamp_token_refresh_${workspaceId}`,
    );
    throw new Error(`Bandcamp token refresh failed: ${response.status}`);
  }

  const parsed = tokenResponseSchema.parse(await response.json());

  const { error: updateError } = await supabase
    .from("bandcamp_credentials")
    .update({
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      token_expires_at: new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId);

  if (updateError) {
    throw new Error(`Failed to store refreshed Bandcamp token: ${updateError.message}`);
  }

  return parsed.access_token;
}

// === API methods ===

export async function getMyBands(accessToken: string): Promise<BandcampBand[]> {
  // Bandcamp API requires POST for all endpoints
  const response = await fetch("https://bandcamp.com/api/account/1/my_bands", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`getMyBands failed: ${response.status}`);
  }

  const json = await response.json();

  // Bandcamp returns { error: true, error_message: "..." } on failures even with HTTP 200
  if (json.error) {
    throw new Error(`getMyBands API error: ${json.error_message ?? "unknown"}`);
  }

  const data = myBandsResponseSchema.parse(json);
  return data.bands;
}

export async function getMerchDetails(
  bandId: number,
  accessToken: string,
): Promise<BandcampMerchItem[]> {
  const response = await fetch("https://bandcamp.com/api/merchorders/1/get_merch_details", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ band_id: bandId, start_time: "2000-01-01 00:00:00" }),
  });

  if (!response.ok) {
    throw new Error(`getMerchDetails failed for band ${bandId}: ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(
      `getMerchDetails API error for band ${bandId}: ${json.error_message ?? "unknown"}`,
    );
  }

  const data = merchDetailsResponseSchema.parse(json);
  return data.items;
}

export async function updateQuantities(
  items: Array<{
    item_id: number;
    item_type: string;
    quantity_available: number;
    quantity_sold: number;
  }>,
  accessToken: string,
): Promise<void> {
  const response = await fetch("https://bandcamp.com/api/merchorders/1/update_quantities", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    throw new Error(`updateQuantities failed: ${response.status}`);
  }
}

// === Image URL helpers ===

/**
 * Bandcamp API returns tiny thumbnail URLs (e.g. _36.jpg = 36px).
 * Replace the size suffix with _10.jpg for 700px standard display size.
 */
export function bandcampImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/_\d+\.jpg$/, "_10.jpg");
}

// === Title assembly for Shopify product creation ===

/**
 * Build a product title from Bandcamp merch item metadata.
 *
 * Artist name is the band/performer — MUST be in the title for identification.
 * Vendor/org is stored separately and should NOT be duplicated here.
 *
 * Format:
 *   - "{artistName} - {itemTitle}" when artist exists and differs from itemTitle
 *   - "{itemTitle}" when artist is empty, null, or same as itemTitle
 */
export function assembleBandcampTitle(
  artistName: string,
  _albumTitle: string | null | undefined,
  itemTitle: string,
): string {
  const artist = artistName?.trim();
  if (artist && artist !== itemTitle) {
    return `${artist} - ${itemTitle}`;
  }
  return itemTitle;
}

// === SKU matching ===

export function matchSkuToVariants(
  merchItems: BandcampMerchItem[],
  variants: Array<{ id: string; sku: string }>,
): {
  matched: Array<{ merchItem: BandcampMerchItem; variantId: string }>;
  unmatched: BandcampMerchItem[];
} {
  const skuMap = new Map(variants.map((v) => [v.sku, v.id]));
  const matched: Array<{ merchItem: BandcampMerchItem; variantId: string }> = [];
  const unmatched: BandcampMerchItem[] = [];

  for (const item of merchItems) {
    if (item.sku) {
      const variantId = skuMap.get(item.sku);
      if (variantId) {
        matched.push({ merchItem: item, variantId });
      } else {
        unmatched.push(item);
      }
    }
  }

  return { matched, unmatched };
}
