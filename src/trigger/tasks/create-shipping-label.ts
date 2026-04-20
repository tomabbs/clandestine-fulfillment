/**
 * Create a shipping label via EasyPost.
 *
 * Handles both fulfillment orders (warehouse_orders) and mail orders (mailorder_orders).
 * Selects the best rate respecting Media Mail eligibility — checked from product variants.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { logger, task, tasks } from "@trigger.dev/sdk";
import {
  ASENDIA_CARRIER_ACCOUNT_ID,
  buyLabel,
  createShipment,
  type EasyPostRate,
  type EasyPostShipment,
  isDomesticShipment,
  selectBestRate,
  WAREHOUSE_ADDRESS,
} from "@/lib/clients/easypost-client";
import {
  computeRateSignature,
  IdempotencyPriorFailureError,
  purchaseLabelIdempotent,
} from "@/lib/server/label-purchase-idempotency";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { normalizeAddress } from "@/lib/shared/address-normalize";
import { generatePublicTrackToken } from "@/lib/shared/public-track-token";
import {
  aggregateParcelDimensions,
  buildCustomsItems,
  type CustomsLineItemInput,
  type VariantCustomsData,
  type VariantDimensions,
} from "@/lib/shared/customs-builder";

/**
 * Stable rate selection key. Phase 0.2 introduced the carrier+service+rate
 * triple; Phase 0.5.2 strengthens it with currency + carrier_account_id +
 * deliveryDays as tiebreakers for the rare same-account collision case
 * (USPS Priority with-vs-without tracking at the same price).
 */
export interface SelectedRateKey {
  carrier: string;
  service: string;
  rate: number;
  currency?: string | null;
  carrierAccountId?: string | null;
  deliveryDays?: number | null;
}

/**
 * Resolve the staff-selected rate against a freshly-fetched set of EP rates.
 *
 * Resolution order (most specific → least):
 *   1. Exact match on (carrier, service, rate ±$0.01) AND any provided tiebreakers
 *      (currency, deliveryDays). Carrier_account_id is not on the EP Rate object
 *      directly so we match by carrier+service+rate as the primary key.
 *   2. Exact match on (carrier, service, rate ±$0.01) ignoring tiebreakers.
 *   3. Match on (carrier, service) only — rate drift accepted; the caller's
 *      price-delta circuit breaker (assertRateDelta) decides whether to proceed.
 *   4. None — caller falls back to selectBestRate.
 *
 * Exposed for unit testing.
 */
export function resolveSelectedRate(
  rates: EasyPostRate[],
  selected: SelectedRateKey | undefined,
): { rate: EasyPostRate | null; via: "exact" | "exact_loose" | "carrier_service" | "none" } {
  if (!selected) return { rate: null, via: "none" };

  const sameCarrierService = rates.filter(
    (r) =>
      r.carrier.toLowerCase() === selected.carrier.toLowerCase() && r.service === selected.service,
  );
  if (sameCarrierService.length === 0) return { rate: null, via: "none" };

  const sameAmount = sameCarrierService.filter(
    (r) => Math.abs(parseFloat(r.rate) - selected.rate) < 0.01,
  );

  if (sameAmount.length > 0) {
    // Apply tiebreakers when staff supplied them.
    if (selected.deliveryDays != null) {
      const sameDays = sameAmount.find((r) => r.delivery_days === selected.deliveryDays);
      if (sameDays) return { rate: sameDays, via: "exact" };
    }
    return { rate: sameAmount[0] ?? null, via: sameAmount.length === 1 ? "exact" : "exact_loose" };
  }

  return { rate: sameCarrierService[0] ?? null, via: "carrier_service" };
}

/**
 * Phase 0.5.2 — Price-delta circuit breaker.
 *
 * EP rates are volatile; a quoted rate can disappear minutes later if a carrier
 * updates routing tables. This helper compares the staff's preview selection
 * against the actual purchase candidate and returns a verdict:
 *
 *   "proceed"    — delta within warn threshold (default $0.50). Silent.
 *   "warn"       — delta within halt threshold (default $2.00). Proceed but log.
 *   "halt"       — delta above halt threshold. Caller MUST refuse purchase.
 *
 * Defaults are conservative; in Phase 7.3 these become per-workspace settings
 * via workspaces.flags.rate_delta_thresholds.
 *
 * Exposed for unit testing.
 */
export const RATE_DELTA_DEFAULTS = { warn: 0.5, halt: 2.0 };

export function assertRateDelta(
  expectedRate: number,
  actualRate: number,
  thresholds: { warn: number; halt: number } = RATE_DELTA_DEFAULTS,
): { verdict: "proceed" | "warn" | "halt"; deltaUsd: number } {
  const delta = Math.abs(actualRate - expectedRate);
  if (delta <= thresholds.warn) return { verdict: "proceed", deltaUsd: delta };
  if (delta <= thresholds.halt) return { verdict: "warn", deltaUsd: delta };
  return { verdict: "halt", deltaUsd: delta };
}

// ── EP error classification (Phase 0.5.2 — explicit catches per Reviewer 5) ──

/**
 * Classify an error from EP.Shipment.buy into one of:
 *   - "rate_invalid"      — chosen rate no longer exists. Caller should re-quote, NOT auto-fallback blindly.
 *   - "rate_unavailable"  — carrier returned no rates at all. Caller should halt + surface.
 *   - "other"             — unknown error; existing retry/error handling applies.
 */
export function classifyEasyPostError(err: unknown): "rate_invalid" | "rate_unavailable" | "other" {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes("rate not found") ||
    msg.includes("invalid rate") ||
    msg.includes("rate has expired") ||
    msg.includes("rate id is invalid")
  ) {
    return "rate_invalid";
  }
  if (
    msg.includes("no rates") ||
    msg.includes("rates unavailable") ||
    msg.includes("no carrier") ||
    msg.includes("rate not available")
  ) {
    return "rate_unavailable";
  }
  return "other";
}

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
    /** Phase 3.2: extended union — "shipstation" sources from shipstation_orders. */
    orderType: "fulfillment" | "mailorder" | "shipstation";
    /**
     * Legacy: EP rate ID from preview. Unreliable across Shipment.create calls;
     * preserved for back-compat but `selectedRate` (the multi-field key) is preferred.
     */
    selectedRateId?: string;
    /** Phase 0.2 stable selection key — survives EP rate-ID churn across Shipment.create. */
    selectedRate?: SelectedRateKey;
    weight?: number; // oz — defaults to 16 (1 lb)
  }): Promise<LabelResult> => {
    const supabase = createServiceRoleClient();
    const { orderId, orderType, selectedRateId, selectedRate, weight = 16 } = payload;

    // ── Fetch order ───────────────────────────────────────────────────────────
    // Common shape produced by all three branches.
    interface OrderForLabel {
      id: string;
      workspace_id: string;
      org_id: string | null;
      shipping_address: Record<string, unknown> | null;
      customer_name: string | null;
      customer_email: string | null;
      bandcamp_payment_id?: number | null;
      line_items: Array<{
        sku?: string | null;
        title?: string | null;
        name?: string | null;
        quantity?: number;
        price?: number | null;
        unit_price?: number | null;
      }>;
      /** Phase 3.2 — only populated for the SS branch (used by post-label-purchase to enqueue mark-shipped). */
      shipstation_order_id?: string | null;
    }

    let order: OrderForLabel | null = null;

    if (orderType === "fulfillment") {
      const { data } = await supabase
        .from("warehouse_orders")
        .select(
          "id, workspace_id, org_id, shipping_address, customer_name, customer_email, bandcamp_payment_id, line_items",
        )
        .eq("id", orderId)
        .single();
      order = data as OrderForLabel | null;
    } else if (orderType === "mailorder") {
      const { data } = await supabase
        .from("mailorder_orders")
        .select(
          "id, workspace_id, org_id, shipping_address, customer_name, customer_email, line_items",
        )
        .eq("id", orderId)
        .single();
      order = data as OrderForLabel | null;
    } else {
      // Phase 3.2 — shipstation_orders source.
      // shipping_address comes from ship_to JSONB; line_items come from
      // the shipstation_order_items table joined separately.
      const { data: ssOrder } = await supabase
        .from("shipstation_orders")
        .select(
          "id, workspace_id, org_id, ship_to, customer_email, customer_name, shipstation_order_id",
        )
        .eq("id", orderId)
        .single();
      if (!ssOrder) {
        return { success: false, error: "ShipStation order not found" };
      }
      const { data: ssItems } = await supabase
        .from("shipstation_order_items")
        .select("sku, name, quantity, unit_price, item_index")
        .eq("shipstation_order_id", ssOrder.id)
        .order("item_index");
      order = {
        id: ssOrder.id,
        workspace_id: ssOrder.workspace_id,
        org_id: ssOrder.org_id,
        shipping_address: ssOrder.ship_to as Record<string, unknown> | null,
        customer_name: ssOrder.customer_name,
        customer_email: ssOrder.customer_email,
        bandcamp_payment_id: null,
        line_items: (ssItems ?? []).map((it) => ({
          sku: it.sku,
          name: it.name,
          quantity: it.quantity,
          unit_price: it.unit_price,
        })),
        shipstation_order_id: String(ssOrder.shipstation_order_id),
      };
    }

    if (!order) return { success: false, error: "Order not found" };
    if (!order.shipping_address) return { success: false, error: "Order has no shipping address" };
    if (!order.org_id) {
      return {
        success: false,
        error: "Order has no resolved org_id (assign via cockpit drawer first)",
      };
    }

    // ── Normalize address ─────────────────────────────────────────────────────
    const toAddress = normalizeAddress(order.shipping_address);
    const countryCode = toAddress.country;

    // ── Determine Media Mail eligibility + customs metadata ───────────────────
    // ALL variants in the order must have media_mail_eligible = true.
    // Phase 0.5.4 + 0.5.5 + 0.5.6: also fetch hs_tariff_code + length/width/height
    // for international customs declarations and dim-weight rate accuracy.
    // Phase 3.2: line_items shape varies by source — fulfillment uses {sku,title,price};
    // shipstation uses {sku,name,unit_price}. Normalize both.
    const lineItems = order.line_items;
    const skus = lineItems
      .map((li) => li.sku)
      .filter((s): s is string => !!s && s !== "UNKNOWN");

    let mediaMailEligible = false;
    const variantCustomsBySku = new Map<string, VariantCustomsData>();
    const variantDimsBySku = new Map<string, VariantDimensions>();

    if (skus.length > 0) {
      const { data: variants } = await supabase
        .from("warehouse_product_variants")
        .select("sku, media_mail_eligible, hs_tariff_code, length_in, width_in, height_in")
        .in("sku", skus);

      const mediaMap = new Map(
        (variants ?? []).map((v) => [v.sku, v.media_mail_eligible ?? true]),
      );

      // Eligible only if ALL found variants are eligible (and at least one was found)
      const foundSkus = skus.filter((sku) => mediaMap.has(sku));
      mediaMailEligible =
        foundSkus.length > 0 && foundSkus.every((sku) => mediaMap.get(sku) === true);

      for (const v of variants ?? []) {
        variantCustomsBySku.set(v.sku, {
          sku: v.sku,
          hsTariffCode: v.hs_tariff_code,
          // Phase 11 will join product_category from bandcamp_product_mappings;
          // for now category is not piped through (HS resolution falls back to
          // the explicit hs_tariff_code or the global default).
          productCategory: null,
        });
        variantDimsBySku.set(v.sku, {
          sku: v.sku,
          lengthIn: v.length_in,
          widthIn: v.width_in,
          heightIn: v.height_in,
        });
      }
    }

    // Aggregate parcel dimensions (max on each axis across all variants in the
    // shipment). Falls through to easypost-client.ts defaults when no variant
    // supplied dimensions.
    const aggregatedDims = aggregateParcelDimensions(skus, variantDimsBySku);

    // Pre-build customs items for international shipments only (Phase 0.5.4).
    // Domestic shipments don't need customs declarations.
    const isInternationalForCustoms = !isDomesticShipment(countryCode);
    let customsItems: ReturnType<typeof buildCustomsItems> | undefined;
    if (isInternationalForCustoms && lineItems.length > 0) {
      // Phase 3.2 — accept either {title,price} (fulfillment) or {name,unit_price} (shipstation).
      const customsLineInputs: CustomsLineItemInput[] = lineItems.map((li) => ({
        sku: li.sku ?? null,
        title: li.title ?? li.name ?? null,
        quantity: li.quantity ?? 1,
        unitPrice: li.price ?? li.unit_price ?? 0,
      }));
      customsItems = buildCustomsItems({
        lineItems: customsLineInputs,
        variantsBySku: variantCustomsBySku,
        totalWeightOz: weight,
      });
    }

    // ── Create EasyPost shipment + rates ──────────────────────────────────────
    // PARITY (Phase 0.2 + 0.5.1): purchase MUST request the same rate set the preview
    // showed. That means passing mediaMailEligible (so EP returns Media Mail rates)
    // and, for international, the Asendia carrier account (so EP returns Asendia
    // rates instead of defaulting to USPS International at $30+).
    const isInternational = !isDomesticShipment(countryCode);
    const carrierAccountIds = isInternational ? [ASENDIA_CARRIER_ACCOUNT_ID] : undefined;

    try {
      const shipment = await createShipment(
        {
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
          parcel: {
            weight,
            length: aggregatedDims.length ?? undefined,
            width: aggregatedDims.width ?? undefined,
            height: aggregatedDims.height ?? undefined,
          },
          mediaMailEligible,
          customsItems,
        },
        carrierAccountIds,
      );

      if (!shipment.rates.length) {
        return {
          success: false,
          error: "No shipping rates available from EasyPost",
          needsManualShipping: isInternational,
        };
      }

      // ── Select rate ───────────────────────────────────────────────────────────
      // Resolution order:
      //   1. New stable key (carrier+service+amount + tiebreakers) — survives EP rate-ID churn.
      //   2. Legacy rate-ID lookup — back-compat for callers not yet upgraded.
      //   3. selectBestRate fallback (logs sensor event easypost.rate_fallback_used).
      let chosenRate: EasyPostRate | null = null;
      let resolutionVia:
        | "exact"
        | "exact_loose"
        | "carrier_service"
        | "legacy_id"
        | "best_rate" = "best_rate";

      const stable = resolveSelectedRate(shipment.rates, selectedRate);
      if (stable.rate && stable.via !== "none") {
        chosenRate = stable.rate;
        resolutionVia = stable.via;
      } else if (selectedRateId) {
        chosenRate = shipment.rates.find((r) => r.id === selectedRateId) ?? null;
        if (chosenRate) resolutionVia = "legacy_id";
      }

      if (!chosenRate) {
        chosenRate = selectBestRate(shipment.rates, mediaMailEligible);
        if (chosenRate) {
          logger.warn(
            `[create-shipping-label] Falling back to selectBestRate for order ${orderId}; staff selection (${selectedRate?.carrier}/${selectedRate?.service}) was unavailable`,
          );
          await supabase.from("sensor_readings").insert({
            workspace_id: order.workspace_id,
            sensor_name: "easypost.rate_fallback_used",
            status: "warning",
            message: `Staff selection ${selectedRate?.carrier ?? "?"}/${selectedRate?.service ?? "?"} was unavailable at purchase; auto-selected ${chosenRate.carrier}/${chosenRate.service} at $${chosenRate.rate}`,
            value: {
              order_external_id: order.id,
              expected_carrier: selectedRate?.carrier ?? null,
              expected_service: selectedRate?.service ?? null,
              expected_rate: selectedRate?.rate ?? null,
              actual_carrier: chosenRate.carrier,
              actual_service: chosenRate.service,
              actual_rate: parseFloat(chosenRate.rate),
            },
          });
        }
      }

      if (!chosenRate) {
        return { success: false, error: "Could not select a shipping rate" };
      }

      // ── Price-delta circuit breaker ───────────────────────────────────────────
      if (selectedRate) {
        const delta = assertRateDelta(selectedRate.rate, parseFloat(chosenRate.rate));
        if (delta.verdict === "halt") {
          logger.error(
            `[create-shipping-label] Rate-delta circuit breaker HALT: expected $${selectedRate.rate}, actual $${chosenRate.rate} (delta $${delta.deltaUsd.toFixed(2)})`,
          );
          await supabase.from("sensor_readings").insert({
            workspace_id: order.workspace_id,
            sensor_name: "easypost.rate_delta_halt",
            status: "critical",
            message: `Rate delta of $${delta.deltaUsd.toFixed(2)} exceeded halt threshold for order ${order.id}`,
            value: {
              order_external_id: order.id,
              expected_rate: selectedRate.rate,
              actual_rate: parseFloat(chosenRate.rate),
              delta_usd: delta.deltaUsd,
            },
          });
          return {
            success: false,
            error: `Rate changed by $${delta.deltaUsd.toFixed(2)} between preview and purchase (limit $${RATE_DELTA_DEFAULTS.halt.toFixed(2)}); requires staff re-confirmation`,
          };
        }
        if (delta.verdict === "warn") {
          logger.warn(
            `[create-shipping-label] Rate delta $${delta.deltaUsd.toFixed(2)} between preview and purchase for order ${orderId} — proceeding`,
          );
        }
      }

      logger.log(
        `[create-shipping-label] Rate resolved via=${resolutionVia} carrier=${chosenRate.carrier} service=${chosenRate.service} rate=${chosenRate.rate}`,
      );

      // ── Buy label (idempotent) ────────────────────────────────────────────────
      // Phase 0.3: stable-key outbox guarantees Shipment.buy fires at most once
      // per (workspace_id, order_external_id, rate_signature) — even if Trigger.dev
      // retries this task or staff re-clicks "Buy" mid-flight.
      let purchased: EasyPostShipment;
      try {
        const result = await purchaseLabelIdempotent<EasyPostShipment>(
          supabase,
          {
            workspaceId: order.workspace_id,
            orderExternalId: order.id,
            orderSource: orderType,
            rate: {
              carrier: chosenRate.carrier,
              service: chosenRate.service,
              rate: chosenRate.rate,
              currency: "USD",
              carrierAccountId: carrierAccountIds?.[0] ?? null,
            },
            easypostShipmentId: shipment.id,
          },
          () => buyLabel(shipment.id, chosenRate.id),
        );
        purchased = result.response;
        if (!result.bought) {
          logger.warn(
            `[create-shipping-label] Returning cached label purchase for order ${orderId} (idempotency key matched). Trigger retry detected — Shipment.buy NOT re-called.`,
          );
        }
      } catch (err) {
        if (err instanceof IdempotencyPriorFailureError) {
          // A previous attempt with the same key failed and we are deliberately
          // not auto-retrying EP. Surface the prior error to the caller.
          return {
            success: false,
            error: `Prior label-purchase attempt failed: ${err.message}`,
          };
        }
        const epClass = classifyEasyPostError(err);
        if (epClass === "rate_invalid" || epClass === "rate_unavailable") {
          // Do NOT trip Trigger.dev's auto-retry. The chosen rate is gone; we
          // need a fresh quote. Caller (cockpit row) sees this and re-quotes.
          await supabase.from("sensor_readings").insert({
            workspace_id: order.workspace_id,
            sensor_name: "easypost.rate_unavailable_at_buy",
            status: "warning",
            message: `EP returned ${epClass} for order ${order.id} at buy time`,
            value: {
              order_external_id: order.id,
              ep_error_class: epClass,
              ep_message: err instanceof Error ? err.message : String(err),
            },
          });
          return {
            success: false,
            error: `EasyPost rate ${epClass === "rate_invalid" ? "expired" : "unavailable"} at purchase time; re-quote required`,
            needsManualShipping: false,
          };
        }
        throw err;
      }

      if (!purchased.tracking_code || !purchased.postage_label?.label_url) {
        return { success: false, error: "Label purchase failed — no tracking code or URL" };
      }

      // ── Insert warehouse_shipment ─────────────────────────────────────────────
      // Phase 3.2 + 1.1 columns: shipstation_order_id, easypost_shipment_id,
      // selected_rate_signature pulled out of label_data JSONB into proper
      // columns so Phase 4 writeback + Phase 7 sensors can index them.
      const rateSignature = computeRateSignature({
        carrier: chosenRate.carrier,
        service: chosenRate.service,
        rate: chosenRate.rate,
        currency: "USD",
        carrierAccountId: carrierAccountIds?.[0] ?? null,
      });
      const shipmentInsert: Record<string, unknown> = {
        workspace_id: order.workspace_id,
        org_id: order.org_id,
        // Phase 12 — generate the public tracking page token at insert time.
        // 22-char URL-safe random; UNIQUE constraint on the column dedupes.
        public_track_token: generatePublicTrackToken(),
        public_track_token_generated_at: new Date().toISOString(),
        tracking_number: purchased.tracking_code,
        carrier: chosenRate.carrier,
        service: chosenRate.service,
        ship_date: new Date().toISOString().split("T")[0],
        status: "label_created",
        shipping_cost: parseFloat(chosenRate.rate),
        label_source: "easypost",
        easypost_shipment_id: purchased.id,
        selected_rate_signature: rateSignature,
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
      } else if (orderType === "mailorder") {
        shipmentInsert.order_id = null;
        shipmentInsert.mailorder_id = order.id;
      } else {
        // Phase 3.2 — shipstation source. Neither order_id nor mailorder_id
        // applies. shipstation_order_id is the per-order link; per-shipment id
        // gets stamped later by Phase 4 writeback (shipstation_shipment_id).
        shipmentInsert.order_id = null;
        shipmentInsert.mailorder_id = null;
        shipmentInsert.shipstation_order_id = order.shipstation_order_id;
      }

      const { data: warehouseShipment, error: shipError } = await supabase
        .from("warehouse_shipments")
        .insert(shipmentInsert)
        .select("id")
        .single();

      if (shipError || !warehouseShipment) {
        return { success: false, error: `Failed to create shipment record: ${shipError?.message}` };
      }

      // ── Insert warehouse_shipment_items from order line items ─────────────────
      if (orderType === "fulfillment") {
        const { data: orderItems } = await supabase
          .from("warehouse_order_items")
          .select("sku, quantity, title, variant_title")
          .eq("order_id", order.id);

        if (orderItems?.length) {
          await supabase.from("warehouse_shipment_items").insert(
            orderItems.map((item, idx) => ({
              shipment_id: warehouseShipment.id,
              workspace_id: order.workspace_id,
              sku: item.sku,
              quantity: item.quantity,
              product_title: item.title,
              variant_title: item.variant_title,
              item_index: idx,
            })),
          );
        } else {
          logger.warn(`EasyPost label created for order ${order.id} but order has 0 line items`);
        }
      } else if (orderType === "shipstation") {
        // Phase 3.2 — copy items from shipstation_order_items.
        if (order.line_items.length) {
          await supabase.from("warehouse_shipment_items").insert(
            order.line_items.map((item, idx) => ({
              shipment_id: warehouseShipment.id,
              workspace_id: order.workspace_id,
              sku: item.sku ?? "UNKNOWN",
              quantity: item.quantity ?? 1,
              product_title: item.name ?? null,
              variant_title: null,
              item_index: idx,
            })),
          );
        } else {
          logger.warn(
            `EasyPost label created for SS order ${order.id} but order has 0 line items`,
          );
        }
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

      // ── Update order status (fulfillment / mailorder only) ───────────────────
      // Phase 3.2 — for shipstation source we do NOT touch shipstation_orders.order_status
      // here. SS owns that field; Phase 4 writeback flips it via /v2/fulfillments
      // (or v1 markasshipped fallback) and the next poll picks up the transition.
      if (orderType === "fulfillment" || orderType === "mailorder") {
        const orderTable = orderType === "fulfillment" ? "warehouse_orders" : "mailorder_orders";
        await supabase
          .from(orderTable)
          .update({
            fulfillment_status: "fulfilled",
            platform_fulfillment_status: "sent",
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id);
      }

      // ── Hand off to post-label-purchase orchestrator ─────────────────────────
      // Phase 3.2 refactor: previously this block hardcoded aftership-register +
      // mark-platform-fulfilled / mark-mailorder-fulfilled triggers inline. Now
      // a single orchestrator task decides which downstream tasks apply based on
      // the persisted shipment row. Future post-purchase concerns land there
      // without bloating create-shipping-label further.
      await tasks.trigger("post-label-purchase", {
        warehouse_shipment_id: warehouseShipment.id,
      });

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
        needsManualShipping: isInternational,
      };
    }
  },
});
