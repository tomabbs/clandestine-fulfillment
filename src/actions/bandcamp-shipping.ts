"use server";

import { z } from "zod/v4";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

// Rule #48: No Server Action may call the Bandcamp API directly.
// Mark shipped is done via Trigger task (bandcampMarkShippedTask).

const setPaymentIdSchema = z.object({
  shipmentId: z.string().uuid(),
  bandcampPaymentId: z.number().int().positive().nullable(),
});

const triggerSyncSchema = z.object({
  shipmentId: z.string().uuid(),
});

async function requireStaffAuth() {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();
  const { data: userRecord } = await serviceClient
    .from("users")
    .select("role")
    .eq("auth_user_id", data.user.id)
    .single();

  const staffRoles = [
    "admin",
    "super_admin",
    "label_staff",
    "label_management",
    "warehouse_manager",
  ];
  if (!userRecord || !staffRoles.includes(userRecord.role as string)) {
    throw new Error("Staff access required");
  }
}

/**
 * Set or clear bandcamp_payment_id on a shipment.
 * When set + tracking_number exists, the cron or manual trigger will sync to Bandcamp.
 */
export async function setBandcampPaymentId(raw: {
  shipmentId: string;
  bandcampPaymentId: number | null;
}): Promise<{ success: true }> {
  await requireStaffAuth();
  const { shipmentId, bandcampPaymentId } = setPaymentIdSchema.parse(raw);
  const serviceClient = createServiceRoleClient();

  const update: Record<string, unknown> = {
    bandcamp_payment_id: bandcampPaymentId,
    updated_at: new Date().toISOString(),
  };
  if (bandcampPaymentId === null) {
    update.bandcamp_synced_at = null; // Clear so it can be re-synced if set again
  }

  const { error } = await serviceClient
    .from("warehouse_shipments")
    .update(update)
    .eq("id", shipmentId);

  if (error) throw new Error(`Failed to update shipment: ${error.message}`);
  return { success: true };
}

/**
 * Trigger Bandcamp mark-shipped for a single shipment.
 * Requires shipment to have bandcamp_payment_id and tracking_number.
 */
export async function triggerBandcampMarkShipped(raw: {
  shipmentId: string;
}): Promise<{ taskRunId: string }> {
  await requireStaffAuth();
  const { shipmentId } = triggerSyncSchema.parse(raw);
  const serviceClient = createServiceRoleClient();

  const { data: shipment } = await serviceClient
    .from("warehouse_shipments")
    .select("id, bandcamp_payment_id, tracking_number")
    .eq("id", shipmentId)
    .single();

  if (!shipment) throw new Error("Shipment not found");
  if (!shipment.bandcamp_payment_id) throw new Error("Shipment has no Bandcamp payment ID");
  if (!shipment.tracking_number) throw new Error("Shipment has no tracking number");

  const { tasks } = await import("@trigger.dev/sdk");
  const handle = await tasks.trigger("bandcamp-mark-shipped", { shipmentId });

  return { taskRunId: handle.id };
}
