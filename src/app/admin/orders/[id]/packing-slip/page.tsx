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
          .meta { text-align: right; font-size: 12px; color: #555; }
          .meta strong { color: #111; }
          .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin: 20px 0; }
          .addr-block address { font-style: normal; line-height: 1.4; font-size: 13px; }
          .addr-block .label { font-weight: 600; margin-bottom: 4px; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; }
          th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; font-weight: 500; }
          td.qty, td.price, th.qty, th.price { text-align: right; font-variant-numeric: tabular-nums; }
          tfoot td { border-bottom: none; padding-top: 12px; font-weight: 600; }
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
          </div>
          <div className="meta">
            <div>
              <strong>{data.order_number}</strong>
            </div>
            {data.order_date && (
              <div>{new Date(data.order_date).toLocaleDateString()}</div>
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

        <table>
          <thead>
            <tr>
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
              <tr key={`${it.sku ?? "x"}-${idx}`}>
                <td style={{ fontFamily: "monospace", fontSize: "12px", color: "#555" }}>
                  {it.sku ?? "—"}
                </td>
                <td>{it.name ?? "—"}</td>
                <td className="qty">×{it.quantity}</td>
                <td className="price">
                  {it.unit_price != null ? `$${it.unit_price.toFixed(2)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ textAlign: "right" }}>
                Item total
              </td>
              <td className="price">${itemTotal.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="footer">
          Thanks for the support — your order ships from Cincinnati, Ohio. Questions?
          Reply to your order confirmation email and we'll take care of it.
        </div>

        <PrintTrigger />
      </body>
    </html>
  );
}

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
