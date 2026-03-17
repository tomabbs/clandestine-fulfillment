import { task } from "@trigger.dev/sdk";
import {
  matchOrgByPirateShipName,
  type ParsedShipmentWithMatch,
  parseXlsx,
} from "@/lib/clients/pirate-ship-parser";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// Rule #12: Trigger task payloads must be IDs only
interface PirateShipImportPayload {
  importId: string;
  workspaceId: string;
}

export const pirateShipImportTask = task({
  id: "pirate-ship-import",
  run: async (payload: PirateShipImportPayload) => {
    const { importId, workspaceId } = payload;
    const supabase = createServiceRoleClient();

    // Mark as processing
    await supabase
      .from("warehouse_pirate_ship_imports")
      .update({ status: "processing" })
      .eq("id", importId);

    try {
      // Fetch import record to get storage_path
      const { data: importRecord, error: fetchError } = await supabase
        .from("warehouse_pirate_ship_imports")
        .select("*")
        .eq("id", importId)
        .single();

      if (fetchError || !importRecord) {
        throw new Error(`Import record not found: ${importId}`);
      }

      const storagePath = importRecord.storage_path;
      if (!storagePath) {
        throw new Error("Import record has no storage_path");
      }

      // Download XLSX from Supabase Storage
      const { data: fileData, error: downloadError } = await supabase.storage
        .from("pirate-ship-imports")
        .download(storagePath);

      if (downloadError || !fileData) {
        throw new Error(`Failed to download file: ${downloadError?.message ?? "no data"}`);
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());

      // Parse XLSX
      const parsed = parseXlsx(buffer);

      // Update row count
      await supabase
        .from("warehouse_pirate_ship_imports")
        .update({ row_count: parsed.totalRows })
        .eq("id", importId);

      // Match orgs and create shipments
      let processedCount = 0;
      let errorCount = parsed.parseErrors.length;
      const errors: Record<string, unknown>[] = parsed.parseErrors.map((e) => ({
        row: e.rowIndex,
        message: e.message,
      }));

      for (const shipment of parsed.shipments) {
        try {
          // Match org by recipient name/company
          const orgMatch = await matchOrgByPirateShipName(
            shipment.recipientName,
            shipment.recipientCompany,
            workspaceId,
            supabase,
          );

          const shipmentWithMatch: ParsedShipmentWithMatch = {
            ...shipment,
            orgMatch,
          };

          if (orgMatch.matched && orgMatch.orgId) {
            // Create warehouse_shipments record
            const { data: newShipment, error: shipmentError } = await supabase
              .from("warehouse_shipments")
              .insert({
                workspace_id: workspaceId,
                org_id: orgMatch.orgId,
                tracking_number: shipmentWithMatch.trackingNumber,
                carrier: shipmentWithMatch.carrier,
                service: shipmentWithMatch.service,
                ship_date: shipmentWithMatch.shipDate,
                shipping_cost: shipmentWithMatch.cost,
                weight: shipmentWithMatch.weight,
                status: "shipped",
                label_data: {
                  source: "pirate_ship",
                  import_id: importId,
                  order_number: shipmentWithMatch.orderNumber,
                  recipient: {
                    name: shipmentWithMatch.recipientName,
                    company: shipmentWithMatch.recipientCompany,
                    address1: shipmentWithMatch.recipientAddress1,
                    address2: shipmentWithMatch.recipientAddress2,
                    city: shipmentWithMatch.recipientCity,
                    state: shipmentWithMatch.recipientState,
                    zip: shipmentWithMatch.recipientZip,
                    country: shipmentWithMatch.recipientCountry,
                  },
                  customs: shipmentWithMatch.customs,
                },
              })
              .select("id")
              .single();

            if (shipmentError) {
              throw new Error(`Failed to create shipment: ${shipmentError.message}`);
            }

            // Create a warehouse_shipment_items entry (generic line item for the shipment)
            if (newShipment) {
              await supabase.from("warehouse_shipment_items").insert({
                shipment_id: newShipment.id,
                workspace_id: workspaceId,
                sku: shipmentWithMatch.orderNumber ?? "UNKNOWN",
                quantity: 1,
                product_title: `Pirate Ship import - ${shipmentWithMatch.recipientName ?? "Unknown"}`,
              });
            }

            processedCount++;
          } else {
            // Unmatched org — create review queue item (Rule #39: never crash)
            await supabase.from("warehouse_review_queue").insert({
              workspace_id: workspaceId,
              category: "pirate_ship_unmatched_org",
              severity: "medium",
              title: `Unmatched Pirate Ship shipment: ${shipmentWithMatch.recipientName ?? shipmentWithMatch.recipientCompany ?? "Unknown"}`,
              description: `Row ${shipmentWithMatch.rowIndex}: Could not match recipient "${shipmentWithMatch.recipientName ?? ""}" / "${shipmentWithMatch.recipientCompany ?? ""}" to any organization's pirate_ship_name. Tracking: ${shipmentWithMatch.trackingNumber ?? "N/A"}`,
              metadata: {
                import_id: importId,
                row_index: shipmentWithMatch.rowIndex,
                tracking_number: shipmentWithMatch.trackingNumber,
                recipient_name: shipmentWithMatch.recipientName,
                recipient_company: shipmentWithMatch.recipientCompany,
                order_number: shipmentWithMatch.orderNumber,
              },
              status: "open",
              group_key: `pirate_ship_unmatched:${importId}:${shipmentWithMatch.recipientName ?? shipmentWithMatch.recipientCompany ?? "unknown"}`,
              occurrence_count: 1,
            });

            processedCount++;
          }
        } catch (err) {
          errorCount++;
          errors.push({
            row: shipment.rowIndex,
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      // Mark completed
      await supabase
        .from("warehouse_pirate_ship_imports")
        .update({
          status: "completed",
          processed_count: processedCount,
          error_count: errorCount,
          errors,
          completed_at: new Date().toISOString(),
        })
        .eq("id", importId);

      return {
        importId,
        totalRows: parsed.totalRows,
        processedCount,
        errorCount,
      };
    } catch (err) {
      // Mark failed
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await supabase
        .from("warehouse_pirate_ship_imports")
        .update({
          status: "failed",
          errors: [{ message: errorMessage }],
          completed_at: new Date().toISOString(),
        })
        .eq("id", importId);

      throw err;
    }
  },
});
