// Phase 12 — Public tracking token helper.
//
// Generates a 22-char URL-safe random token (128 bits of entropy) used as
// the path segment in /track/[token]. Server-side only; never derived from
// shipment_id or tracking_number to keep the token unguessable.
//
// `crypto.randomBytes(16).toString('base64url')` → 22 chars, no padding.
//
// Slice 3 additions:
//   - pickPublicDestination(): allowlist-by-construction destination
//     extractor. Replaces the inline pickPublicCity in the page module so
//     unit tests can verify "no PII keys ever returned, even with hostile
//     input where every shipment field is set to a PII string".
//   - sanitizeBrandColor / sanitizeImageUrl: tight sanitizers for the
//     two org-branding fields the public page renders inline.
//   - Carrier tracking URL helper lives in
//     `src/lib/shared/carrier-tracking-urls.ts`. Slice 3 extended that
//     same builder to accept an EasyPost public URL override + an
//     unsafe-protocol guard, so the public page and admin cockpit share
//     one builder.

import { randomBytes } from "node:crypto";

export {
  buildCarrierTrackingUrl,
  buildShipStationOrderPageUrl,
  isSafeHttpsUrl,
} from "./carrier-tracking-urls";

/** 16 random bytes encoded as URL-safe base64 (no padding) → 22 chars. */
export function generatePublicTrackToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Build the absolute customer-facing tracking URL for a shipment token.
 * The host is read from env so we can run staging/prod cleanly.
 */
export function buildPublicTrackUrl(token: string, host: string): string {
  const safeHost = host.replace(/\/+$/, "");
  return `${safeHost}/track/${token}`;
}

// ── Slice 3: Public destination extractor ────────────────────────────────

export interface PublicDestination {
  city: string | null;
  state: string | null;
  country: string | null;
}

interface ShipmentLikeForDestination {
  destination_city?: string | null;
  destination_state?: string | null;
  destination_country?: string | null;
  /**
   * Slice 3 backfill window: when the first-class columns are NULL we
   * fall back to the EasyPost label_data shape under
   * `label_data.shipment.to_address.{city,state,country}`. Only the
   * three allowlist keys are read; PII keys (street1/street2/zip/email/
   * phone) are NEVER inspected by this function.
   */
  label_data?: Record<string, unknown> | null;
}

/**
 * Allowlist-by-construction destination extractor.
 *
 * INVARIANT: the only keys ever returned are `city`, `state`, `country`.
 * Even if the caller passes a shipment whose every field is set to a PII
 * string, the output of this function still contains nothing else. The
 * unit test for this helper enforces the invariant with hostile input.
 */
export function pickPublicDestination(shipment: ShipmentLikeForDestination): PublicDestination {
  const direct: PublicDestination = {
    city: pickStringOrNull(shipment.destination_city),
    state: pickStringOrNull(shipment.destination_state),
    country: pickStringOrNull(shipment.destination_country),
  };
  if (direct.city || direct.state || direct.country) return direct;

  // Fallback to label_data.shipment.to_address — backfill window only.
  const ld = shipment.label_data;
  if (!ld || typeof ld !== "object") return direct;
  const ep = ld as Record<string, unknown>;
  const ship = (ep.shipment ?? ep) as Record<string, unknown> | undefined;
  if (!ship || typeof ship !== "object") return direct;
  const to = (ship as Record<string, unknown>).to_address as Record<string, unknown> | undefined;
  if (!to || typeof to !== "object") return direct;
  return {
    city: pickStringOrNull(to.city),
    state: pickStringOrNull(to.state),
    country: pickStringOrNull(to.country),
  };
}

function pickStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Format a PublicDestination as "City, State, Country" — empty fields skipped. */
export function formatPublicDestination(dest: PublicDestination): string {
  return [dest.city, dest.state, dest.country].filter(Boolean).join(", ");
}

// ── Slice 3: Branding sanitizers (HTML/CSS injection defense) ────────────

/**
 * Strict hex-color sanitizer for org branding. Returns the input if it
 * matches `#rrggbb` or `#rgb` (case-insensitive), else the fallback.
 * Prevents smuggled `expression(...)`, `url(javascript:...)`, etc.
 * through the page's inline `<style>` tag.
 */
export function sanitizeBrandColor(value: string | null | undefined, fallback = "#111827"): string {
  if (!value || typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) return trimmed;
  return fallback;
}

/**
 * Strict https-only image URL sanitizer for org logos. Returns null if
 * the input is missing or unsafe. Used for both `<img src>` rendering
 * and the EasyPost public_url passthrough on the public tracking page.
 */
export function sanitizeImageUrl(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (u.protocol === "https:") return value;
  } catch {
    // ignore
  }
  return null;
}
