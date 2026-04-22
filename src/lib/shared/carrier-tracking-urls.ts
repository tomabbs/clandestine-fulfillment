// Phase 4.5 — Deterministic per-carrier tracking URL builder.
//
// Used as a fallback when SS doesn't return a `shipstation_tracking_url`
// in the writeback response (Asendia, less-common carriers, v1 path).
//
// Per-row tracking link priority (Phase 4.5):
//   1. label_data.shipstation_tracking_url (returned by SS)
//   2. buildCarrierTrackingUrl(carrier, trackingNumber)
//   3. raw SS order page link as final fallback (cockpit handles this)

const TEMPLATES: Array<{ match: RegExp; url: (n: string) => string }> = [
  // USPS variants
  {
    match: /^(usps|stamps_com)$/i,
    url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  },
  // UPS
  { match: /^ups/i, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  // FedEx
  { match: /^fedex/i, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  // DHL Express
  {
    match: /^dhl_?express/i,
    url: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${n}`,
  },
  // DHL eCommerce
  {
    match: /^dhl_?ecommerce|^dhl_?global_?mail/i,
    url: (n) => `https://webtrack.dhlglobalmail.com/?trackingnumber=${n}`,
  },
  // Asendia / GlobalPost
  {
    match: /^(asendia|globalpost)/i,
    url: (n) => `https://tracking.asendiausa.com/Tracking?Tracking=${n}`,
  },
  // Canada Post
  {
    match: /^canadapost/i,
    url: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${n}`,
  },
];

/**
 * Build a public tracking URL given a carrier code (either EP or SS shape)
 * and a tracking number. Returns null when no template matches.
 *
 * Exposed for unit testing.
 */
export function buildCarrierTrackingUrl(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const num = trackingNumber.trim();
  if (!num) return null;
  const c = carrier.trim();
  for (const tpl of TEMPLATES) {
    if (tpl.match.test(c)) return tpl.url(encodeURIComponent(num));
  }
  return null;
}

/** Builds the SS-hosted branded tracking page URL — used as the final fallback. */
export function buildShipStationOrderPageUrl(shipstationOrderId: number | string): string {
  return `https://ship11.shipstation.com/orders/order-details/${shipstationOrderId}`;
}
