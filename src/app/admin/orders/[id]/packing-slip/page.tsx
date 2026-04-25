// Phase 3.4 — Per-order packing slip route.
//
// Server-rendered HTML at /admin/orders/{id}/packing-slip. Reads
// shipstation_orders + items + organizations(name) via fetchPackingSlipData.
// Print stylesheet sized for letter / 4×6 thermal — staff opens this in a
// new tab and triggers the browser's native print dialog.
//
// Phase 9 will add a /admin/orders/print-batch/{batch_id} route that combines
// many of these into a single print job for bulk operations.

import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { fetchPackingSlipData } from "@/lib/shared/packing-slip-data";
import { sanitizeBuyerText } from "@/lib/shared/sanitize-buyer-text";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

export default async function PackingSlipPage({ params }: RouteParams) {
  await requireStaff();
  const supabase = createServiceRoleClient();
  const data = await fetchPackingSlipData(supabase, params.id);
  if (!data) notFound();

  const itemTotal = data.items.reduce(
    (sum, it) => sum + (it.unit_price ?? 0) * (it.quantity ?? 0),
    0,
  );

  // Phase 11.1 — international = country present and not "US". Drives whether
  // we render customs_description lines under each item.
  const isInternational = !!data.ship_to.country && data.ship_to.country.toUpperCase() !== "US";

  return (
    <html lang="en">
      <head>
        <title>Packing Slip — {data.order_number}</title>
        <style>{`
          * { box-sizing: border-box; }
          body {
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
              "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #111;
            margin: 0;
            padding: 0.5in;
            background: #fff;
          }
          h1 { margin: 0; font-size: 22px; font-weight: 600; }
          h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; font-weight: 500; }
          .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 10px; }
          .artist-line { margin: 6px 0 0 0; font-size: 14px; color: #333; font-style: italic; }
          .meta { text-align: right; font-size: 12px; color: #555; }
          .meta strong { color: #111; }
          .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin: 20px 0; }
          .addr-block address { font-style: normal; line-height: 1.4; font-size: 13px; }
          .addr-block .label { font-weight: 600; margin-bottom: 4px; }
          .panel {
            margin: 16px 0;
            padding: 10px 14px;
            border-left: 3px solid #555;
            background: #fafafa;
            font-size: 13px;
            line-height: 1.4;
          }
          .panel.gift { border-left-color: #b91c1c; background: #fef2f2; }
          .panel.note { border-left-color: #2563eb; background: #eff6ff; }
          .panel-label { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin-bottom: 4px; }
          .panel-body { white-space: pre-wrap; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
          th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; font-weight: 500; }
          td.qty, td.price, th.qty, th.price { text-align: right; font-variant-numeric: tabular-nums; }
          .item-meta { font-size: 11px; color: #777; margin-top: 2px; }
          .item-thumb { width: 36px; height: 36px; object-fit: cover; border-radius: 3px; border: 1px solid #ddd; display: block; }
          .customs-line { font-size: 11px; color: #555; margin-top: 3px; font-style: italic; }
          tfoot td { border-bottom: none; padding-top: 12px; font-weight: 600; }
          .tip-line { font-size: 12px; color: #555; padding-top: 6px; }
          .footer { margin-top: 30px; padding-top: 14px; border-top: 1px solid #ddd; text-align: center; font-size: 12px; color: #555; }
          .barcode-area { font-family: monospace; font-size: 16px; letter-spacing: 0.06em; padding: 6px 12px; border: 1px solid #ddd; display: inline-block; }
          @media print {
            body { padding: 0.25in; }
            @page { margin: 0.25in; }
          }
        `}</style>
      </head>
      <body>
        <div className="header">
          <div>
            <h1>Packing Slip</h1>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#555" }}>
              {data.org_name ?? "Clandestine Distribution"}
            </p>
            {/* Phase 11.1 — primary artist callout when BC enrichment landed. */}
            {data.artist && <p className="artist-line">{data.artist}</p>}
          </div>
          <div className="meta">
            <div>
              <strong>{data.order_number}</strong>
            </div>
            {data.order_date && <div>{new Date(data.order_date).toLocaleDateString()}</div>}
            {isInternational && (
              <div style={{ marginTop: "4px", color: "#b91c1c", fontWeight: 600 }}>
                INTERNATIONAL — {data.ship_to.country}
              </div>
            )}
            <div className="barcode-area" style={{ marginTop: "6px" }}>
              {data.order_number}
            </div>
          </div>
        </div>

        <div className="addresses">
          <div className="addr-block">
            <h2>Ship From</h2>
            <address>
              <div className="label">Clandestine Distribution</div>
              <div>2701 Spring Grove Ave, Suite 403</div>
              <div>Cincinnati, OH 45225</div>
              <div>USA</div>
            </address>
          </div>
          <div className="addr-block">
            <h2>Ship To</h2>
            <address>
              {data.ship_to.name && <div className="label">{data.ship_to.name}</div>}
              {data.ship_to.company && <div>{data.ship_to.company}</div>}
              {data.ship_to.street1 && <div>{data.ship_to.street1}</div>}
              {data.ship_to.street2 && <div>{data.ship_to.street2}</div>}
              {(data.ship_to.city || data.ship_to.state || data.ship_to.postalCode) && (
                <div>
                  {[data.ship_to.city, data.ship_to.state, data.ship_to.postalCode]
                    .filter(Boolean)
                    .join(", ")}
                </div>
              )}
              {data.ship_to.country && data.ship_to.country !== "US" && (
                <div>{data.ship_to.country}</div>
              )}
              {data.customer_email && (
                <div style={{ marginTop: "6px", color: "#777", fontSize: "11px" }}>
                  {data.customer_email}
                </div>
              )}
            </address>
          </div>
        </div>

        {/* Phase 11.1 — Buyer note (regular comment from BC checkout). */}
        {data.buyer_note && (
          <div className="panel note">
            <div className="panel-label">Note from buyer</div>
            <div className="panel-body">{sanitizeBuyerText(data.buyer_note)}</div>
          </div>
        )}

        {/* Phase 11.1 — Ship instructions (gift messages, address quirks). */}
        {data.ship_notes && (
          <div className="panel gift">
            <div className="panel-label">Ship instructions / gift</div>
            <div className="panel-body">{sanitizeBuyerText(data.ship_notes)}</div>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th style={{ width: "48px" }}></th>
              <th style={{ width: "120px" }}>SKU</th>
              <th>Item</th>
              <th className="qty" style={{ width: "60px" }}>
                Qty
              </th>
              <th className="price" style={{ width: "90px" }}>
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: print-only packing slip; no re-orders or re-renders
              <tr key={`${it.sku ?? "x"}-${idx}`}>
                <td>
                  {/* Phase 11.1 — album thumbnail when BC mapping has one. */}
                  {it.image_url && (
                    // biome-ignore lint/performance/noImgElement: print-only document markup
                    <img className="item-thumb" src={it.image_url} alt="" />
                  )}
                </td>
                <td style={{ fontFamily: "monospace", fontSize: "12px", color: "#555" }}>
                  {it.sku ?? "—"}
                </td>
                <td>
                  {it.name ?? "—"}
                  {(it.artist || it.album_title) && (
                    <div className="item-meta">
                      {[it.artist, it.album_title].filter(Boolean).join(" — ")}
                    </div>
                  )}
                  {/* Phase 11.1 — customs description on international slips
                      so pickers + customs see the same line item. */}
                  {isInternational && it.customs_description && (
                    <div className="customs-line">Customs: {it.customs_description}</div>
                  )}
                </td>
                <td className="qty">×{it.quantity}</td>
                <td className="price">
                  {it.unit_price != null ? `$${it.unit_price.toFixed(2)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ textAlign: "right" }}>
                Item total
              </td>
              <td className="price">${itemTotal.toFixed(2)}</td>
            </tr>
            {/* Phase 11.1 — fan-tip footer line when buyer added an extra. */}
            {data.additional_fan_contribution != null && data.additional_fan_contribution > 0 && (
              <tr>
                <td colSpan={5} className="tip-line" style={{ textAlign: "center" }}>
                  Thanks for tipping an extra $ {data.additional_fan_contribution.toFixed(2)}.
                </td>
              </tr>
            )}
          </tfoot>
        </table>

        <div className="footer">
          Thanks for the support — your order ships from Cincinnati, Ohio. Questions? Reply to your
          order confirmation email and we'll take care of it.
        </div>

        <PrintTrigger />
      </body>
    </html>
  );
}

// Phase 11.1 — `sanitizeBuyerText` lives in
// `src/lib/shared/sanitize-buyer-text.ts` so it's testable in isolation.

// Tiny client component that auto-triggers Cmd+P on load. Kept inline to
// avoid a separate file for one effect.
function PrintTrigger() {
  return (
    <script
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, no user input
      dangerouslySetInnerHTML={{
        __html: `
          if (typeof window !== "undefined") {
            // Defer to the next tick so the page paints first.
            setTimeout(function() { window.print(); }, 100);
          }
        `,
      }}
    />
  );
}
