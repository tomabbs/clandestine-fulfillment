/**
 * Create a shipping label via EasyPost.
 *
 * Handles both fulfillment orders (warehouse_orders) and mail orders (mailorder_orders).
 * Selects the best rate respecting Media Mail eligibility — checked from product variants.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task, tasks } from "@trigger.dev/sdk";
import {
  buyLabel,
  createShipment,
  isDomesticShipment,
  selectBestRate,
  WAREHOUSE_ADDRESS,
} from "@/lib/clients/easypost-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { normalizeAddress } from "@/lib/shared/address-normalize";

export interface LabelResult {
  success: boolean;
  shipmentId?: string;
  easypostShipmentId?: string;
  trackingNumber?: string;
  labelUrl?: string;
  carrier?: string;
  service?: string;
  rate?: number;
  needsManualShipping?: boolean;
  error?: string;
}

export const createShippingLabelTask = task({
  id: "create-shipping-label",
  maxDuration: 60,
  run: async (payload: {
    orderId: string;
    orderType: "fulfillment" | "mailorder";
    selectedRateId?: string;
    weight?: number; // oz — defaults to 16 (1 lb)
  }): Promise<LabelResult> => {
    const supabase = createServiceRoleClient();
    const { orderId, orderType, selectedRateId, weight = 16 } = payload;

    // ── Fetch order ───────────────────────────────────────────────────────────
    let order: {
      id: string;
      workspace_id: string;
      org_id: string;
      shipping_address: Record<string, unknown> | null;
      customer_name: string | null;
      customer_email: string | null;
      bandcamp_payment_id?: number | null;
      line_items: Array<{ sku?: string }>;
    } | null = null;

    if (orderType === "fulfillment") {
      const { data } = await supabase
        .from("warehouse_orders")
        .select(
          "id, workspace_id, org_id, shipping_address, customer_name, customer_email, bandcamp_payment_id, line_items",
        )
        .eq("id", orderId)
        .single();
      order = data;
    } else {
      const { data } = await supabase
        .from("mailorder_orders")
        .select(
          "id, workspace_id, org_id, shipping_address, customer_name, customer_email, line_items",
        )
        .eq("id", orderId)
        .single();
      order = data;
    }

    if (!order) return { success: false, error: "Order not found" };
    if (!order.shipping_address) return { success: false, error: "Order has no shipping address" };

    // ── Normalize address ─────────────────────────────────────────────────────
    const toAddress = normalizeAddress(order.shipping_address);
    const countryCode = toAddress.country;

    // ── Determine Media Mail eligibility ──────────────────────────────────────
    // ALL variants in the order must have media_mail_eligible = true
    const skus = (order.line_items as Array<{ sku?: string }>)
      .map((li) => li.sku)
      .filter((s): s is string => !!s);

    let mediaMailEligible = false;

    if (skus.length > 0) {
      const { data: variants } = await supabase
        .from("warehouse_product_variants")
        .select("sku, media_mail_eligible")
        .in("sku", skus);

      const variantMap = new Map(
        (variants ?? []).map((v) => [v.sku, v.media_mail_eligible ?? true]),
      );

      // Eligible only if ALL found variants are eligible (and at least one was found)
      const foundSkus = skus.filter((sku) => variantMap.has(sku));
      mediaMailEligible =
        foundSkus.length > 0 && foundSkus.every((sku) => variantMap.get(sku) === true);
    }

    // ── Create EasyPost shipment + rates ──────────────────────────────────────
    try {
      const shipment = await createShipment({
        fromAddress: WAREHOUSE_ADDRESS,
        toAddress: {
          name: toAddress.name || (order.customer_name ?? ""),
          street1: toAddress.street1,
          street2: toAddress.street2,
          city: toAddress.city,
          state: toAddress.state,
          zip: toAddress.zip,
          country: countryCode,
          phone: toAddress.phone,
        },
        parcel: { weight },
      });

      if (!shipment.rates.length) {
        return {
          success: false,
          error: "No shipping rates available from EasyPost",
          needsManualShipping: !isDomesticShipment(countryCode),
        };
      }

      // ── Select rate ───────────────────────────────────────────────────────────
      let chosenRate = selectedRateId
        ? (shipment.rates.find((r) => r.id === selectedRateId) ?? null)
        : null;

      if (!chosenRate) {
        chosenRate = selectBestRate(shipment.rates, mediaMailEligible);
      }

      if (!chosenRate) {
        return { success: false, error: "Could not select a shipping rate" };
      }

      // ── Buy label ─────────────────────────────────────────────────────────────
      const purchased = await buyLabel(shipment.id, chosenRate.id);

      if (!purchased.tracking_code || !purchased.postage_label?.label_url) {
        return { success: false, error: "Label purchase failed — no tracking code or URL" };
      }

      // ── Insert warehouse_shipment ─────────────────────────────────────────────
      const shipmentInsert: Record<string, unknown> = {
        workspace_id: order.workspace_id,
        org_id: order.org_id,
        tracking_number: purchased.tracking_code,
        carrier: chosenRate.carrier,
        service: chosenRate.service,
        ship_date: new Date().toISOString().split("T")[0],
        status: "label_created",
        shipping_cost: parseFloat(chosenRate.rate),
        label_source: "easypost",
        label_data: {
          easypost_shipment_id: purchased.id,
          label_url: purchased.postage_label.label_url,
          label_pdf_url: purchased.postage_label.label_pdf_url ?? null,
        },
      };

      if (orderType === "fulfillment") {
        shipmentInsert.order_id = order.id;
        shipmentInsert.mailorder_id = null;
        if (order.bandcamp_payment_id) {
          shipmentInsert.bandcamp_payment_id = order.bandcamp_payment_id;
        }
      } else {
        shipmentInsert.order_id = null;
        shipmentInsert.mailorder_id = order.id;
      }

      const { data: warehouseShipment, error: shipError } = await supabase
        .from("warehouse_shipments")
        .insert(shipmentInsert)
        .select("id")
        .single();

      if (shipError || !warehouseShipment) {
        return { success: false, error: `Failed to create shipment record: ${shipError?.message}` };
      }

      // ── Insert easypost_labels ────────────────────────────────────────────────
      await supabase.from("easypost_labels").insert({
        workspace_id: order.workspace_id,
        shipment_id: warehouseShipment.id,
        easypost_shipment_id: purchased.id,
        tracking_number: purchased.tracking_code,
        carrier: chosenRate.carrier,
        service: chosenRate.service,
        label_url: purchased.postage_label.label_url,
        label_format: "PNG",
        rate_amount: parseFloat(chosenRate.rate),
      });

      // ── Update order status ───────────────────────────────────────────────────
      const orderTable = orderType === "fulfillment" ? "warehouse_orders" : "mailorder_orders";
      await supabase
        .from(orderTable)
        .update({
          fulfillment_status: "fulfilled",
          platform_fulfillment_status: "sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id);

      // ── Trigger downstream tasks ──────────────────────────────────────────────
      await tasks.trigger("aftership-register", { shipment_id: warehouseShipment.id });

      if (orderType === "fulfillment") {
        await tasks.trigger("mark-platform-fulfilled", {
          order_id: order.id,
          tracking_number: purchased.tracking_code,
          carrier: chosenRate.carrier,
        });
      } else {
        await tasks.trigger("mark-mailorder-fulfilled", {
          mailorder_id: order.id,
          tracking_number: purchased.tracking_code,
          carrier: chosenRate.carrier,
        });
      }

      return {
        success: true,
        shipmentId: warehouseShipment.id,
        easypostShipmentId: purchased.id,
        trackingNumber: purchased.tracking_code,
        labelUrl: purchased.postage_label.label_url,
        carrier: chosenRate.carrier,
        service: chosenRate.service,
        rate: parseFloat(chosenRate.rate),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[create-shipping-label]", msg);
      return {
        success: false,
        error: msg,
        needsManualShipping: !isDomesticShipment(countryCode),
      };
    }
  },
});
