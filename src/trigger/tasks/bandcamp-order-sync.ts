/**
 * Bandcamp order sync — poll get_orders and create warehouse_orders.
 *
 * Rule #9: Uses bandcampQueue.
 * Rule #48: API calls in Trigger tasks.
 *
 * Creates warehouse_orders with bandcamp_payment_id so shipments can be linked.
 *
 * Phase 6.4 — POST-CUTOVER ROLE:
 *   After the unified-shipping cutover (Phase 6.3 flipped
 *   `workspaces.flags.shipstation_unified_shipping = true`), staff prints
 *   labels through the new ShipStation cockpit at /admin/orders. This task
 *   no longer powers an active order-display surface. It now serves two
 *   read-only purposes:
 *
 *     1. Confirmation data source for the Phase 6.1 reconciliation badge —
 *        getBandcampMatchForShipStationOrder() looks up the warehouse_orders
 *        row this task created, by bandcamp_payment_id, to confirm the SS
 *        order in the cockpit corresponds to a real BC sale.
 *
 *     2. Enrichment data for Phase 11 (artist, buyer_note, ship_notes,
 *        additional_fan_contribution, payment_state) which the cockpit and
 *        packing slip surface alongside the SS-sourced fields.
 *
 *   Do NOT add label-printing or fulfillment-marking logic here. Phase 4.3
 *   (shipstation-mark-shipped) owns the writeback path; Phase 6.5
 *   (bandcamp-shipping-verify) owns the BC sync verifier.
 *
 *   Phase 0.4 also lives here: financial_status correctly derives from
 *   payment_state via mapBandcampPaymentState() — pre-Phase-0 this was
 *   silently always "paid".
 */

import { idempotencyKeys, logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

/**
 * Phase 0.4 — map Bandcamp payment_state to our financial_status.
 *
 * BC payment_state values seen in the wild: "paid", "pending", "failed",
 * "refunded", "partially_refunded", null/undefined (older orders).
 *
 * Mapping rule (from plan): paid → paid, refunded/partially_refunded → refunded,
 * everything else (incl. null/failed/pending) → pending. We default to pending
 * rather than paid so unpaid/failed orders never get auto-fulfilled.
 *
 * Exposed for unit testing.
 */
export function mapBandcampPaymentState(
  state: string | null | undefined,
): "paid" | "refunded" | "pending" {
  if (!state) return "pending";
  const normalized = state.toLowerCase().trim();
  if (normalized === "paid") return "paid";
  if (normalized === "refunded" || normalized === "partially_refunded") return "refunded";
  return "pending";
}

export const bandcampOrderSyncTask = task({
  id: "bandcamp-order-sync",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = payload.workspaceId
      ? [payload.workspaceId]
      : await getAllWorkspaceIds(supabase);

    let totalCreated = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections?.length) continue;

      const accessToken = await refreshBandcampToken(workspaceId);

      for (const conn of connections) {
        try {
          const endTime = new Date();
          const startTime = new Date(endTime);
          startTime.setDate(startTime.getDate() - 30);

          const items = await getOrders(
            {
              bandId: conn.band_id,
              startTime: startTime.toISOString().replace("T", " ").slice(0, 19),
              endTime: endTime.toISOString().replace("T", " ").slice(0, 19),
            },
            accessToken,
          );

          // Group by payment_id (one order per payment)
          const byPayment = new Map<number, typeof items>();
          for (const item of items) {
            const list = byPayment.get(item.payment_id) ?? [];
            list.push(item);
            byPayment.set(item.payment_id, list);
          }

          for (const [paymentId, orderItems] of Array.from(byPayment.entries())) {
            const first = orderItems[0];
            if (!first) continue;

            // Bandcamp repeats shipping on each line; take max (same dollars on every row).
            const shippingPaid = Math.max(0, ...orderItems.map((i) => Number(i.shipping) || 0));

            const lineItems = orderItems.map((i: BandcampOrderItem) => ({
              sku: i.sku,
              title: i.item_name,
              quantity: i.quantity ?? 1,
              price: i.sub_total,
              shipping: i.shipping ?? 0,
            }));

            // B-1 per-order idempotency: keyed on Bandcamp `payment_id` (a
            // stable BC-issued identifier), NEVER on a timestamp. Combined
            // with the unique index on (workspace_id, bandcamp_payment_id)
            // this prevents duplicate `warehouse_orders` inserts even if the
            // 30-day BC `getOrders` window overlaps a prior sync run. The
            // logical idempotency key for forensic logging is
            // `bandcamp:order-sync:${conn.band_id}:${paymentId}`.
            const { data: existing } = await supabase
              .from("warehouse_orders")
              .select("id, shipping_cost")
              .eq("workspace_id", workspaceId)
              .eq("bandcamp_payment_id", paymentId)
              .maybeSingle();

            if (existing) {
              const needsShipping =
                (existing.shipping_cost == null || Number(existing.shipping_cost) === 0) &&
                shippingPaid > 0;
              if (needsShipping) {
                const { error: repairErr } = await supabase
                  .from("warehouse_orders")
                  .update({
                    shipping_cost: shippingPaid,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", existing.id);
                if (repairErr) {
                  logger.warn("Bandcamp shipping_cost repair failed", {
                    paymentId,
                    error: repairErr.message,
                  });
                }
              }
              continue;
            }

            // Derive org_id from the SKUs in this order rather than using conn.org_id
            // (all bandcamp_connections use Clandestine Distribution's org_id, not the
            // individual label's org). Look up the first SKU that resolves to a product org.
            const skus = orderItems.map((i) => i.sku).filter((s): s is string => !!s);
            let resolvedOrgId: string = conn.org_id;
            if (skus.length > 0) {
              const { data: variants } = await supabase
                .from("warehouse_product_variants")
                .select("sku, warehouse_products!inner(org_id)")
                .eq("workspace_id", workspaceId)
                .in("sku", skus)
                .limit(1);
              const firstVariant = variants?.[0];
              if (firstVariant) {
                const product = firstVariant.warehouse_products as unknown as { org_id: string };
                if (product.org_id) resolvedOrgId = product.org_id;
              }
            }

            const { error } = await supabase.from("warehouse_orders").insert({
              workspace_id: workspaceId,
              org_id: resolvedOrgId,
              bandcamp_payment_id: paymentId,
              order_number: `BC-${paymentId}`,
              customer_name: first.buyer_name,
              customer_email: first.buyer_email,
              // Phase 0.4: respect BC payment_state instead of assuming "paid".
              // Unpaid/failed BC orders should NOT auto-flow into fulfillment.
              financial_status: mapBandcampPaymentState(first.payment_state),
              fulfillment_status: first.ship_date ? "fulfilled" : "unfulfilled",
              total_price: first.order_total ?? 0,
              currency: first.currency ?? "USD",
              shipping_cost: shippingPaid > 0 ? shippingPaid : null,
              line_items: lineItems,
              shipping_address: first.ship_to_name
                ? {
                    name: first.ship_to_name,
                    street1: first.ship_to_street,
                    street2: first.ship_to_street_2,
                    city: first.ship_to_city,
                    state: first.ship_to_state,
                    postalCode: first.ship_to_zip,
                    country: first.ship_to_country,
                    countryCode: first.ship_to_country_code,
                  }
                : null,
              source: "bandcamp",
              synced_at: new Date().toISOString(),
            });

            if (error) {
              logger.warn("Bandcamp order insert failed", {
                paymentId,
                error: error.message,
              });
              continue;
            }

            totalCreated++;
          }

          // Batch-backfill bandcamp_product_mappings.bandcamp_url from item_url.
          // Orders API returns verified album URLs — higher confidence than constructed slugs.
          // Covers only recently-sold products (30-day window); URL construction in
          // bandcamp-sync.ts covers the full catalog.
          // Never overwrites existing non-null URLs (confidence guard).
          const skuUrlPairs = items
            .filter((i) => i.item_url && i.sku)
            .map((i) => ({ sku: i.sku as string, url: i.item_url as string }));

          if (skuUrlPairs.length > 0) {
            const { data: variants } = await supabase
              .from("warehouse_product_variants")
              .select("id, sku")
              .eq("workspace_id", workspaceId)
              .in(
                "sku",
                skuUrlPairs.map((p) => p.sku),
              );

            const skuToVariantId = new Map((variants ?? []).map((v) => [v.sku, v.id]));

            for (const { sku, url } of skuUrlPairs) {
              const variantId = skuToVariantId.get(sku);
              if (!variantId) continue;

              await supabase
                .from("bandcamp_product_mappings")
                .update({
                  bandcamp_url: url,
                  bandcamp_url_source: "orders_api",
                  updated_at: new Date().toISOString(),
                })
                .eq("variant_id", variantId)
                .is("bandcamp_url", null);
            }

            logger.info("Backfilled bandcamp_url from order item_urls", {
              workspaceId,
              connectionBandId: conn.band_id,
              skuCount: skuUrlPairs.length,
            });
          }
        } catch (err) {
          logger.error("Bandcamp order sync failed", {
            connectionId: conn?.id,
            bandId: conn?.band_id,
            error: String(err),
          });
        }
      }
    }

    return { totalCreated };
  },
});

/**
 * B-1 (HRD-29) — Cron flapping detection helper.
 *
 * When the schedule fires, we hand `bandcampOrderSyncTask.trigger()` a stable
 * global idempotency key with a 15-minute TTL (matching the cron cadence). If
 * an in-flight `bandcamp-order-sync` run already exists for that key,
 * Trigger.dev returns the SAME run handle id instead of spawning a duplicate.
 *
 * To detect flapping (which would mask real failures behind silent dedups),
 * we compare the freshly returned handle id against the id we recorded on the
 * previous schedule tick. Equal id == dedup happened == previous tick is still
 * in flight beyond the cron interval.
 *
 * Returned action drives a single `logger.warn` + `sensor_readings` row in the
 * caller. Pure function so it stays trivially testable.
 *
 * Exported for unit testing.
 */
export type ScheduleAction =
  | { kind: "fresh_trigger"; runId: string }
  | { kind: "deduped"; runId: string; reason: "overlapping_run" };

export function decideScheduleAction(
  previousRunId: string | null,
  currentRunId: string,
): ScheduleAction {
  if (previousRunId !== null && previousRunId === currentRunId) {
    return { kind: "deduped", runId: currentRunId, reason: "overlapping_run" };
  }
  return { kind: "fresh_trigger", runId: currentRunId };
}

// Module-scope memo of the last triggered run id. Trigger.dev keeps a schedule
// task warm across many ticks on the same worker, so this is a reliable signal
// in steady state. After a redeploy / cold start the first tick reads null and
// any dedup that round is silently ignored — acceptable, since the very next
// tick recovers detection.
let _lastTriggeredRunId: string | null = null;

// Test-only seam — never call from production code.
export function _resetLastTriggeredRunIdForTests(): void {
  _lastTriggeredRunId = null;
}

export const bandcampOrderSyncSchedule = schedules.task({
  id: "bandcamp-order-sync-cron",
  // B-1: Tightened from `0 */6 * * *` (every 6h, ShipStation-truth era) to
  // `*/15 * * * *` (every 15m). Direct-Shopify cutover removed ShipStation as
  // the truth source for Bandcamp order timing, so we need fresh BC order data
  // closer to real time.
  //
  // Cadence budget: ~120 requests/run × 96 runs/day × N workspaces.
  // Bandcamp's observed soft limit is ~20 req/min per token family.
  // At N=10 workspaces this is ~200 req/min concentrated in the cron tick.
  // If we add 5+ more bands, revisit cadence (consider */30 or per-workspace
  // stagger).
  cron: "*/15 * * * *",
  queue: bandcampQueue,
  run: async () => {
    // B-1: GLOBAL-scope idempotency key with TTL matching the cron interval.
    // If the previous tick's `bandcampOrderSyncTask` run is still in flight
    // when the next tick fires, Trigger.dev returns the same run handle id
    // instead of stacking a duplicate on `bandcampQueue` (concurrencyLimit:1
    // would serialize anyway — this just prevents queue depth growth).
    const key = await idempotencyKeys.create("bandcamp-order-sync-cron", {
      scope: "global",
    });

    const handle = await bandcampOrderSyncTask.trigger(
      {},
      { idempotencyKey: key, idempotencyKeyTTL: "15m" },
    );

    const action = decideScheduleAction(_lastTriggeredRunId, handle.id);
    _lastTriggeredRunId = handle.id;

    if (action.kind === "deduped") {
      logger.warn("bandcamp-order-sync-cron: tick deduped to in-flight run", {
        triggered_run_id: handle.id,
        reason: action.reason,
        idempotency_key: key,
      });

      // Emit one sensor_readings row per active workspace so the Channels
      // page health sensor can surface flapping. workspace_id is NOT NULL on
      // sensor_readings, so we fan out across active workspaces (cheap insert).
      try {
        const supabase = createServiceRoleClient();
        const workspaceIds = await getAllWorkspaceIds(supabase);
        if (workspaceIds.length > 0) {
          const nowIso = new Date().toISOString();
          await supabase.from("sensor_readings").insert(
            workspaceIds.map((workspace_id) => ({
              workspace_id,
              sensor_name: "bandcamp.cron_idem_skip",
              status: "warning",
              message: `bandcamp-order-sync schedule tick deduped to in-flight run ${handle.id}`,
              value: {
                reason: action.reason,
                last_run_id: handle.id,
                this_attempt_at: nowIso,
              },
            })),
          );
        }
      } catch (err) {
        logger.error("bandcamp-order-sync-cron: failed to emit skip telemetry", {
          error: String(err),
        });
      }
    }

    return { ok: true, dedup_action: action.kind, run_id: handle.id };
  },
});
