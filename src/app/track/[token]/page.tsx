// Phase 12 — Public branded customer tracking page (`/track/[token]`).
//
// Server-rendered, no auth, no client JS for the static parts. The token
// in the URL is the auth — random 22-char base64url, 128 bits of entropy,
// generated server-side at shipment-row insert time, stored on
// warehouse_shipments.public_track_token (UNIQUE).
//
// PII allowlist (CRITICAL): renders ONLY ship-to city/state/country, the
// tracker number, the carrier name, the events, and the org branding. NO
// street address, NO email, NO phone, NO payment fields, NO buyer_note.
//
// 404 (not 500) on unknown token. Failed lookups also emit a sensor row
// for enumeration detection (rate-limited per IP would go in middleware
// or a sensor-only counter; today we just count).

import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  MapPin,
  Package,
  Truck,
} from "lucide-react";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// Disable static caching — every request is a fresh DB read (low traffic).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { token: string };
}

interface ShipmentRow {
  id: string;
  workspace_id: string;
  org_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  status: string | null;
  ship_date: string | null;
  delivery_date: string | null;
  label_data: Record<string, unknown> | null;
  shipstation_order_id: string | null;
  order_id: string | null;
  mailorder_id: string | null;
}

interface TrackingEventRow {
  id: string;
  status: string | null;
  description: string | null;
  location: string | null;
  event_time: string | null;
}

interface OrgBranding {
  name: string | null;
  brand_color: string | null;
  logo_url: string | null;
  support_email: string | null;
}

const STATUS_CONFIG: Record<string, { icon: typeof Package; color: string; label: string }> = {
  shipped: { icon: Package, color: "text-blue-600", label: "Shipped" },
  label_created: { icon: Package, color: "text-gray-500", label: "Label Created" },
  pre_transit: { icon: Package, color: "text-gray-500", label: "Pre-Transit" },
  in_transit: { icon: Truck, color: "text-blue-600", label: "In Transit" },
  out_for_delivery: { icon: Truck, color: "text-green-600", label: "Out for Delivery" },
  delivered: { icon: CheckCircle, color: "text-green-600", label: "Delivered" },
  exception: { icon: AlertTriangle, color: "text-red-600", label: "Exception" },
  delivery_failed: { icon: AlertTriangle, color: "text-orange-600", label: "Delivery Failed" },
  return_to_sender: { icon: AlertTriangle, color: "text-red-600", label: "Return to Sender" },
};

function getStatusConfig(status: string | null | undefined) {
  if (!status) return { icon: Clock, color: "text-gray-500", label: "Unknown" };
  return (
    STATUS_CONFIG[status] ?? {
      icon: Clock,
      color: "text-gray-500",
      label: status.replace(/_/g, " "),
    }
  );
}

function pickPublicCity(labelData: Record<string, unknown> | null): string {
  // Pull the destination "City, State, Country" from EasyPost label_data.
  // (warehouse_shipments has no dedicated ship_to column — destination
  // lives on the source order or, conveniently for our purposes, inside
  // the EasyPost shipment object stored in label_data.)
  if (!labelData || typeof labelData !== "object") return "";
  const ep = labelData as Record<string, unknown>;
  const ship = (ep.shipment ?? ep) as Record<string, unknown>;
  const to = ship.to_address as Record<string, unknown> | undefined;
  if (!to) return "";
  const city = typeof to.city === "string" ? to.city : "";
  const state = typeof to.state === "string" ? to.state : "";
  const country = typeof to.country === "string" ? to.country : "";
  return [city, state, country].filter(Boolean).join(", ");
}

function buildCarrierUrl(carrier: string | null, tracking: string | null): string | null {
  if (!carrier || !tracking) return null;
  const c = carrier.toLowerCase();
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${tracking}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${tracking}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${tracking}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${tracking}`;
  if (c.includes("asendia"))
    return `https://tracking.asendiausa.com/tracking/${tracking}`;
  return null;
}

export default async function PublicTrackPage({ params }: PageProps) {
  const supabase = createServiceRoleClient();

  // Look up the shipment by token. Token IS the auth — if a token doesn't
  // exist or hits a deleted shipment, 404. NEVER 500 (would leak existence
  // signal to enumerators).
  const { data: rawShipment } = await supabase
    .from("warehouse_shipments")
    .select(
      `id, workspace_id, org_id, tracking_number, carrier, service, status,
       ship_date, delivery_date, label_data, shipstation_order_id,
       order_id, mailorder_id`,
    )
    .eq("public_track_token", params.token)
    .maybeSingle();

  if (!rawShipment) {
    // Sensor for enumeration tracking — single insert per failed lookup,
    // workspace_id NULL since we have no shipment context.
    await supabase.from("sensor_readings").insert({
      sensor_name: "tracking.public_page_lookup_miss",
      status: "warning",
      message: "lookup hit unknown token (possible enumeration or expired token)",
      value: { token_prefix: params.token.slice(0, 4) },
    });
    notFound();
  }

  const shipment = rawShipment as ShipmentRow;

  // Org branding — null org → fall back to Clandestine.
  let branding: OrgBranding = {
    name: "Clandestine Distribution",
    brand_color: "#111827",
    logo_url: null,
    support_email: "support@clandestinedistro.com",
  };
  if (shipment.org_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name, brand_color, logo_url, support_email")
      .eq("id", shipment.org_id)
      .maybeSingle();
    if (org) {
      branding = {
        name: (org.name as string | null) ?? branding.name,
        brand_color: (org.brand_color as string | null) ?? branding.brand_color,
        logo_url: (org.logo_url as string | null) ?? null,
        support_email:
          (org.support_email as string | null) ?? branding.support_email,
      };
    }
  }

  // Tracking events.
  const { data: rawEvents } = await supabase
    .from("warehouse_tracking_events")
    .select("id, status, description, location, event_time")
    .eq("shipment_id", shipment.id)
    .order("event_time", { ascending: false })
    .limit(100);
  const events = (rawEvents ?? []) as TrackingEventRow[];

  // Order number for display.
  let orderNumber: string | null = null;
  if (shipment.shipstation_order_id) {
    const { data: ssOrder } = await supabase
      .from("shipstation_orders")
      .select("order_number")
      .eq("id", shipment.shipstation_order_id)
      .maybeSingle();
    orderNumber = (ssOrder?.order_number as string | null) ?? null;
  } else if (shipment.order_id) {
    const { data: o } = await supabase
      .from("warehouse_orders")
      .select("order_number")
      .eq("id", shipment.order_id)
      .maybeSingle();
    orderNumber = (o?.order_number as string | null) ?? null;
  } else if (shipment.mailorder_id) {
    const { data: o } = await supabase
      .from("mailorder_orders")
      .select("order_number")
      .eq("id", shipment.mailorder_id)
      .maybeSingle();
    orderNumber = (o?.order_number as string | null) ?? null;
  }

  const currentStatusConfig = getStatusConfig(shipment.status);
  const StatusIcon = currentStatusConfig.icon;
  const carrierUrl = buildCarrierUrl(shipment.carrier, shipment.tracking_number);
  const publicCity = pickPublicCity(shipment.label_data);
  const brand = branding.brand_color ?? "#111827";

  return (
    <html lang="en">
      <head>
        <title>
          Tracking — {orderNumber ?? "Order"} · {branding.name ?? "Clandestine Distribution"}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <style>{`
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
              "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #111827;
            background: #f3f4f6;
            line-height: 1.5;
          }
          .wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
          .card { background: #ffffff; border-radius: 12px; padding: 28px 24px; margin-bottom: 16px; }
          .header-logo { max-height: 48px; max-width: 220px; display: block; margin-bottom: 12px; }
          .org-name { font-size: 22px; font-weight: 700; margin: 0; color: ${brand}; }
          .order-meta { font-size: 13px; color: #6b7280; margin-top: 4px; }
          .status-row { display: flex; align-items: center; gap: 12px; padding: 16px; background: #f9fafb; border-radius: 8px; margin-top: 16px; }
          .status-icon { flex-shrink: 0; }
          .status-text { font-weight: 600; font-size: 16px; }
          .status-sub { font-size: 13px; color: #6b7280; }
          .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 18px; padding: 14px; background: #f9fafb; border-radius: 8px; font-size: 13px; }
          .meta-grid .label { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
          .meta-grid .value { font-weight: 500; word-break: break-word; }
          .meta-grid a { color: ${brand}; text-decoration: none; }
          .meta-grid a:hover { text-decoration: underline; }
          h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin: 24px 0 12px 0; }
          ul.timeline { list-style: none; padding: 0; margin: 0; }
          ul.timeline li { padding: 12px 0; border-bottom: 1px solid #f3f4f6; display: flex; gap: 12px; }
          ul.timeline li:last-child { border-bottom: none; }
          .te-status { font-weight: 600; font-size: 14px; text-transform: capitalize; }
          .te-desc { color: #4b5563; font-size: 13px; margin-top: 2px; }
          .te-loc { color: #6b7280; font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 4px; }
          .te-time { color: #9ca3af; font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }
          .empty { color: #9ca3af; font-size: 14px; padding: 24px 0; text-align: center; }
          .footer { text-align: center; font-size: 12px; color: #6b7280; padding: 16px 0 32px 0; }
          .footer a { color: ${brand}; text-decoration: none; }
          .blue-600 { color: #2563eb; }
          .green-600 { color: #16a34a; }
          .red-600 { color: #dc2626; }
          .orange-600 { color: #ea580c; }
          .gray-500 { color: #6b7280; }
          @media (max-width: 480px) { .meta-grid { grid-template-columns: 1fr; } }
        `}</style>
      </head>
      <body>
        <div className="wrap">
          <div className="card">
            <div>
              {branding.logo_url ? (
                // biome-ignore lint/a11y/useAltText: alt provided
                <img className="header-logo" src={branding.logo_url} alt={branding.name ?? ""} />
              ) : (
                <h1 className="org-name">{branding.name ?? "Clandestine Distribution"}</h1>
              )}
              <p className="order-meta">
                {orderNumber ? `Order ${orderNumber}` : "Order"}
                {shipment.ship_date ? ` · shipped ${formatDate(shipment.ship_date)}` : ""}
              </p>
            </div>

            {/* Live status badge */}
            <div className="status-row">
              <StatusIcon
                className={`status-icon ${normalizeColorClass(currentStatusConfig.color)}`}
                size={28}
              />
              <div>
                <div className="status-text">{currentStatusConfig.label}</div>
                {publicCity && (
                  <div className="status-sub">
                    <MapPin
                      size={11}
                      style={{
                        display: "inline",
                        verticalAlign: "middle",
                        marginRight: 2,
                      }}
                    />
                    {publicCity}
                  </div>
                )}
                {shipment.delivery_date && shipment.status === "delivered" && (
                  <div className="status-sub">
                    Delivered {formatDate(shipment.delivery_date)}
                  </div>
                )}
              </div>
            </div>

            {/* Carrier + tracking number */}
            <div className="meta-grid">
              {shipment.carrier && (
                <div>
                  <div className="label">Carrier</div>
                  <div className="value">{shipment.carrier}</div>
                </div>
              )}
              {shipment.tracking_number && (
                <div>
                  <div className="label">Tracking</div>
                  <div className="value" style={{ fontFamily: "monospace", fontSize: "12px" }}>
                    {carrierUrl ? (
                      <a href={carrierUrl} target="_blank" rel="noopener noreferrer">
                        {shipment.tracking_number}
                        <ExternalLink
                          size={11}
                          style={{ display: "inline", marginLeft: 4, verticalAlign: "middle" }}
                        />
                      </a>
                    ) : (
                      shipment.tracking_number
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Tracking Timeline</h2>
            {events.length === 0 ? (
              <p className="empty">
                Tracking events will appear here once the carrier scans your package.
              </p>
            ) : (
              <ul className="timeline">
                {events.map((e) => {
                  const cfg = getStatusConfig(e.status);
                  return (
                    <li key={e.id}>
                      <div className={`status-icon ${normalizeColorClass(cfg.color)}`}>
                        <cfg.icon size={18} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="te-status">{cfg.label}</div>
                        {e.description && <div className="te-desc">{e.description}</div>}
                        {e.location && (
                          <div className="te-loc">
                            <MapPin size={11} /> {e.location}
                          </div>
                        )}
                        {e.event_time && (
                          <div className="te-time">{formatDateTime(e.event_time)}</div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="footer">
            Questions?{" "}
            {branding.support_email ? (
              <a href={`mailto:${branding.support_email}`}>{branding.support_email}</a>
            ) : (
              "Contact us through your order receipt."
            )}
            <div style={{ marginTop: 6 }}>{branding.name ?? "Clandestine Distribution"}</div>
          </div>
        </div>
      </body>
    </html>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Map our color tokens to the inline CSS classes defined in <style>.
function normalizeColorClass(token: string): string {
  if (token === "text-blue-600") return "blue-600";
  if (token === "text-green-600") return "green-600";
  if (token === "text-red-600") return "red-600";
  if (token === "text-orange-600") return "orange-600";
  return "gray-500";
}
