// Slice 3 — strict allowlist type for the public /track/[token] page.
//
// PURPOSE: prevent a future regression where a developer accidentally
// spreads the full warehouse_shipments row (which contains label_data,
// customer_email, etc.) into the page component's props. The page
// component takes ONLY this type — TypeScript blocks the wider shape
// at the boundary.
//
// The page rendering layer NEVER reads any field outside this type.
// All transformation from row → PublicTrackingShipment happens inside
// page.tsx and is reviewed line-by-line for PII.

export interface PublicTrackingDestination {
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface PublicTrackingEvent {
  id: string;
  status: string | null;
  description: string | null;
  location: string | null;
  /** ISO timestamp string. */
  event_time: string | null;
}

export interface PublicTrackingOrgBranding {
  /** Defaults to "Clandestine Distribution" if the org row is absent. */
  name: string;
  /** Sanitized hex color (#rrggbb). Falls back to a safe default upstream. */
  brand_color: string;
  /** https-only logo URL, or null if absent / unsafe. */
  logo_url: string | null;
  /**
   * Workspace branding contact — intentionally rendered in the footer
   * mailto link. Distinct from buyer email (which is NEVER rendered).
   */
  support_email: string | null;
}

/**
 * The COMPLETE allowed surface a public tracking page may render.
 *
 * Any future field MUST land here AND be reviewed for PII risk.
 * Keys explicitly forbidden (do not even consider adding): customer_name,
 * customer_email, recipient phone, street1/street2, zip code, payment
 * info, internal IDs (shipment.id, workspace_id), buyer_notes.
 */
export interface PublicTrackingShipment {
  /** Carrier display name ("USPS", "UPS", "Asendia", etc.). */
  carrier: string | null;
  /** Tracking number — public by carrier convention. */
  tracking_number: string | null;
  /** Internal warehouse status ("shipped", "in_transit", "delivered", etc.). */
  status: string | null;
  /** Carrier-side fine-grained status detail (e.g. "Out for delivery"). */
  tracking_status_detail: string | null;
  /** ISO date — when the label was created / handed off. */
  ship_date: string | null;
  /** ISO date — when the carrier reported delivery. */
  delivery_date: string | null;
  destination: PublicTrackingDestination;
  events: PublicTrackingEvent[];
  /** Carrier-site tracking URL (sanitized https-only). */
  carrier_tracking_url: string | null;
  /** EasyPost branded tracker URL (sanitized https-only). */
  easypost_public_url: string | null;
  /**
   * Order number for display in the page header. NOT a guarded ID — it's
   * the same value that appears on a printed packing slip and is shown
   * to the customer at checkout.
   */
  order_number: string | null;
  org: PublicTrackingOrgBranding;
}
