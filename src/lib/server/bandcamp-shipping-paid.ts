/**
 * Resolve Bandcamp customer shipping paid (what the fan paid for postage) via merchorders
 * get_orders when Postgres rows were created before we stored shipping_cost / line_items.shipping.
 */

import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

/** Max shipping across line rows (Bandcamp repeats the same value on each item). */
export function shippingPaidFromBandcampLines(lines: BandcampOrderItem[]): number {
  if (lines.length === 0) return 0;
  return Math.max(0, ...lines.map((i) => Number(i.shipping) || 0));
}

function formatBandcampDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Calls get_orders with widening time windows until lines for payment_id are found, or gives up.
 * Tries each active bandcamp_connections row for the org (multi-band labels).
 */
export async function fetchBandcampShippingPaidForPayment(args: {
  workspaceId: string;
  orgId: string;
  paymentId: number;
  /** Prefer shipment.ship_date or order.created_at ISO string */
  anchorDateIso?: string | null;
}): Promise<{ shippingPaid: number } | null> {
  const supabase = createServiceRoleClient();
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("band_id")
    .eq("workspace_id", args.workspaceId)
    .eq("org_id", args.orgId)
    .eq("is_active", true);

  if (!connections?.length) return null;

  const accessToken = await refreshBandcampToken(args.workspaceId);

  const anchor = args.anchorDateIso ? new Date(args.anchorDateIso) : new Date();
  if (Number.isNaN(anchor.getTime())) return null;

  const windows: [Date, Date][] = [
    (() => {
      const start = new Date(anchor);
      start.setDate(start.getDate() - 400);
      const end = new Date(anchor);
      end.setDate(end.getDate() + 30);
      return [start, end];
    })(),
    [new Date("2015-01-01T00:00:00.000Z"), new Date()],
  ];

  for (const conn of connections) {
    const bandId = Number(conn.band_id);
    for (const [start, end] of windows) {
      try {
        const items = await getOrders(
          {
            bandId,
            startTime: formatBandcampDateTime(start),
            endTime: formatBandcampDateTime(end),
          },
          accessToken,
        );
        const lines = items.filter((i) => i.payment_id === args.paymentId);
        if (lines.length > 0) {
          return { shippingPaid: shippingPaidFromBandcampLines(lines) };
        }
      } catch {
        // try next window / connection
      }
    }
  }

  return null;
}
