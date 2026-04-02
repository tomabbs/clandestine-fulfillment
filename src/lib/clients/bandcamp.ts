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
        subdomain: z.string().optional(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

const myBandsResponseSchema = z.object({
  bands: z.preprocess((v) => v ?? [], z.array(bandSchema)),
});

const merchOptionSchema = z.object({
  option_id: z.number(),
  title: z.string().nullish(),
  sku: z.string().nullish(),
  quantity_available: z.number().nullish(),
  quantity_sold: z.number().nullish(),
}).passthrough();

const originQuantitySchema = z.object({
  origin_id: z.number(),
  quantity_available: z.number().nullish(),
  quantity_sold: z.number().nullish(),
  option_quantities: z.array(z.object({
    option_id: z.number(),
    quantity_available: z.number().nullish(),
    quantity_sold: z.number().nullish(),
  }).passthrough()).nullish(),
}).passthrough();

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
  subdomain: z.string().nullish(),
  is_set_price: z.union([z.boolean(), z.number()]).nullish(),
  options: z.array(merchOptionSchema).nullish(),
  origin_quantities: z.array(originQuantitySchema).nullish(),
}).passthrough();

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

// === Orders (get_orders) ===

const bandcampOrderItemSchema = z.object({
  sale_item_id: z.number(),
  payment_id: z.number(),
  order_date: z.string().nullish(),
  paypal_id: z.string().nullish(),
  sku: z.string().nullish(),
  item_name: z.string().nullish(),
  item_url: z.string().nullish(),
  artist: z.string().nullish(),
  option: z.string().nullish(),
  quantity: z.number().nullish(),
  sub_total: z.number().nullish(),
  tax: z.number().nullish(),
  shipping: z.number().nullish(),
  currency: z.string().nullish(),
  order_total: z.number().nullish(),
  buyer_name: z.string().nullish(),
  buyer_email: z.string().nullish(),
  buyer_note: z.string().nullish(),
  ship_notes: z.string().nullish(),
  ship_to_name: z.string().nullish(),
  ship_to_street: z.string().nullish(),
  ship_to_street_2: z.string().nullish(),
  ship_to_city: z.string().nullish(),
  ship_to_state: z.string().nullish(),
  ship_to_zip: z.string().nullish(),
  ship_to_country: z.string().nullish(),
  ship_to_country_code: z.string().nullish(),
  ship_date: z.string().nullish(),
  payment_state: z.string().nullish(),
  ship_from_country_name: z.string().nullish(),
});

const getOrdersResponseSchema = z.object({
  success: z.boolean().optional(),
  items: z.preprocess((v) => v ?? [], z.array(bandcampOrderItemSchema)),
});

export type BandcampOrderItem = z.infer<typeof bandcampOrderItemSchema>;

export interface GetOrdersParams {
  bandId: number;
  memberBandId?: number;
  startTime?: string;
  endTime?: string;
  unshippedOnly?: boolean;
}

export async function getOrders(
  params: GetOrdersParams,
  accessToken: string,
): Promise<BandcampOrderItem[]> {
  const body: Record<string, unknown> = {
    band_id: params.bandId,
    start_time: params.startTime ?? "2000-01-01 00:00:00",
  };
  if (params.memberBandId != null) body.member_band_id = params.memberBandId;
  if (params.endTime != null) body.end_time = params.endTime;
  if (params.unshippedOnly === true) body.unshipped_only = true;

  const response = await fetch("https://bandcamp.com/api/merchorders/4/get_orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`getOrders failed for band ${params.bandId}: ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(
      `getOrders API error for band ${params.bandId}: ${json.error_message ?? "unknown"}`,
    );
  }

  const data = getOrdersResponseSchema.parse(json);
  return data.items;
}

// === Mark shipped (update_shipped v2 — supports carrier + tracking) ===

export interface UpdateShippedItem {
  id: number;
  idType: "p" | "s"; // 'p' = payment, 's' = sale item
  shipped?: boolean;
  notification?: boolean;
  notificationMessage?: string;
  shipDate?: string; // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
  carrier?: string;
  trackingCode?: string;
}

export async function updateShipped(
  items: UpdateShippedItem[],
  accessToken: string,
): Promise<void> {
  const body = {
    items: items.map((item) => ({
      id: item.id,
      id_type: item.idType,
      ...(item.shipped !== undefined && { shipped: item.shipped }),
      ...(item.notification !== undefined && { notification: item.notification }),
      ...(item.notificationMessage != null && { notification_message: item.notificationMessage }),
      ...(item.shipDate != null && { ship_date: item.shipDate }),
      ...(item.carrier != null && { carrier: item.carrier }),
      ...(item.trackingCode != null && { tracking_code: item.trackingCode }),
    })),
  };

  const response = await fetch("https://bandcamp.com/api/merchorders/2/update_shipped", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`updateShipped failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as { error?: boolean; error_message?: string };
  if (json.error) {
    throw new Error(`updateShipped API error: ${json.error_message ?? "unknown"}`);
  }
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
  matched: Array<{ merchItem: BandcampMerchItem; variantId: string; matchedVia: "item_sku" | "option_sku" }>;
  unmatched: BandcampMerchItem[];
} {
  const skuMap = new Map(variants.map((v) => [v.sku, v.id]));
  const matched: Array<{ merchItem: BandcampMerchItem; variantId: string; matchedVia: "item_sku" | "option_sku" }> = [];
  const unmatched: BandcampMerchItem[] = [];

  for (const item of merchItems) {
    // Try item-level SKU first
    if (item.sku) {
      const variantId = skuMap.get(item.sku);
      if (variantId) {
        matched.push({ merchItem: item, variantId, matchedVia: "item_sku" });
        continue;
      }
    }

    // Try option-level SKUs (color/size variants)
    let optionMatched = false;
    if (item.options?.length) {
      for (const opt of item.options) {
        if (opt.sku) {
          const variantId = skuMap.get(opt.sku);
          if (variantId) {
            matched.push({ merchItem: item, variantId, matchedVia: "option_sku" });
            optionMatched = true;
            break;
          }
        }
      }
    }

    if (!optionMatched) {
      if (item.sku || item.options?.some(o => o.sku)) {
        unmatched.push(item);
      }
    }
  }

  return { matched, unmatched };
}

// === Sales Report API (v4) ===

export interface SalesReportItem {
  bandcamp_transaction_id: number;
  bandcamp_transaction_item_id: number;
  bandcamp_related_transaction_id?: number | null;
  date: string;
  paid_to: string;
  item_type: string;
  item_name: string;
  artist: string;
  currency: string;
  item_price: number;
  quantity: number;
  discount_code?: string | null;
  sub_total: number;
  additional_fan_contribution?: number | null;
  seller_tax?: number | null;
  marketplace_tax?: number | null;
  tax_rate?: number | null;
  collection_society_share?: number | null;
  shipping?: number | null;
  ship_from_country_name?: string | null;
  transaction_fee: number;
  fee_type: string;
  item_total: number;
  amount_you_received: number;
  paypal_transaction_id?: string | null;
  net_amount: number;
  package?: string | null;
  option?: string | null;
  item_url?: string | null;
  catalog_number?: string | null;
  upc?: string | null;
  isrc?: string | null;
  sku?: string | null;
  buyer_name?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  buyer_note?: string | null;
  ship_to_name?: string | null;
  ship_to_street?: string | null;
  ship_to_street_2?: string | null;
  ship_to_city?: string | null;
  ship_to_state?: string | null;
  ship_to_zip?: string | null;
  ship_to_country?: string | null;
  ship_to_country_code?: string | null;
  ship_date?: string | null;
  ship_notes?: string | null;
  country?: string | null;
  country_code?: string | null;
  region_or_state?: string | null;
  city?: string | null;
  referer?: string | null;
  referer_url?: string | null;
  payment_state?: string | null;
}

export async function salesReport(
  bandId: number,
  accessToken: string,
  startTime: string,
  endTime?: string,
  memberBandId?: number,
): Promise<SalesReportItem[]> {
  const body: Record<string, unknown> = {
    band_id: bandId,
    start_time: startTime,
  };
  if (endTime) body.end_time = endTime;
  if (memberBandId) body.member_band_id = memberBandId;

  const response = await fetch("https://bandcamp.com/api/sales/4/sales_report", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`salesReport failed for band ${bandId}: ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`salesReport API error: ${json.error_message ?? "unknown"}`);
  }

  return json.report ?? [];
}

export async function generateSalesReport(
  bandId: number,
  accessToken: string,
  startTime: string,
  endTime?: string,
  format: "json" | "csv" = "json",
): Promise<string> {
  const body: Record<string, unknown> = {
    band_id: bandId,
    start_time: startTime,
    format,
  };
  if (endTime) body.end_time = endTime;

  const response = await fetch("https://bandcamp.com/api/sales/4/generate_sales_report", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`generateSalesReport failed: ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`generateSalesReport error: ${json.error_message ?? "unknown"}`);
  }

  return json.token;
}

export async function fetchSalesReport(
  token: string,
  accessToken: string,
): Promise<{ ready: true; url: string } | { ready: false }> {
  const response = await fetch("https://bandcamp.com/api/sales/4/fetch_sales_report", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    throw new Error(`fetchSalesReport failed: ${response.status}`);
  }

  const json = await response.json();

  if (json.error && json.error_message === "Report hasn't generated yet") {
    return { ready: false };
  }

  if (json.error) {
    throw new Error(`fetchSalesReport error: ${json.error_message ?? "unknown"}`);
  }

  return { ready: true, url: json.url };
}

export async function updateSku(
  items: Array<{ id: number; id_type: "p" | "o"; sku: string }>,
  accessToken: string,
): Promise<void> {
  const response = await fetch("https://bandcamp.com/api/merchorders/1/update_sku", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    throw new Error(`updateSku failed: ${response.status}`);
  }

  const json = (await response.json()) as { error?: boolean; error_message?: string };
  if (json.error) {
    throw new Error(`updateSku error: ${json.error_message ?? "unknown"}`);
  }
}
