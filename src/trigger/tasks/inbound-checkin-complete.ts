// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: Use service_role for Trigger tasks
// Rule #12: Payloads are IDs only
// Rule #20: ALL inventory changes flow through recordInventoryChange

import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const payloadSchema = z.object({
  shipmentId: z.string().uuid(),
});

export const inboundCheckinComplete = task({
  id: "inbound-checkin-complete",
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { shipmentId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    // Fetch shipment and items
    const { data: shipment, error: shipmentError } = await supabase
      .from("warehouse_inbound_shipments")
      .select("*, warehouse_inbound_items(*)")
      .eq("id", shipmentId)
      .single();

    if (shipmentError || !shipment) {
      throw new Error(`Shipment not found: ${shipmentError?.message ?? "no data"}`);
    }

    const items = (shipment.warehouse_inbound_items ?? []) as {
      id: string;
      sku: string;
      expected_quantity: number;
      received_quantity: number | null;
    }[];

    // Record inventory changes for each item via canonical write path (Rule #20).
    // Using recordInventoryChange (not direct RPC) ensures Redis is updated and
    // fanout triggers Bandcamp/store pushes so stock arrives are visible immediately.
    for (const item of items) {
      if (item.received_quantity === null || item.received_quantity === 0) continue;

      const result = await recordInventoryChange({
        workspaceId: shipment.workspace_id,
        sku: item.sku,
        delta: item.received_quantity,
        source: "inbound",
        correlationId: `inbound:${shipmentId}:${item.id}`,
        metadata: {
          inbound_shipment_id: shipmentId,
          inbound_item_id: item.id,
          expected_quantity: item.expected_quantity,
          received_quantity: item.received_quantity,
        },
      });

      if (!result.success && !result.alreadyProcessed) {
        // Don't crash the whole task — log and continue (Rule #39 pattern)
        await supabase.from("warehouse_review_queue").insert({
          workspace_id: shipment.workspace_id,
          org_id: shipment.org_id,
          category: "inbound_inventory_failure",
          severity: "high",
          title: `Failed to record inventory for SKU ${item.sku}`,
          description: `recordInventoryChange failed for inbound:${shipmentId}:${item.id}`,
          metadata: {
            inbound_shipment_id: shipmentId,
            inbound_item_id: item.id,
            sku: item.sku,
            delta: item.received_quantity,
          },
          status: "open",
          group_key: `inbound_inventory:${shipmentId}:${item.sku}`,
          occurrence_count: 1,
        });
      }
    }

    // Update shipment status to checked_in
    const { error: updateError } = await supabase
      .from("warehouse_inbound_shipments")
      .update({ status: "checked_in" })
      .eq("id", shipmentId);

    if (updateError) {
      throw new Error(`Failed to update shipment status: ${updateError.message}`);
    }

    // Create review queue items for discrepancies (expected != received)
    const discrepancies = items.filter(
      (item) =>
        item.received_quantity !== null && item.received_quantity !== item.expected_quantity,
    );

    if (discrepancies.length > 0) {
      const reviewItems = discrepancies.map((item) => ({
        workspace_id: shipment.workspace_id,
        org_id: shipment.org_id,
        category: "inbound_discrepancy",
        severity: (Math.abs((item.received_quantity ?? 0) - item.expected_quantity) >
        item.expected_quantity * 0.5
          ? "high"
          : "medium") as "high" | "medium",
        title: `Inbound quantity discrepancy for SKU ${item.sku}`,
        description: `Expected ${item.expected_quantity}, received ${item.received_quantity}`,
        metadata: {
          inbound_shipment_id: shipmentId,
          inbound_item_id: item.id,
          sku: item.sku,
          expected: item.expected_quantity,
          received: item.received_quantity,
        },
        status: "open" as const,
        group_key: `inbound_discrepancy:${shipmentId}:${item.sku}`,
        occurrence_count: 1,
      }));

      await supabase.from("warehouse_review_queue").insert(reviewItems);
    }

    return {
      shipmentId,
      itemsProcessed: items.length,
      discrepancies: discrepancies.length,
    };
  },
});
