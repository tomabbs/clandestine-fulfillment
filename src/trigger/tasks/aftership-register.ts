/**
 * AfterShip tracking registration — event trigger.
 *
 * Receives shipment_id, registers tracking with AfterShip.
 * If AfterShip rejects (duplicate, invalid), creates review queue item.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task } from "@trigger.dev/sdk";
import { createTracking } from "@/lib/clients/aftership-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const aftershipRegisterTask = task({
  id: "aftership-register",
  maxDuration: 30,
  run: async (payload: { shipment_id: string }) => {
    const supabase = createServiceRoleClient();

    const { data: shipment } = await supabase
      .from("warehouse_shipments")
      .select(`
        id, tracking_number, carrier, order_id, org_id, workspace_id,
        warehouse_orders!order_id(customer_email, customer_name)
      `)
      .eq("id", payload.shipment_id)
      .single();

    if (!shipment) throw new Error(`Shipment ${payload.shipment_id} not found`);
    if (!shipment.tracking_number || !shipment.carrier) {
      return { skipped: true, reason: "no_tracking_info" };
    }

    const orderRaw = shipment.warehouse_orders;
    const order = (Array.isArray(orderRaw) ? (orderRaw[0] ?? null) : orderRaw) as {
      customer_email: string | null;
      customer_name: string | null;
    } | null;

    try {
      const tracking = await createTracking(shipment.tracking_number, shipment.carrier, {
        title: `Shipment ${shipment.id}`,
        orderId: shipment.order_id ?? undefined,
        emails: order?.customer_email ? [order.customer_email] : undefined,
        customerName: order?.customer_name ?? undefined,
      });

      return { registered: true, aftershipId: tracking.id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isDuplicate = msg.includes("4003") || msg.includes("already exists");
      const isInvalid = msg.includes("4005") || msg.includes("invalid");

      if (isDuplicate) {
        return { registered: false, reason: "duplicate" };
      }

      // Create review queue item for unexpected errors
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: shipment.workspace_id,
        org_id: shipment.org_id,
        category: "tracking",
        severity: isInvalid ? "low" : "medium",
        title: `AfterShip registration failed: ${shipment.tracking_number}`,
        description: `Carrier: ${shipment.carrier}. Error: ${msg}`,
        metadata: {
          shipment_id: shipment.id,
          tracking_number: shipment.tracking_number,
          carrier: shipment.carrier,
          error: msg,
        },
        group_key: `aftership_register:${shipment.id}`,
        status: "open",
      });

      return { registered: false, reason: "error", error: msg };
    }
  },
});
