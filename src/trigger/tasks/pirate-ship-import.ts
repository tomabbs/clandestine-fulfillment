import { logger, task } from "@trigger.dev/sdk";
import { type ParsedShipmentWithMatch, parseXlsx } from "@/lib/clients/pirate-ship-parser";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { normalizeOrderNumber } from "@/lib/shared/order-utils";

interface PirateShipImportPayload {
  importId: string;
  workspaceId: string;
}

interface ImportMetrics {
  total_rows: number;
  matched_by_order: number;
  matched_by_customer: number;
  matched_by_alias: number;
  skipped_duplicate: number;
  sent_to_review: number;
  created_with_items: number;
  created_without_items: number;
}

export const pirateShipImportTask = task({
  id: "pirate-ship-import",
  run: async (payload: PirateShipImportPayload) => {
    const { importId, workspaceId } = payload;
    const supabase = createServiceRoleClient();

    await supabase
      .from("warehouse_pirate_ship_imports")
      .update({ status: "processing" })
      .eq("id", importId);

    try {
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

      const { data: fileData, error: downloadError } = await supabase.storage
        .from("pirate-ship-imports")
        .download(storagePath);

      if (downloadError || !fileData) {
        throw new Error(`Failed to download file: ${downloadError?.message ?? "no data"}`);
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const parsed = parseXlsx(buffer);

      await supabase
        .from("warehouse_pirate_ship_imports")
        .update({ row_count: parsed.totalRows })
        .eq("id", importId);

      let errorCount = parsed.parseErrors.length;
      const perRowErrors: Record<string, unknown>[] = parsed.parseErrors.map((e) => ({
        row: e.rowIndex,
        message: e.message,
      }));

      const metrics: ImportMetrics = {
        total_rows: parsed.shipments.length,
        matched_by_order: 0,
        matched_by_customer: 0,
        matched_by_alias: 0,
        skipped_duplicate: 0,
        sent_to_review: 0,
        created_with_items: 0,
        created_without_items: 0,
      };

      type MatchedOrder = {
        id: string;
        org_id: string;
        order_number: string;
        bandcamp_payment_id: number | null;
      };

      const labelData = (shipment: (typeof parsed.shipments)[number]) => ({
        source: "pirate_ship",
        import_id: importId,
        order_number: shipment.orderNumber,
        recipient: {
          name: shipment.recipientName,
          company: shipment.recipientCompany,
          address1: shipment.recipientAddress1,
          address2: shipment.recipientAddress2,
          city: shipment.recipientCity,
          state: shipment.recipientState,
          zip: shipment.recipientZip,
          country: shipment.recipientCountry,
        },
        customs: shipment.customs,
      });

      const insertShipmentWithItems = async (
        matchedOrder: MatchedOrder,
        shipment: (typeof parsed.shipments)[number],
        orgIdOverride?: string,
      ): Promise<"created" | "duplicate"> => {
        const { data: newShipment, error: shipmentError } = await supabase
          .from("warehouse_shipments")
          .insert({
            workspace_id: workspaceId,
            org_id: orgIdOverride ?? matchedOrder.org_id,
            order_id: matchedOrder.id,
            bandcamp_payment_id: matchedOrder.bandcamp_payment_id,
            tracking_number: shipment.trackingNumber,
            carrier: shipment.carrier,
            service: shipment.service,
            ship_date: shipment.shipDate,
            shipping_cost: shipment.cost,
            weight: shipment.weight,
            status: "shipped",
            label_source: "pirate_ship",
            label_data: labelData(shipment),
          })
          .select("id")
          .single();

        if (shipmentError) {
          if (shipmentError.code === "23505") {
            logger.info(`Tracking ${shipment.trackingNumber} duplicate (23505), skipping`);
            return "duplicate";
          }
          throw new Error(`Failed to create shipment: ${shipmentError.message}`);
        }

        if (newShipment) {
          const { data: orderItems } = await supabase
            .from("warehouse_order_items")
            .select("sku, quantity, title, variant_title")
            .eq("order_id", matchedOrder.id);

          if (orderItems?.length) {
            await supabase.from("warehouse_shipment_items").insert(
              orderItems.map((item, idx) => ({
                shipment_id: newShipment.id,
                workspace_id: workspaceId,
                sku: item.sku,
                quantity: item.quantity,
                product_title: item.title,
                variant_title: item.variant_title,
                item_index: idx,
              })),
            );
            metrics.created_with_items++;
          } else {
            logger.warn(`Order ${matchedOrder.id} matched but has 0 line items`);
            metrics.created_without_items++;
          }
        }

        return "created";
      };

      for (const shipment of parsed.shipments) {
        try {
          // --- Layer 1 dedup: pre-insert check ---
          if (shipment.trackingNumber) {
            const { data: existing } = await supabase
              .from("warehouse_shipments")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("tracking_number", shipment.trackingNumber)
              .eq("label_source", "pirate_ship")
              .maybeSingle();

            if (existing) {
              logger.info(`Tracking ${shipment.trackingNumber} already exists, skipping`);
              metrics.skipped_duplicate++;
              continue;
            }
          }

          let matchedOrder: MatchedOrder | null = null;
          let matchSource: "order" | "customer" | "alias" | null = null;

          // --- Tier 1: Order number matching (when PS export includes order numbers) ---
          const normalized = normalizeOrderNumber(shipment.orderNumber);
          if (normalized) {
            const { data: exactMatch } = await supabase
              .from("warehouse_orders")
              .select("id, org_id, order_number, bandcamp_payment_id")
              .eq("workspace_id", workspaceId)
              .eq("order_number", normalized)
              .maybeSingle();

            matchedOrder = exactMatch;

            if (!matchedOrder) {
              const { data: candidates } = await supabase
                .from("warehouse_orders")
                .select("id, org_id, order_number, bandcamp_payment_id")
                .eq("workspace_id", workspaceId)
                .ilike("order_number", `%${normalized}%`)
                .limit(5);

              matchedOrder =
                candidates?.find(
                  (o) => normalizeOrderNumber(o.order_number) === normalized,
                ) ?? null;
            }

            if (matchedOrder) matchSource = "order";
          }

          // --- Tier 2: Customer email/name matching (primary for PS exports without order numbers) ---
          if (!matchedOrder) {
            const email = shipment.email?.toLowerCase().trim();
            const customerName = shipment.recipientName?.trim();

            if (email) {
              const { data: emailMatch } = await supabase
                .from("warehouse_orders")
                .select("id, org_id, order_number, bandcamp_payment_id")
                .eq("workspace_id", workspaceId)
                .ilike("customer_email", email)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (emailMatch) {
                matchedOrder = emailMatch;
                matchSource = "customer";
              }
            }

            if (!matchedOrder && customerName) {
              const { data: nameMatches } = await supabase
                .from("warehouse_orders")
                .select("id, org_id, order_number, bandcamp_payment_id")
                .eq("workspace_id", workspaceId)
                .ilike("customer_name", customerName)
                .order("created_at", { ascending: false })
                .limit(1);

              if (nameMatches?.length) {
                matchedOrder = nameMatches[0];
                matchSource = "customer";
              }
            }
          }

          // --- Tier 3: Org name alias matching (for bulk/label-to-label shipments) ---
          if (!matchedOrder) {
            const recipientLower = (
              shipment.recipientName ??
              shipment.recipientCompany ??
              ""
            ).toLowerCase().trim();

            if (recipientLower) {
              const { data: orgs } = await supabase
                .from("organizations")
                .select("id, name")
                .eq("workspace_id", workspaceId);

              const aliasMatch = orgs?.find((o) => {
                const orgLower = o.name.toLowerCase().trim();
                return orgLower === recipientLower || recipientLower.includes(orgLower) || orgLower.includes(recipientLower);
              });

              if (aliasMatch) {
                matchSource = "alias";
                // Insert shipment with org_id only (no order linkage)
                const { data: newShipment, error: shipmentError } = await supabase
                  .from("warehouse_shipments")
                  .insert({
                    workspace_id: workspaceId,
                    org_id: aliasMatch.id,
                    tracking_number: shipment.trackingNumber,
                    carrier: shipment.carrier,
                    service: shipment.service,
                    ship_date: shipment.shipDate,
                    shipping_cost: shipment.cost,
                    weight: shipment.weight,
                    status: "shipped",
                    label_source: "pirate_ship",
                    label_data: labelData(shipment),
                  })
                  .select("id")
                  .single();

                if (shipmentError) {
                  if (shipmentError.code === "23505") {
                    metrics.skipped_duplicate++;
                    continue;
                  }
                  throw new Error(`Failed to create shipment: ${shipmentError.message}`);
                }

                metrics.matched_by_alias++;
                if (newShipment) metrics.created_without_items++;
                continue;
              }
            }
          }

          // --- Insert shipment for Tier 1 or Tier 2 match ---
          if (matchedOrder) {
            const result = await insertShipmentWithItems(matchedOrder, shipment);
            if (result === "duplicate") {
              metrics.skipped_duplicate++;
            } else if (matchSource === "order") {
              metrics.matched_by_order++;
            } else {
              metrics.matched_by_customer++;
            }
            continue;
          }

          // --- Tier 4: Review queue fallback ---
          await supabase.from("warehouse_review_queue").insert({
            workspace_id: workspaceId,
            category: "pirate_ship_unmatched_org",
            severity: "medium",
            title: `Unmatched Pirate Ship shipment: ${shipment.recipientName ?? shipment.recipientCompany ?? "Unknown"}`,
            description: `Row ${shipment.rowIndex}: Could not match to any order or organization. Tracking: ${shipment.trackingNumber ?? "N/A"}`,
            metadata: {
              import_id: importId,
              row_index: shipment.rowIndex,
              tracking_number: shipment.trackingNumber,
              recipient_name: shipment.recipientName,
              recipient_company: shipment.recipientCompany,
              order_number: shipment.orderNumber,
              email: shipment.email,
            },
            status: "open",
            group_key: `pirate_ship_unmatched:${importId}:${shipment.trackingNumber ?? shipment.rowIndex}`,
            occurrence_count: 1,
          });

          metrics.sent_to_review++;
        } catch (err) {
          errorCount++;
          perRowErrors.push({
            row: shipment.rowIndex,
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      const processedCount =
        metrics.matched_by_order +
        metrics.matched_by_customer +
        metrics.matched_by_alias +
        metrics.skipped_duplicate;

      await supabase
        .from("warehouse_pirate_ship_imports")
        .update({
          status: "completed",
          processed_count: processedCount,
          error_count: errorCount,
          errors: { per_row_errors: perRowErrors, metrics },
          completed_at: new Date().toISOString(),
        })
        .eq("id", importId);

      logger.info("Pirate Ship import complete", { importId, metrics });

      return { importId, totalRows: parsed.totalRows, processedCount, errorCount, metrics };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await supabase
        .from("warehouse_pirate_ship_imports")
        .update({
          status: "failed",
          errors: [{ message: errorMessage }],
          completed_at: new Date().toISOString(),
        })
        .eq("id", importId);

      await supabase.from("sensor_readings").insert({
        sensor_name: "trigger:pirate-ship-import",
        status: "error",
        message: `Import ${importId} failed: ${errorMessage}`,
      });

      throw err;
    }
  },
});
