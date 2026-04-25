// Phase 12 / Slice 3 — Public branded customer tracking page.
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
// Slice 3 hardening:
//   - The render half (`PublicTrackingPageBody`) takes ONLY a
//     `PublicTrackingShipment` allowlist object — TypeScript blocks the
//     full row at the boundary, so a future "spread the row" regression
//     becomes a type error rather than a quiet PII leak.
//   - Destination is read from the new first-class
//     `destination_{city,state,country}` columns, with a label_data
//     fallback ONLY during the backfill window. PII-safe by construction.
//   - Carrier link prefers EasyPost's branded tracker URL when present,
//     falls back to the carrier site, returns null for unknown carriers.
//   - Brand color and logo URL are sanitized (#rrggbb only; https-only
//     image URL) so a malformed branding row can't smuggle CSS or
//     `javascript:` into the inline <style> / <img>.
//
// 404 (not 500) on unknown token. Failed lookups also emit a sensor row
// for enumeration detection.

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
import {
  buildCarrierTrackingUrl,
  formatPublicDestination,
  pickPublicDestination,
  sanitizeBrandColor,
  sanitizeImageUrl,
} from "@/lib/shared/public-track-token";
import type { PublicTrackingEvent, PublicTrackingShipment } from "./types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { token: string };
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
       order_id, mailorder_id,
       destination_city, destination_state, destination_country,
       easypost_tracker_id, easypost_tracker_public_url, easypost_tracker_status,
       last_tracking_status_detail, last_tracking_status_updated_at`,
    )
    .eq("public_track_token", params.token)
    .maybeSingle();

  if (!rawShipment) {
    await supabase.from("sensor_readings").insert({
      sensor_name: "tracking.public_page_lookup_miss",
      status: "warning",
      message: "lookup hit unknown token (possible enumeration or expired token)",
      value: { token_prefix: params.token.slice(0, 4) },
    });
    notFound();
  }

  const orgId = (rawShipment as { org_id: string | null }).org_id;

  type OrgBrandRow = {
    name?: string | null;
    brand_color?: string | null;
    logo_url?: string | null;
    support_email?: string | null;
  };
  let orgRow: OrgBrandRow | null = null;
  if (orgId) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name, brand_color, logo_url, support_email")
      .eq("id", orgId)
      .maybeSingle();
    orgRow = (org as OrgBrandRow | null) ?? null;
  }

  // Tracking events.
  const { data: rawEvents } = await supabase
    .from("warehouse_tracking_events")
    .select("id, status, description, location, event_time")
    .eq("shipment_id", (rawShipment as { id: string }).id)
    .order("event_time", { ascending: false })
    .limit(100);

  // Order number for display.
  let orderNumber: string | null = null;
  const ssId = (rawShipment as { shipstation_order_id: string | null }).shipstation_order_id;
  const orderId = (rawShipment as { order_id: string | null }).order_id;
  const mailorderId = (rawShipment as { mailorder_id: string | null }).mailorder_id;
  if (ssId) {
    const { data: ssOrder } = await supabase
      .from("shipstation_orders")
      .select("order_number")
      .eq("id", ssId)
      .maybeSingle();
    orderNumber = (ssOrder?.order_number as string | null) ?? null;
  } else if (orderId) {
    const { data: o } = await supabase
      .from("warehouse_orders")
      .select("order_number")
      .eq("id", orderId)
      .maybeSingle();
    orderNumber = (o?.order_number as string | null) ?? null;
  } else if (mailorderId) {
    const { data: o } = await supabase
      .from("mailorder_orders")
      .select("order_number")
      .eq("id", mailorderId)
      .maybeSingle();
    orderNumber = (o?.order_number as string | null) ?? null;
  }

  // ── Construct the allowlist surface — PII review happens HERE ──────────
  // The render layer below sees ONLY this object. New fields require an
  // explicit add to PublicTrackingShipment + PII review.
  const view: PublicTrackingShipment = {
    carrier: (rawShipment as { carrier: string | null }).carrier,
    tracking_number: (rawShipment as { tracking_number: string | null }).tracking_number,
    status:
      (rawShipment as { easypost_tracker_status: string | null }).easypost_tracker_status ??
      (rawShipment as { status: string | null }).status,
    tracking_status_detail: (rawShipment as { last_tracking_status_detail: string | null })
      .last_tracking_status_detail,
    ship_date: (rawShipment as { ship_date: string | null }).ship_date,
    delivery_date: (rawShipment as { delivery_date: string | null }).delivery_date,
    destination: pickPublicDestination(rawShipment as Parameters<typeof pickPublicDestination>[0]),
    events: ((rawEvents ?? []) as PublicTrackingEvent[]).map((e) => ({
      id: e.id,
      status: e.status,
      description: e.description,
      location: e.location,
      event_time: e.event_time,
    })),
    carrier_tracking_url: buildCarrierTrackingUrl(
      (rawShipment as { carrier: string | null }).carrier,
      (rawShipment as { tracking_number: string | null }).tracking_number,
      (rawShipment as { easypost_tracker_public_url: string | null }).easypost_tracker_public_url,
    ),
    easypost_public_url: sanitizeImageUrl(
      // sanitizeImageUrl is overloaded for "is this an https URL"; reuse it
      // here so a corrupt EP payload can't smuggle javascript:/data:.
      (rawShipment as { easypost_tracker_public_url: string | null }).easypost_tracker_public_url ??
        null,
    ),
    order_number: orderNumber,
    org: {
      name: orgRow?.name ?? "Clandestine Distribution",
      brand_color: sanitizeBrandColor(orgRow?.brand_color ?? null, "#111827"),
      logo_url: sanitizeImageUrl(orgRow?.logo_url ?? null),
      support_email: orgRow?.support_email ?? "support@clandestinedistro.com",
    },
  };

  return <PublicTrackingPageBody view={view} />;
}

// ── Render layer — only the allowlist type is in scope ────────────────────

function PublicTrackingPageBody({ view }: { view: PublicTrackingShipment }) {
  const currentStatusConfig = getStatusConfig(view.status);
  const StatusIcon = currentStatusConfig.icon;
  const destinationLine = formatPublicDestination(view.destination);
  const brand = view.org.brand_color;

  return (
    <html lang="en">
      <head>
        <title>
          Tracking — {view.order_number ?? "Order"} · {view.org.name}
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
          .secondary-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #6b7280; text-decoration: none; margin-top: 6px; }
          .secondary-link:hover { color: ${brand}; }
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
              {view.org.logo_url ? (
                // biome-ignore lint/performance/noImgElement: email-like tracking page preserves raw markup
                <img className="header-logo" src={view.org.logo_url} alt={view.org.name} />
              ) : (
                <h1 className="org-name">{view.org.name}</h1>
              )}
              <p className="order-meta">
                {view.order_number ? `Order ${view.order_number}` : "Order"}
                {view.ship_date ? ` · shipped ${formatDate(view.ship_date)}` : ""}
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
                {view.tracking_status_detail && (
                  <div className="status-sub">{view.tracking_status_detail}</div>
                )}
                {destinationLine && (
                  <div className="status-sub">
                    <MapPin
                      size={11}
                      style={{
                        display: "inline",
                        verticalAlign: "middle",
                        marginRight: 2,
                      }}
                    />
                    {destinationLine}
                  </div>
                )}
                {view.delivery_date && view.status === "delivered" && (
                  <div className="status-sub">Delivered {formatDate(view.delivery_date)}</div>
                )}
              </div>
            </div>

            {/* Carrier + tracking number */}
            <div className="meta-grid">
              {view.carrier && (
                <div>
                  <div className="label">Carrier</div>
                  <div className="value">{view.carrier}</div>
                </div>
              )}
              {view.tracking_number && (
                <div>
                  <div className="label">Tracking</div>
                  <div className="value" style={{ fontFamily: "monospace", fontSize: "12px" }}>
                    {view.carrier_tracking_url ? (
                      <a href={view.carrier_tracking_url} target="_blank" rel="noopener noreferrer">
                        {view.tracking_number}
                        <ExternalLink
                          size={11}
                          style={{ display: "inline", marginLeft: 4, verticalAlign: "middle" }}
                        />
                      </a>
                    ) : (
                      view.tracking_number
                    )}
                  </div>
                  {view.easypost_public_url &&
                    view.easypost_public_url !== view.carrier_tracking_url && (
                      <a
                        className="secondary-link"
                        href={view.easypost_public_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Carrier tracking details
                        <ExternalLink size={11} />
                      </a>
                    )}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Tracking Timeline</h2>
            {view.events.length === 0 ? (
              <p className="empty">{getEmptyStateCopy(view.status)}</p>
            ) : (
              <ul className="timeline">
                {view.events.map((e) => {
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
            {view.org.support_email ? (
              <a href={`mailto:${view.org.support_email}`}>{view.org.support_email}</a>
            ) : (
              "Contact us through your order receipt."
            )}
            <div style={{ marginTop: 6 }}>{view.org.name}</div>
          </div>
        </div>
      </body>
    </html>
  );
}

function getEmptyStateCopy(status: string | null): string {
  switch (status) {
    case "pre_transit":
    case "label_created":
      return "Your label is printed. The carrier will scan your package once it's picked up — events will appear here as soon as that happens.";
    case "exception":
    case "delivery_failed":
    case "return_to_sender":
      return "There's an exception on this shipment. Reach out to support if you don't see an update soon.";
    default:
      return "Tracking events will appear here once the carrier scans your package.";
  }
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

function normalizeColorClass(token: string): string {
  if (token === "text-blue-600") return "blue-600";
  if (token === "text-green-600") return "green-600";
  if (token === "text-red-600") return "red-600";
  if (token === "text-orange-600") return "orange-600";
  return "gray-500";
}
