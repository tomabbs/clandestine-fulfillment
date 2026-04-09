/**
 * Generate a SCAN Form for today's unbatched EasyPost labels.
 *
 * A SCAN Form lets USPS scan all packages at once at drop-off,
 * giving each shipment a "USPS Origin Acceptance" event immediately.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is minimal.
 */

import { schedules, task } from "@trigger.dev/sdk";
import { createScanForm } from "@/lib/clients/easypost-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function runScanForm(payload: { workspaceId?: string }): Promise<{
  success: boolean;
  scanFormId?: string;
  formUrl?: string;
  labelCount?: number;
  message?: string;
}> {
  const supabase = createServiceRoleClient();
  const today = new Date().toISOString().split("T")[0] ?? "";

  // Find unbatched labels created today
  let query = supabase
    .from("easypost_labels")
    .select("id, easypost_shipment_id, tracking_number, shipment_id, workspace_id")
    .is("batch_id", null)
    .gte("created_at", `${today}T00:00:00.000Z`)
    .lt("created_at", `${today}T23:59:59.999Z`);

  if (payload.workspaceId) {
    query = query.eq("workspace_id", payload.workspaceId);
  }

  const { data: labels, error: labelsError } = await query;

  if (labelsError) throw new Error(`Failed to fetch labels: ${labelsError.message}`);

  if (!labels?.length) {
    return { success: true, message: "No unbatched labels for today" };
  }

  // Create EasyPost SCAN form via Batch API
  const shipmentIds = labels.map((l) => l.easypost_shipment_id);
  const batch = await createScanForm(shipmentIds);

  if (!batch.scan_form) {
    throw new Error(
      "EasyPost batch created but no scan_form returned — batch may still be processing",
    );
  }

  const workspaceId = labels[0]?.workspace_id;

  // Insert scan_forms record
  const { data: scanForm, error: insertError } = await supabase
    .from("scan_forms")
    .insert({
      workspace_id: workspaceId,
      easypost_batch_id: batch.id,
      easypost_scan_form_id: batch.scan_form.id,
      form_url: batch.scan_form.form_url,
      tracking_codes: batch.scan_form.tracking_codes,
      label_count: labels.length,
      ship_date: today,
      status: "created",
    })
    .select("id")
    .single();

  if (insertError || !scanForm) {
    throw new Error(`Failed to insert scan_form: ${insertError?.message}`);
  }

  // Mark all labels as batched
  await supabase
    .from("easypost_labels")
    .update({ batch_id: scanForm.id })
    .in(
      "id",
      labels.map((l) => l.id),
    );

  // Update shipment statuses to 'manifested'
  await supabase
    .from("warehouse_shipments")
    .update({ status: "manifested", updated_at: new Date().toISOString() })
    .in(
      "id",
      labels.map((l) => l.shipment_id),
    );

  return {
    success: true,
    scanFormId: scanForm.id,
    formUrl: batch.scan_form.form_url,
    labelCount: labels.length,
  };
}

export const generateDailyScanFormTask = task({
  id: "generate-daily-scan-form",
  maxDuration: 120,
  run: async (payload: { workspaceId?: string }) => runScanForm(payload),
});

// Optional: trigger automatically at end of shipping day
export const dailyScanFormSchedule = schedules.task({
  id: "daily-scan-form-cron",
  cron: "0 17 * * *", // 5:00 PM daily
  maxDuration: 120,
  run: async () => runScanForm({}),
});
