// Rule #58: This file is the ONE owner for webhook body parsing + HMAC verification.
// Rule #36: ALWAYS use req.text() — never req.json() then JSON.stringify().

/**
 * Read the raw body from a webhook request.
 * Must be called before any other body parsing — req.text() can only be read once.
 */
export async function readWebhookBody(req: Request): Promise<string> {
  return req.text();
}

/**
 * Verify an HMAC signature against a raw body string.
 * Uses Web Crypto API (works in Edge Runtime and Node).
 *
 * @param rawBody - The raw request body string
 * @param secret - The webhook secret key
 * @param signature - The signature from the request header
 * @param algorithm - Hash algorithm (default: SHA-256)
 */
export async function verifyHmacSignature(
  rawBody: string,
  secret: string,
  signature: string,
  algorithm: "SHA-256" | "SHA-1" = "SHA-256",
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
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

/**
 * HRD-24 — per-platform absolute age ceiling for webhook deliveries.
 *
 * Background: round-1 reviewer suggested rejecting any webhook >5 minutes
 * old as replay-protection. Round-4 verification surfaced that this would
 * silently break legitimate Shopify retries — Shopify's retry horizon is
 * up to 48 hours (19 attempts on exponential backoff). Same story for
 * WooCommerce (~24h) and Squarespace (~48h).
 *
 * The right design: rely on (a) HMAC signature verification + (b) HRD-22
 * `X-Shopify-Event-Id` dedup + (c) HRD-01 monotonic guard for ordering
 * truth. The ABSOLUTE age check is then ONLY a sanity ceiling against
 * extreme replay attempts and clock skew — set well above each platform's
 * documented retry horizon, NOT at 5 minutes.
 *
 * Per-platform ceilings (hours), all tuned to be >= 2x the documented
 * retry horizon to leave operational slack for delivery storms:
 *
 *   - shopify       :  72 (Shopify retries 48h)
 *   - woocommerce   :  72 (Woo retries ~24h)
 *   - squarespace   :  72 (Squarespace retries ~48h)
 *   - shipstation   :  72 (ShipStation retries 24h)
 *   - stripe        : 168 (Stripe retries up to 3 days = 72h)
 *   - resend (svix) :   1 (Svix re-signs on each retry — see resend-inbound)
 *   - aftership     :  72
 *   - easypost      :  72
 *
 * Resend/Svix is the OUTLIER — Svix re-signs each retry with a fresh
 * timestamp, so the existing 5-min check there is correct AND distinct
 * from this absolute ceiling (Svix check = freshness, this check = abuse
 * ceiling). Don't conflate.
 */
const MAX_AGE_HOURS_BY_PLATFORM: Record<string, number> = {
  shopify: 72,
  woocommerce: 72,
  squarespace: 72,
  shipstation: 72,
  stripe: 168,
  aftership: 72,
  easypost: 72,
};

const DEFAULT_MAX_AGE_HOURS = 72;

export interface WebhookFreshnessVerdict {
  ok: boolean;
  reason?: "no_timestamp" | "exceeds_ceiling" | "future_timestamp";
  ageMs?: number;
  ceilingMs?: number;
}

/**
 * Extract a platform-emitted timestamp from headers + payload, then verify
 * it falls within the per-platform absolute ceiling.
 *
 * Returns `{ ok: true }` (fail-OPEN) when no timestamp is extractable —
 * the alternative is silently dropping every webhook of an unrecognized
 * topic, which is worse than missing a single sanity check. The HRD-01
 * monotonic guard in the Trigger task catches downstream ordering
 * regardless.
 *
 * Future timestamps (>5 minutes ahead of `now`) are rejected — they
 * indicate clock skew or a malicious replay forging future timestamps to
 * win the monotonic guard race. The 5-minute slack is symmetric with
 * Shopify's documented per-event clock-drift tolerance.
 */
export function checkWebhookFreshness(
  platform: string,
  payload: Record<string, unknown> | null,
  headers: { triggeredAt?: string | null } = {},
  now: Date = new Date(),
): WebhookFreshnessVerdict {
  const ceilingHours = MAX_AGE_HOURS_BY_PLATFORM[platform.toLowerCase()] ?? DEFAULT_MAX_AGE_HOURS;
  const ceilingMs = ceilingHours * 60 * 60 * 1000;

  let timestampSource: string | null = null;
  if (headers.triggeredAt) {
    timestampSource = headers.triggeredAt;
  } else if (payload) {
    if (typeof payload.updated_at === "string") timestampSource = payload.updated_at;
    else if (typeof payload.date_modified_gmt === "string")
      timestampSource = `${payload.date_modified_gmt}Z`;
    else if (typeof payload.date_modified === "string") timestampSource = payload.date_modified;
    else if (typeof payload.modifiedOn === "string") timestampSource = payload.modifiedOn;
    else if (typeof payload.created_at === "string") timestampSource = payload.created_at;
  }

  if (!timestampSource) return { ok: true, reason: "no_timestamp" };

  const eventTs = new Date(timestampSource).getTime();
  if (Number.isNaN(eventTs)) return { ok: true, reason: "no_timestamp" };

  const ageMs = now.getTime() - eventTs;
  const FIVE_MIN_MS = 5 * 60 * 1000;

  if (ageMs < -FIVE_MIN_MS) {
    return { ok: false, reason: "future_timestamp", ageMs, ceilingMs };
  }
  if (ageMs > ceilingMs) {
    return { ok: false, reason: "exceeds_ceiling", ageMs, ceilingMs };
  }
  return { ok: true, ageMs, ceilingMs };
}

/**
 * HRD-30 — strip PII from a webhook payload BEFORE persisting it to
 * `webhook_events.metadata.payload`.
 *
 * Pre-condition exposed in round-3 audit: every successful webhook
 * delivery's full JSON body was being stashed into `webhook_events.metadata.
 * payload` for forensics. For Shopify orders/refunds/customers that
 * payload contains email, name, billing/shipping addresses, phone, IP, and
 * line-item notes — none of which we need for diagnostics. The retention
 * window on `webhook_events` is indefinite (no TTL job exists), so this
 * was an accumulating PII liability.
 *
 * Sanitizer rules:
 *   - Strip well-known PII keys recursively (`email`, `phone`, `name`,
 *     `first_name`, `last_name`, `address1`, `address2`, `city`, `zip`,
 *     `province`, `country`, `latitude`, `longitude`, `client_details`,
 *     `customer`, `billing_address`, `shipping_address`, `note`,
 *     `note_attributes`, `customer_locale`, `landing_site`,
 *     `referring_site`, `browser_ip`, `cart_token`, `checkout_token`).
 *   - Preserve operationally-useful keys: `id`, `inventory_item_id`,
 *     `variant_id`, `product_id`, `sku`, `quantity`, `price`,
 *     `total_price`, `subtotal_price`, `currency`, `financial_status`,
 *     `fulfillment_status`, `created_at`, `updated_at`, `processed_at`,
 *     `order_number`, `name` (when at the order root — Shopify uses `name`
 *     for "#1042" style order numbers; we strip it ONLY inside `customer`
 *     / `*_address` blocks, see `PII_KEYS_INSIDE_ADDRESS_BLOCK`),
 *     `line_items`, `refund_line_items`, `transactions`,
 *     `inventory_levels`, `topic`.
 *   - Replace stripped values with the sentinel string `"[REDACTED]"` (NOT
 *     deletion) — preserves payload SHAPE so downstream code that walks
 *     the object via `payload?.customer?.email` doesn't throw on
 *     undefined.
 *   - Idempotent: re-sanitizing already-sanitized payload is a no-op.
 *   - Depth cap: 10 levels (defensive against deeply-nested JSON DoS;
 *     Shopify's deepest legitimate payload is `refunds.refund_line_items[].
 *     line_item.tax_lines[]` = 5 levels).
 *
 * NOTE: this sanitizer is intentionally aggressive and cannot
 * round-trip — `parsedPayload` (full body) is what HRD-01 monotonic
 * guard / HRD-22 dedup / HRD-24 freshness operate on; the SANITIZED
 * version is only what gets persisted.
 */

const PII_KEY_DENYLIST = new Set([
  "email",
  "contact_email",
  "phone",
  "first_name",
  "last_name",
  "default_address",
  "address1",
  "address2",
  "city",
  "zip",
  "postal_code",
  "province",
  "province_code",
  "country",
  "country_code",
  "country_name",
  "latitude",
  "longitude",
  "client_details",
  "browser_ip",
  "browser_user_agent",
  "browser_accept_language",
  "session_hash",
  "customer_locale",
  "landing_site",
  "referring_site",
  "landing_site_ref",
  "cart_token",
  "checkout_token",
  "checkout_id",
  "device_id",
  "user_id",
  "note_attributes",
  "note",
  "company",
]);

const PII_BLOCK_DENYLIST = new Set([
  "customer",
  "billing_address",
  "shipping_address",
  "order_status_url",
  "shipping_lines",
  "client_details",
]);

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_BLOCK_DENYLIST.has(k)) {
      out[k] = REDACTED;
      continue;
    }
    if (PII_KEY_DENYLIST.has(k)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = sanitizeValue(v, depth + 1);
  }
  return out;
}

/**
 * Sanitize a webhook payload before persisting to webhook_events.metadata.
 * Returns a NEW object — does not mutate the input.
 *
 * If `payload` is null/undefined, returns it as-is (so callers don't have
 * to null-check).
 */
export function sanitizeWebhookPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (payload === null || payload === undefined) return payload;
  return sanitizeValue(payload, 0) as Record<string, unknown>;
}
