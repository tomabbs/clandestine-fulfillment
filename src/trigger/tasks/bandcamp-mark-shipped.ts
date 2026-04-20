/**
 * Bandcamp mark shipped — direct push of tracking info to Bandcamp.
 *
 * Rule #9: Uses bandcampQueue (serialized with other Bandcamp API tasks).
 * Rule #48: API calls happen in Trigger tasks, not Server Actions.
 *
 * Phase 6.5 — POST-CUTOVER ROLE:
 *   ShipStation's Bandcamp store connector (Phase 4.3 writeback with
 *   `notifySalesChannel: true` on v1 / `notify_order_source: true` on v2) is
 *   now the PRIMARY path that tells Bandcamp the order shipped. SS does the
 *   work 99% of the time.
 *
 *   This task is now a manual-trigger-only API wrapper:
 *     - Force-push button on the shipping log → triggers this task by
 *       shipmentId for emergency operator use.
 *     - The 30-min `bandcamp-shipping-verify` cron in
 *       src/trigger/tasks/bandcamp-shipping-verify.ts uses this same task
 *       as its FALLBACK when the SS connector fails to push within 30 min.
 *
 *   The previous 15-min cron (`bandcamp-mark-shipped-cron`) has been
 *   removed. The verify cron is the single scheduled entrypoint now.
 */

import { logger, task } from "@trigger.dev/sdk";
import { refreshBandcampToken, updateShipped } from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export const bandcampMarkShippedTask = task({
  id: "bandcamp-mark-shipped",
  queue: bandcampQueue,
  run: async (payload: { shipmentId?: string }) => {
    const supabase = createServiceRoleClient();

    if (payload.shipmentId) {
      // Single shipment
      await syncOne(supabase, payload.shipmentId);
      return { synced: 1 };
    }

    // Cron mode: find all pending (bandcamp_synced_at is null)
    const { data: pending } = await supabase
      .from("warehouse_shipments")
      .select("id, workspace_id, org_id, bandcamp_payment_id, tracking_number, carrier, ship_date")
      .not("bandcamp_payment_id", "is", null)
      .not("tracking_number", "is", null)
      .is("bandcamp_synced_at", null)
      .limit(50);

    if (!pending?.length) return { synced: 0 };

    let synced = 0;
    for (const s of pending) {
      try {
        await syncOne(supabase, s.id);
        synced++;
      } catch (err) {
        logger.error("Bandcamp mark-shipped failed", {
          shipmentId: s.id,
          error: String(err),
        });
      }
    }
    return { synced };
  },
});

async function syncOne(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipmentId: string,
): Promise<void> {
  const { data: shipment, error: fetchErr } = await supabase
    .from("warehouse_shipments")
    .select("id, workspace_id, bandcamp_payment_id, tracking_number, carrier, ship_date")
    .eq("id", shipmentId)
    .single();

  if (fetchErr || !shipment) {
    throw new Error(`Shipment ${shipmentId} not found`);
  }

  const paymentId = shipment.bandcamp_payment_id as number | null;
  if (!paymentId) {
    throw new Error(`Shipment ${shipmentId} has no bandcamp_payment_id`);
  }

  const trackingNumber = shipment.tracking_number as string | null;
  if (!trackingNumber) {
    throw new Error(`Shipment ${shipmentId} has no tracking_number`);
  }

  const workspaceId = shipment.workspace_id as string;
  const accessToken = await refreshBandcampToken(workspaceId);

  const shipDate = shipment.ship_date
    ? new Date(shipment.ship_date as string).toISOString().replace("T", " ").slice(0, 19)
    : new Date().toISOString().replace("T", " ").slice(0, 19);

  await updateShipped(
    [
      {
        id: paymentId,
        idType: "p",
        shipped: true,
        shipDate,
        carrier: (shipment.carrier as string) ?? undefined,
        trackingCode: trackingNumber,
        notification: true,
      },
    ],
    accessToken,
  );

  await supabase
    .from("warehouse_shipments")
    .update({
      bandcamp_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", shipmentId);

  logger.info("Bandcamp mark-shipped success", {
    shipmentId,
    paymentId,
    trackingNumber,
  });
}

// Phase 6.5 — the 15-min `bandcamp-mark-shipped-cron` schedule was REMOVED.
// The new `bandcamp-shipping-verify` cron in
// src/trigger/tasks/bandcamp-shipping-verify.ts replaces it: at 30-min
// intervals it checks BC's get_orders to see if SS's connector already
// pushed the tracking, and only then falls back to direct update_shipped
// via the manual-trigger-only `bandcamp-mark-shipped` task above.
