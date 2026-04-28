/**
 * Process client store webhook — event trigger.
 *
 * Heavy processing happens here, not in the Route Handler (Rule #66).
 * Rule #65: Echo cancellation for inventory updates.
 * Rule #7: Uses createServiceRoleClient().
 */

import { task, tasks } from "@trigger.dev/sdk";
import { triggerBundleFanout } from "@/lib/server/bundles";
import { shouldFanoutToConnection } from "@/lib/server/client-store-fanout-gate";
import { commitOrderItems, releaseOrderItems } from "@/lib/server/inventory-commitments";
import {
  type IngressSensorWarning,
  runHoldIngressSafely,
  type SafeIngressVerdict,
} from "@/lib/server/order-hold-ingress";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import type { StockSignal } from "@/lib/server/stock-reliability";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  checkMonotonicGuard,
  extractEventContext,
  markStaleDropped,
  stashEntityIdOnCurrentRow,
  writeLastSeenAt,
} from "@/lib/server/webhook-monotonic-guard";
import {
  type RehydrateSupabaseClient,
  rehydrateWebhookInventoryUpdate,
} from "@/lib/server/webhook-rehydrate";
import type { ClientStoreConnection } from "@/lib/shared/types";

export const processClientStoreWebhookTask = task({
  id: "process-client-store-webhook",
  maxDuration: 60,
  run: async (payload: { webhookEventId: string }) => {
    const supabase = createServiceRoleClient();

    // Fetch the webhook event
    const { data: event } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("id", payload.webhookEventId)
      .single();

    if (!event) throw new Error(`Webhook event ${payload.webhookEventId} not found`);

    const metadata = event.metadata as Record<string, unknown>;
    const webhookData = metadata.payload as Record<string, unknown> | undefined;
    if (!webhookData) return { processed: false, reason: "no_payload" };

    const topic = event.topic ?? "";

    // Determine connection for echo cancellation check
    const connectionId = metadata.connection_id as string | undefined;

    // Phase 0.8 — single dormancy gate. A webhook arriving from a dormant
    // connection is logged-and-dropped: we never write inventory or orders on
    // its behalf. The webhook_event row is marked `dormant_skipped` so we
    // retain the audit trail (useful for proving a webhook URL is alive even
    // while we're not acting on it).
    if (connectionId) {
      const { data: connection } = await supabase
        .from("client_store_connections")
        .select("*")
        .eq("id", connectionId)
        .maybeSingle();

      if (connection) {
        const decision = shouldFanoutToConnection(connection as ClientStoreConnection);
        if (!decision.allow) {
          await supabase
            .from("webhook_events")
            .update({ status: "dormant_skipped" })
            .eq("id", payload.webhookEventId);
          return { processed: false, reason: "dormant_connection", denial: decision.reason };
        }
      }
    }

    // HRD-01: monotonic timestamp guard — drop out-of-order deliveries before
    // any side effect. Skipped (fail-open) when the topic / payload doesn't
    // give us an entity id or timestamp to compare against; the audit row's
    // `metadata.stale_dropped` block records the verdict either way.
    const platform = (event.platform as string) ?? "unknown";
    const eventContext = extractEventContext(platform, topic, webhookData, {
      triggeredAt: (metadata.triggered_at as string | undefined) ?? null,
    });

    if (connectionId && eventContext.entityId) {
      await stashEntityIdOnCurrentRow(
        supabase,
        payload.webhookEventId,
        metadata,
        eventContext.entityId,
      );

      const guard = await checkMonotonicGuard(supabase, {
        currentEventId: payload.webhookEventId,
        platform,
        topic,
        connectionId,
        context: eventContext,
      });

      if (guard.stale) {
        await markStaleDropped(supabase, payload.webhookEventId, metadata, guard);
        return {
          processed: false,
          reason: "stale_dropped",
          entityId: guard.entityId,
          priorTimestamp: guard.priorTimestamp,
          currentTimestamp: guard.currentTimestamp,
        };
      }
    }

    // Topic dispatch — order matters. `orders/cancelled` would also match
    // `topic.includes("order")`, so the cancel and refund branches MUST run
    // before the orders/create branch. `refunds/create` doesn't include
    // "order" in the topic string, but the explicit ordering keeps the
    // table easy to read.
    let result: Record<string, unknown>;
    if (topic.includes("refund")) {
      result = await handleRefund(supabase, event, webhookData, connectionId);
    } else if (topic.includes("cancel")) {
      result = await handleOrderCancelled(supabase, event, webhookData, connectionId);
    } else if (
      topic.includes("inventory") ||
      topic.includes("stock") ||
      (platform === "woocommerce" &&
        topic.includes("product") &&
        typeof webhookData.stock_quantity === "number")
    ) {
      result = await handleInventoryUpdate(supabase, event, webhookData, connectionId);
    } else if (topic.includes("order")) {
      result = await handleOrderCreated(supabase, event, webhookData, connectionId);
    } else {
      return { processed: false, reason: "unknown_topic", topic };
    }

    // HRD-01: stamp last_seen_at on success so the next delivery for the
    // same entity has a comparison anchor. Skipped when the event didn't
    // carry a timestamp (fail-open path above).
    if (
      eventContext.entityId &&
      eventContext.eventTimestamp &&
      (result.processed === true || result.reason === "echo_cancelled")
    ) {
      await writeLastSeenAt(supabase, payload.webhookEventId, eventContext.eventTimestamp);
    }

    // B-3 / HRD-14 — Channels webhook health card. Stamp `last_webhook_at`
    // and bump the per-topic counter inside `webhook_topic_health` whenever
    // we successfully complete a delivery (processed OR echo_cancelled).
    // Both columns were added in `20260423000002_finish_plan_columns.sql`.
    // Failures intentionally do NOT stamp the freshness clock — a connection
    // that's only emitting handler errors is unhealthy by definition.
    if (connectionId && (result.processed === true || result.reason === "echo_cancelled")) {
      try {
        const nowIso = new Date().toISOString();
        // Read-modify-write of the JSONB topic counter. Race acceptable here:
        // worst case we lose a counter increment under concurrency, but
        // `last_webhook_at` is the authoritative freshness clock for the UI
        // badge — counters are diagnostic only.
        const { data: row } = await supabase
          .from("client_store_connections")
          .select("webhook_topic_health")
          .eq("id", connectionId)
          .maybeSingle();

        const existing = (row?.webhook_topic_health ?? {}) as Record<
          string,
          { last_at: string; count: number }
        >;
        const prior = existing[topic] ?? { last_at: nowIso, count: 0 };
        existing[topic] = { last_at: nowIso, count: prior.count + 1 };

        await supabase
          .from("client_store_connections")
          .update({ last_webhook_at: nowIso, webhook_topic_health: existing })
          .eq("id", connectionId);
      } catch {
        // Health-card telemetry is best-effort; never fail the webhook for it.
      }
    }

    return result;
  },
});

/**
 * Inventory update handler — platform-aware.
 *
 * Shopify `inventory_levels/update` payload (per Shopify Admin API webhook docs):
 *   { inventory_item_id, location_id, available, updated_at }
 * It does NOT carry a SKU. We resolve to our SKU via
 * `client_store_sku_mappings.remote_inventory_item_id` (HRD-03 column,
 * populated by `autoDiscoverShopifySkus`).
 *
 * WooCommerce / Squarespace `*_stock` payloads carry `sku` + `quantity`
 * directly — kept on the existing path so this rewrite is non-breaking.
 *
 * HRD-05: when the connection has a `default_location_id` set and the
 * webhook reports inventory at a different location, the row is persisted
 * as `wrong_location` and NOT applied. Operators can grep these rows to
 * spot multi-location merchants who picked the wrong default at install
 * time. Unset `default_location_id` falls through (today's behavior).
 *
 * Echo cancellation (Rule #65): same logic as before, just keyed by SKU
 * once it's resolved (regardless of whether the SKU came from the payload
 * or from the inventory_item_id mapping).
 */
async function handleInventoryUpdate(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const platform = (event.platform as string) ?? "";
  const eventId = event.id as string;
  const workspaceId = event.workspace_id as string;

  // ─── Phase 1 — extract SKU + new-quantity per platform shape ───
  let sku = "";
  let newQuantity: number | undefined;
  let resolvedFromInventoryItem = false;
  let inventoryItemIdString: string | null = null;

  if (platform === "shopify") {
    const inventoryItemId = data.inventory_item_id;
    const available = data.available;
    const locationId = data.location_id;

    if (inventoryItemId === undefined || inventoryItemId === null) {
      return { processed: false, reason: "missing_inventory_item_id" };
    }
    if (available === undefined || available === null || typeof available !== "number") {
      return { processed: false, reason: "missing_available" };
    }
    inventoryItemIdString = String(inventoryItemId);
    newQuantity = available;

    // HRD-05 wrong-location guard. We require the connection to be known —
    // an inventory webhook with no connection context can't be location-checked.
    if (!connectionId) {
      return { processed: false, reason: "missing_connection_id" };
    }

    const { data: connection } = await supabase
      .from("client_store_connections")
      .select("default_location_id")
      .eq("id", connectionId)
      .maybeSingle();

    const defaultLocationId = connection?.default_location_id ?? null;

    if (defaultLocationId && locationId !== undefined && locationId !== null) {
      const incomingLocationId = String(locationId);
      const expectedLocationId = String(defaultLocationId);
      if (incomingLocationId !== expectedLocationId) {
        await supabase
          .from("webhook_events")
          .update({ status: "wrong_location" })
          .eq("id", eventId);
        return {
          processed: false,
          reason: "wrong_location",
          inventory_item_id: inventoryItemIdString,
          incoming_location_id: incomingLocationId,
          expected_location_id: expectedLocationId,
        };
      }
    }

    // Resolve inventory_item_id → SKU via HRD-03 mapping column
    const { data: mappingRow } = await supabase
      .from("client_store_sku_mappings")
      .select("remote_sku, variant_id, last_pushed_quantity")
      .eq("connection_id", connectionId)
      .eq("remote_inventory_item_id", inventoryItemIdString)
      .maybeSingle();

    if (!mappingRow?.remote_sku) {
      // SKU mapping missing — we can't safely route this event via the
      // alias table. BEFORE routing to unknown-SKU discovery (the
      // `sku_mapping_missing` path), we try the demotion-rehydrate
      // flow (plan §"Post-demotion webhook ingress", SKU-AUTO-24):
      //   * If there is an ACTIVE identity row in
      //     `client_store_product_identity_matches` for this
      //     (connection, remote_inventory_item_id), and the row is in
      //     `client_stock_exception` with a credible positive stock
      //     signal + warehouse ATP + stability, re-promote it to a
      //     live alias and halt the webhook with
      //     `rehydrate_promoted_alias`.
      //   * For any other active identity row we bump evidence and
      //     halt (no inventory side-effect yet — the next webhook will
      //     find the rehydrated alias).
      //   * Only when NO identity row exists (or a DB error) do we
      //     fall through to the historical `sku_mapping_missing`
      //     return, which is what eventually spawns unknown-SKU
      //     discovery downstream.
      //
      // The orchestrator self-gates on workspace-emergency-pause; the
      // nested `promoteIdentityMatchToAlias()` wrapper self-gates on
      // `workspaces.flags.sku_live_alias_autonomy_enabled`. No flag
      // check is needed here.
      const nowIso = new Date().toISOString();
      const inboundStockSignal: StockSignal = {
        value: typeof available === "number" ? available : null,
        observedAt: nowIso,
        observedAtLocal: nowIso,
        source: "shopify_graphql",
        tier: "fresh_remote",
      };

      const rehydrateOutcome = await rehydrateWebhookInventoryUpdate(
        supabase as unknown as RehydrateSupabaseClient,
        {
          workspaceId,
          connectionId,
          platform: "shopify",
          inboundStockSignal,
          identityKeys: { remoteInventoryItemId: inventoryItemIdString },
          triggeredBy: `webhook:shopify:inventory_levels_update:${eventId}`,
          webhookEventId: eventId,
        },
      );

      switch (rehydrateOutcome.kind) {
        case "emergency_paused": {
          await supabase
            .from("webhook_events")
            .update({ status: "sku_autonomy_emergency_paused" })
            .eq("id", eventId);
          return {
            processed: false,
            reason: "sku_autonomy_emergency_paused",
            inventory_item_id: inventoryItemIdString,
          };
        }
        case "promoted": {
          await supabase
            .from("webhook_events")
            .update({ status: "rehydrate_promoted_alias" })
            .eq("id", eventId);
          return {
            processed: true,
            reason: "rehydrate_promoted_alias",
            inventory_item_id: inventoryItemIdString,
            alias_id: rehydrateOutcome.aliasId,
            identity_match_id: rehydrateOutcome.identityMatchId,
            decision_id: rehydrateOutcome.decisionId,
            run_id: rehydrateOutcome.runId,
          };
        }
        case "updated_evidence_only": {
          await supabase
            .from("webhook_events")
            .update({ status: "rehydrate_evidence_only" })
            .eq("id", eventId);
          return {
            processed: true,
            reason: "rehydrate_evidence_only",
            inventory_item_id: inventoryItemIdString,
            identity_match_id: rehydrateOutcome.identityMatchId,
            outcome_state: rehydrateOutcome.outcomeState,
            rationale: rehydrateOutcome.rationale,
          };
        }
        case "bumped_reobserved": {
          await supabase
            .from("webhook_events")
            .update({ status: "rehydrate_bumped_evidence" })
            .eq("id", eventId);
          return {
            processed: true,
            reason: "rehydrate_bumped_evidence",
            inventory_item_id: inventoryItemIdString,
            identity_match_id: rehydrateOutcome.identityMatchId,
            rationale: rehydrateOutcome.rationale,
          };
        }
        case "promotion_blocked": {
          await supabase
            .from("webhook_events")
            .update({ status: "rehydrate_promotion_blocked" })
            .eq("id", eventId);
          return {
            processed: false,
            reason: "rehydrate_promotion_blocked",
            inventory_item_id: inventoryItemIdString,
            identity_match_id: rehydrateOutcome.identityMatchId,
            promotion_reason: rehydrateOutcome.reason,
            promotion_detail: rehydrateOutcome.detail,
            run_id: rehydrateOutcome.runId,
          };
        }
        case "run_open_failed": {
          await supabase
            .from("webhook_events")
            .update({ status: "rehydrate_run_open_failed" })
            .eq("id", eventId);
          return {
            processed: false,
            reason: "rehydrate_run_open_failed",
            inventory_item_id: inventoryItemIdString,
            identity_match_id: rehydrateOutcome.identityMatchId,
            detail: rehydrateOutcome.detail,
          };
        }
        case "identity_lookup_failed": {
          // Fail-open: a transient Supabase read error on the
          // identity cascade MUST NOT block the webhook from
          // eventually reaching the discovery path. The existing
          // `sku_mapping_missing` status surfaces the miss; we add a
          // metadata breadcrumb so ops can audit the rehydrate miss.
          console.warn(
            "[rehydrate] identity_lookup_failed, falling through to sku_mapping_missing",
            { eventId, detail: rehydrateOutcome.detail },
          );
          break;
        }
        case "no_identity_row":
          // No identity row anywhere → this is a genuine brand-new
          // unknown remote listing. Fall through to the historical
          // sku_mapping_missing path below so downstream discovery
          // can handle it.
          break;
      }

      // Existing `sku_mapping_missing` path. Reached ONLY when:
      //   * rehydrate orchestrator returned `no_identity_row`, OR
      //   * rehydrate orchestrator returned `identity_lookup_failed`
      //     (fail-open).
      await supabase
        .from("webhook_events")
        .update({ status: "sku_mapping_missing" })
        .eq("id", eventId);
      return {
        processed: false,
        reason: "sku_mapping_missing",
        inventory_item_id: inventoryItemIdString,
      };
    }

    sku = mappingRow.remote_sku;
    resolvedFromInventoryItem = true;

    // Echo cancellation pulled into one branch — we already have the row.
    if (mappingRow.last_pushed_quantity === newQuantity) {
      await supabase.from("webhook_events").update({ status: "echo_cancelled" }).eq("id", eventId);
      return { processed: true, reason: "echo_cancelled", sku };
    }
  } else {
    // WooCommerce / Squarespace / unknown payload shape. Woo product stock
    // updates commonly emit `stock_quantity`; older inventory topics may emit
    // `quantity`.
    const payloadSku = (data.sku as string) ?? "";
    const payloadQuantity =
      typeof data.stock_quantity === "number"
        ? data.stock_quantity
        : typeof data.quantity === "number"
          ? data.quantity
          : undefined;
    if (!payloadSku || payloadQuantity === undefined) {
      return { processed: false, reason: "missing_sku_or_quantity" };
    }
    newQuantity = payloadQuantity;

    if (connectionId) {
      const { data: mapping } = await supabase
        .from("client_store_sku_mappings")
        .select(
          "last_pushed_quantity, variant_id, is_active, warehouse_product_variants!inner(sku)",
        )
        .eq("connection_id", connectionId)
        .eq("remote_sku", payloadSku)
        .maybeSingle();

      if (platform === "woocommerce" && (!mapping || mapping.is_active === false)) {
        const { data: connection } = await supabase
          .from("client_store_connections")
          .select("org_id")
          .eq("id", connectionId)
          .maybeSingle();
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: workspaceId,
            org_id: connection?.org_id ?? null,
            category: "woo_unmapped_stock_update",
            severity: "medium",
            title: `WooCommerce stock update skipped for unmapped SKU ${payloadSku}`,
            description:
              "Woo product stock webhook had a numeric stock_quantity, but no active client_store_sku_mappings row exists for this connection/SKU.",
            metadata: {
              connection_id: connectionId,
              remote_sku: payloadSku,
              stock_quantity: newQuantity,
              webhook_event_id: eventId,
              remote_product_id: data.id ?? data.product_id ?? null,
              remote_variation_id: data.variation_id ?? null,
            },
            status: "open",
            group_key: `woo-unmapped-stock:${connectionId}:${payloadSku}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
        await supabase
          .from("webhook_events")
          .update({ status: "sku_mapping_missing" })
          .eq("id", eventId);
        return { processed: false, reason: "no_active_mapping", sku: payloadSku };
      }

      if (mapping && mapping.last_pushed_quantity === newQuantity) {
        await supabase
          .from("webhook_events")
          .update({ status: "echo_cancelled" })
          .eq("id", eventId);
        return { processed: true, reason: "echo_cancelled", sku: payloadSku };
      }

      const warehouseSku = (
        mapping?.warehouse_product_variants as unknown as { sku: string } | null
      )?.sku;
      sku = platform === "woocommerce" && warehouseSku ? warehouseSku : payloadSku;
    } else {
      sku = payloadSku;
    }
  }

  // ─── Phase 2 — compute delta against current warehouse level ───
  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .maybeSingle();

  if (!level) return { processed: false, reason: "sku_not_found", sku };

  const delta = newQuantity - level.available;
  if (delta === 0) return { processed: true, reason: "no_change", sku };

  // ─── Phase 3 — single write path (Rule #20) ───
  const source: "shopify" | "woocommerce" | "squarespace" =
    platform === "shopify"
      ? "shopify"
      : platform === "woocommerce"
        ? "woocommerce"
        : platform === "squarespace"
          ? "squarespace"
          : "shopify";

  await recordInventoryChange({
    workspaceId,
    sku,
    delta,
    source,
    correlationId: `webhook:${platform}:${eventId}`,
    metadata: {
      webhook_event_id: eventId,
      platform,
      ...(resolvedFromInventoryItem && inventoryItemIdString
        ? { resolved_from_inventory_item_id: inventoryItemIdString }
        : {}),
    },
  });

  await supabase.from("webhook_events").update({ status: "processed" }).eq("id", eventId);

  return { processed: true, sku, delta };
}

/**
 * Best-effort persistence of the `runHoldIngressSafely` sensor warnings.
 *
 * The wrapper returns these as data (not a side-effect) so callers can
 * control the supabase client + workspace scope. Writing them here
 * keeps the per-site sensor taxonomy consistent with the pre-Phase-8
 * convention (one `sensor_readings` row per failure type). Errors are
 * swallowed — a `sensor_readings` write failure must never block order
 * ingestion (same policy as `inv.commit_ledger_write_failed`).
 */
async function persistIngressWarnings(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  warnings: ReadonlyArray<IngressSensorWarning>,
): Promise<void> {
  if (warnings.length === 0) return;
  try {
    await supabase.from("sensor_readings").insert(
      warnings.map((w) => ({
        workspace_id: workspaceId,
        sensor_name: w.sensor_name,
        status: w.status,
        message: w.message,
        value: w.value,
      })),
    );
  } catch (err) {
    console.error(
      "[process-client-store-webhook] sensor_readings insert (hold ingress) failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function wooOrGenericModifiedAt(data: Record<string, unknown>): string {
  if (typeof data.date_modified_gmt === "string") return `${data.date_modified_gmt}Z`;
  if (typeof data.updated_at === "string") return data.updated_at;
  if (typeof data.date_modified === "string") return data.date_modified;
  if (typeof data.modifiedOn === "string") return data.modifiedOn;
  if (typeof data.created_at === "string") return data.created_at;
  return new Date().toISOString();
}

function shouldReconcileRemoteOrder(
  existingModifiedAt: string | null | undefined,
  incomingModifiedAt: string,
): boolean {
  if (!existingModifiedAt) return true;
  const existingMs = new Date(existingModifiedAt).getTime();
  const incomingMs = new Date(incomingModifiedAt).getTime();
  if (Number.isNaN(incomingMs)) return false;
  return Number.isNaN(existingMs) || incomingMs > existingMs;
}

async function handleOrderCreated(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const workspaceId = event.workspace_id as string;
  const platform = event.platform as string;
  const remoteOrderId = String(data.id ?? data.order_id ?? "");
  const externalOrderModifiedAt = wooOrGenericModifiedAt(data);
  const ingestionIdempotencyKey =
    connectionId && remoteOrderId
      ? `${platform}:${connectionId}:${remoteOrderId}`
      : remoteOrderId
        ? `${platform}:unknown:${remoteOrderId}`
        : null;
  const lineItems = (data.line_items as Array<Record<string, unknown>>) ?? [];

  // Check for duplicate
  const { data: existing } = ingestionIdempotencyKey
    ? await supabase
        .from("warehouse_orders")
        .select("id, external_order_modified_at")
        .eq("workspace_id", workspaceId)
        .eq("ingestion_idempotency_key", ingestionIdempotencyKey)
        .maybeSingle()
    : await supabase
        .from("warehouse_orders")
        .select("id, external_order_modified_at")
        .eq("workspace_id", workspaceId)
        .eq("external_order_id", remoteOrderId)
        .maybeSingle();

  if (existing) {
    if (
      shouldReconcileRemoteOrder(
        existing.external_order_modified_at as string | null,
        externalOrderModifiedAt,
      )
    ) {
      await supabase
        .from("warehouse_orders")
        .update({
          order_number:
            (data.number as string) ??
            (data.order_number as string) ??
            (data.name as string) ??
            null,
          line_items: lineItems,
          external_order_modified_at: externalOrderModifiedAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    }
    return { processed: true, reason: "duplicate_order", orderId: existing.id };
  }

  // Get org from connection
  let orgId: string | null = null;
  if (connectionId) {
    const { data: conn } = await supabase
      .from("client_store_connections")
      .select("org_id")
      .eq("id", connectionId)
      .single();
    orgId = conn?.org_id ?? null;
  }

  if (!orgId) return { processed: false, reason: "no_org_id" };

  const { data: newOrder, error: insertError } = await supabase
    .from("warehouse_orders")
    .insert({
      workspace_id: workspaceId,
      org_id: orgId,
      external_order_id: remoteOrderId,
      ingestion_idempotency_key: ingestionIdempotencyKey,
      external_order_modified_at: externalOrderModifiedAt,
      order_number:
        (data.number as string) ?? (data.order_number as string) ?? (data.name as string) ?? null,
      source: platform,
      line_items: lineItems,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError?.code === "23505") {
    return { processed: true, reason: "duplicate_order_race" };
  }
  if (insertError) throw insertError;

  if (newOrder && lineItems.length > 0) {
    const items = lineItems.map((li) => {
      const qty = (li.quantity as number) ?? 1;
      // F-1 / HRD-08.1: capture per-line fulfilled-at-create state so the
      // cancel handler can compute remaining-unfulfilled units to recredit.
      // Shopify shape: line_items[].fulfillment_status is `'fulfilled'`,
      // `'partial'`, `null`, or absent. We only treat the explicit
      // `'fulfilled'` value as "this whole line is shipped" — `'partial'` is
      // rare on orders/create (Shopify rarely emits partial state at order-
      // create time) and is treated conservatively as 0 fulfilled so the
      // cancel handler recredits the full quantity. The corner case is
      // observable in the cancel telemetry row's `db_webhook_disagree` flag
      // and would surface in the megaplan spot-check artifact.
      const isFulfilled = li.fulfillment_status === "fulfilled";
      return {
        order_id: newOrder.id,
        workspace_id: workspaceId,
        sku: (li.sku as string) ?? "",
        quantity: qty,
        fulfilled_quantity: isFulfilled ? qty : 0,
        // Persist the platform line-item id so the refund + cancel handlers
        // can resolve back to the right warehouse_order_items row.
        shopify_line_item_id: li.id !== undefined && li.id !== null ? String(li.id) : null,
      };
    });
    await supabase.from("warehouse_order_items").insert(items);

    // Phase 8 (SKU-AUTO-3 + SKU-AUTO-21) — consult the shared hold
    // substrate.
    //
    // `runHoldIngressSafely` is the SAME function the poll-path
    // (`client-store-order-detect`) calls on the SAME (workspaceId,
    // orderId). That shared call is what makes the SKU-AUTO-3 parity
    // guarantee ("webhook + poll produce identical HoldDecision")
    // hold BY CONSTRUCTION — if the same loader/evaluator/RPC wrapper
    // is invoked with the same DB state, the verdict is identical.
    //
    // Fail-open policy (everywhere): when the wrapper returns
    // `verdict:"legacy"` (flag off, emergency pause, workspace read
    // error, loader error, evaluator error, apply error, or thrown
    // exception), we fall through to the pre-Phase-8 unconditional-
    // decrement path. A hold-evaluation bug MUST NOT block order
    // ingestion — we'd rather ship something than hang the order.
    // Structured warnings are persisted as `sensor_readings` rows so
    // the rollout page surfaces hold-ingress failure rates.
    const holdIngress = await runHoldIngressSafely(supabase, {
      workspaceId,
      orderId: newOrder.id,
      source: "webhook",
      platform,
    });
    await persistIngressWarnings(supabase, workspaceId, holdIngress.warnings);
    const holdVerdict: SafeIngressVerdict = holdIngress.verdict;
    const skipLegacyCommitLedger = holdVerdict.kind === "hold_applied";

    if (!skipLegacyCommitLedger) {
      // Phase 5 §9.6 D1.b — open one inventory_commitments row per
      // (workspace_id, source='order', source_id=newOrder.id, sku).
      // The push formula `MAX(0, available - committed - safety)`
      // ignores this column UNTIL `workspaces.atp_committed_active` is
      // flipped per workspace (default FALSE — see migration
      // 20260424000005). Until then this is an audit-only ledger:
      // visible in the recon task + the megaplan spot-check, no
      // production behavior change.
      //
      // Idempotency: commitOrderItems uses ON CONFLICT DO NOTHING on
      // the partial unique index (workspace_id, source, source_id, sku)
      // WHERE released_at IS NULL, so retried Shopify deliveries (up to
      // ~24 retries over 48h per the Shopify webhook contract) cannot
      // double-commit.
      //
      // Failure isolation: ledger insert errors must NEVER fail the
      // order ingestion. Inventory has already decremented via
      // recordInventoryChange above; a missing audit row will surface
      // in the daily counter↔ledger recon task as drift but will not
      // delay the order. Wrapped in try/catch + sensor row.
      //
      // Phase 8 SKIP: when `holdVerdict.kind === "hold_applied"`, the
      // `apply_order_fulfillment_hold` RPC already wrote
      // `inventory_commitments` rows for the committable-warehouse
      // lines in the SAME ACID transaction as the hold stamp (Rule #64,
      // SKU-AUTO-21). Calling commitOrderItems again would be
      // idempotent (ON CONFLICT DO NOTHING) but wasteful, and also
      // attempts to commit HELD lines — which must stay uncommitted
      // until the hold is released.
      try {
        const commitItems = items.map((it) => ({ sku: it.sku, qty: it.quantity }));
        const commitResult = await commitOrderItems({
          workspaceId,
          orderId: newOrder.id,
          items: commitItems,
          metadata: {
            platform,
            connection_id: connectionId ?? null,
            remote_order_id: remoteOrderId,
            webhook_event_id: event.id,
          },
        });
        if (commitResult.alreadyOpen.length > 0) {
          console.info(
            `[process-client-store-webhook] commitOrderItems: ${commitResult.inserted} new, ${commitResult.alreadyOpen.length} already-open (retry)`,
          );
        }
      } catch (commitErr) {
        const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
        console.error("[process-client-store-webhook] commitOrderItems failed:", msg);
        await supabase.from("sensor_readings").insert({
          workspace_id: workspaceId,
          sensor_name: "inv.commit_ledger_write_failed",
          status: "warning",
          message: `commitOrderItems failed for order ${newOrder.id}: ${msg.slice(0, 200)}`,
          value: { order_id: newOrder.id, platform, error: msg },
        });
      }
    }

    // Phase 8 — enqueue the client-alert task when a hold was applied
    // AND the evaluator says the client should know. The task itself
    // self-gates on emergency pause, `non_warehouse_order_client_alerts_enabled`
    // (Phase 5 flag), cycle-id freshness, per-cycle idempotency
    // (DB partial unique index), AND bulk suppression (SKU-AUTO-31) —
    // so there's deliberately no second gate at this enqueue site.
    // Unconditional enqueue keeps the ingress path simple; the task
    // owns the "should this really send?" policy, which means one
    // change to the alert rules changes both paths at once.
    if (holdVerdict.kind === "hold_applied" && holdVerdict.clientAlertRequired) {
      try {
        await tasks.trigger("send-non-warehouse-order-hold-alert", {
          orderId: newOrder.id,
          holdCycleId: holdVerdict.cycleId,
        });
      } catch (alertErr) {
        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error(
          "[process-client-store-webhook] send-non-warehouse-order-hold-alert enqueue failed:",
          msg,
        );
        await supabase.from("sensor_readings").insert({
          workspace_id: workspaceId,
          sensor_name: "hold_ingress.alert_enqueue_failed",
          status: "warning",
          message: `send-non-warehouse-order-hold-alert enqueue failed for order ${newOrder.id}: ${msg.slice(0, 200)}`,
          value: {
            order_id: newOrder.id,
            hold_cycle_id: holdVerdict.cycleId,
            platform,
            source: "webhook",
            error: msg,
          },
        });
      }
    }

    // Decrement warehouse inventory for each line item.
    // This loop is NOT atomic — partial failures are recorded in warehouse_review_queue.
    // floor_violation (medium) = expected stock-short; system_fault (high) = needs investigation.
    // (F-11: `platform` is already in scope from the outer order-create block; the
    // duplicate `const platform = event.platform as string;` shadow at this point
    // was removed in the audit cleanup pass.)
    //
    // Phase 8 (SKU-AUTO-21): when a hold was applied, `committableFilter`
    // is the set of remote SKUs that ARE warehouse-committable. Lines NOT
    // in this set are HELD — they must stay at full stock until the hold
    // is released, so we record them with `status="held"` and skip the
    // `recordInventoryChange` call. `inventory_commitments` for the
    // committable lines were already written by `apply_order_fulfillment_hold`
    // in the same ACID transaction as the hold stamp (Rule #64 + #20).
    const committableFilter: ReadonlySet<string> | null =
      holdVerdict.kind === "hold_applied" ? holdVerdict.committableRemoteSkus : null;
    const bundleCache = new Map<string, boolean>();
    const decrementResults: {
      sku: string;
      delta: number;
      status: "ok" | "floor_violation" | "not_mapped" | "error" | "held";
      reason?: string;
    }[] = [];

    for (let index = 0; index < lineItems.length; index++) {
      const li = lineItems[index];
      const remoteSku = (li.sku as string) ?? "";
      if (!remoteSku) continue;

      if (committableFilter !== null && !committableFilter.has(remoteSku)) {
        decrementResults.push({
          sku: remoteSku,
          delta: 0,
          status: "held",
          reason:
            holdVerdict.kind === "hold_applied" ? holdVerdict.holdReason : "non_warehouse_hold",
        });
        continue;
      }

      // Resolve warehouse SKU via mapping (remote SKU may differ from warehouse SKU)
      const { data: mapping } = await supabase
        .from("client_store_sku_mappings")
        .select("variant_id, warehouse_product_variants!inner(sku)")
        .eq("connection_id", connectionId ?? "")
        .eq("remote_sku", remoteSku)
        .single();

      const warehouseSku = (
        mapping?.warehouse_product_variants as unknown as { sku: string } | null
      )?.sku;
      if (!warehouseSku) {
        decrementResults.push({ sku: remoteSku, delta: 0, status: "not_mapped" });
        continue;
      }

      const qty = (li.quantity as number) ?? 1;
      // Include line item ID or index to prevent correlation ID collision when
      // the same warehouse SKU appears in two separate line items of one order.
      const lineItemId = (li.id as string | undefined) ?? String(index);
      const result = await recordInventoryChange({
        workspaceId,
        sku: warehouseSku,
        delta: -qty,
        source: platform === "woocommerce" ? "woocommerce" : "shopify",
        correlationId: `store-order:${event.id}:${warehouseSku}:${lineItemId}`,
        metadata: {
          order_id: newOrder.id,
          remote_sku: remoteSku,
          connection_id: connectionId,
          line_item_id: lineItemId,
        },
      });

      if (result.success || result.alreadyProcessed) {
        decrementResults.push({ sku: warehouseSku, delta: -qty, status: "ok" });

        if (result.success && !result.alreadyProcessed && qty > 0 && mapping?.variant_id) {
          const fanout = await triggerBundleFanout({
            variantId: mapping.variant_id,
            soldQuantity: qty,
            workspaceId,
            correlationBase: `store-order:${event.id}:${warehouseSku}`,
            cache: bundleCache,
          });
          if (fanout.error) {
            console.error("[process-client-store-webhook] Bundle fanout failed:", fanout.error);
          }
        }
      } else if ((result as { reason?: string }).reason === "floor_violation") {
        decrementResults.push({
          sku: warehouseSku,
          delta: -qty,
          status: "floor_violation",
          reason: "insufficient_stock",
        });
      } else {
        decrementResults.push({
          sku: warehouseSku,
          delta: -qty,
          status: "error",
          reason: "system_fault",
        });
      }
    }

    // Record partial application to review queue if any line item failed.
    // `held` lines are expected (the hold substrate is the source of truth
    // for them) and `not_mapped` lines surface via their own channels, so
    // neither counts as a partial-apply failure.
    const failures = decrementResults.filter(
      (r) => r.status !== "ok" && r.status !== "not_mapped" && r.status !== "held",
    );
    if (failures.length > 0) {
      const hasSystemFault = failures.some((r) => r.status === "error");
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: workspaceId,
          org_id: orgId,
          category: "inventory_partial_apply",
          severity: hasSystemFault ? "high" : "medium",
          title: hasSystemFault
            ? `Order ${newOrder.id}: inventory write failed (system error)`
            : `Order ${newOrder.id}: inventory short on ${failures.length} SKU(s)`,
          description: failures
            .map((f) => `${f.sku}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`)
            .join("; "),
          metadata: { order_id: newOrder.id, decrement_results: decrementResults },
          status: "open",
          group_key: `inv_partial:${newOrder.id}`,
          occurrence_count: 1,
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );
    }

    // Trigger immediate push to all channels if any decrement succeeded
    if (decrementResults.some((r) => r.status === "ok")) {
      await Promise.allSettled([
        tasks.trigger("bandcamp-inventory-push", {}),
        tasks.trigger("multi-store-inventory-push", {}),
      ]).catch(() => {
        /* non-critical */
      });
    }
  }

  await supabase
    .from("webhook_events")
    .update({ status: "processed" })
    .eq("id", event.id as string);

  return { processed: true, orderId: newOrder?.id };
}

/**
 * Refund handler — Shopify `refunds/create`.
 *
 * Payload shape (per Shopify Admin API):
 *   {
 *     id, order_id, created_at, processed_at,
 *     refund_line_items: [
 *       { id, line_item_id, quantity, restock_type: 'return'|'no_restock'|'cancel', ... }
 *     ]
 *   }
 *
 * Polarity: ONLY `restock_type === 'return'` re-credits inventory. The other
 * two values are explicit signals that the merchant either chose not to
 * restock (`no_restock`) or already credited via the cancellation path
 * (`cancel`). HRD-07.2: empty refund_line_items array is a normal Shopify
 * shape (refund-without-restock — store credit only) and must NOT throw.
 *
 * Idempotency: each refund_line_item gets a stable correlation_id of
 * `refund:{event.id}:{refund_line_item.id}` so retries are no-ops at
 * `recordInventoryChange()` (the underlying RPC dedups on
 * `(sku, correlation_id)` per Rule #32).
 */
async function handleRefund(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const eventId = event.id as string;
  const workspaceId = event.workspace_id as string;
  const platform = (event.platform as string) ?? "shopify";

  const refundLineItems =
    (data.refund_line_items as Array<Record<string, unknown>> | undefined) ?? [];

  // HRD-07.2 — empty array is a valid Shopify shape, log+return rather than throw.
  if (refundLineItems.length === 0) {
    await supabase.from("webhook_events").update({ status: "processed" }).eq("id", eventId);
    return { processed: true, reason: "empty_refund_line_items", refund_id: data.id };
  }

  const remoteOrderId = (data.order_id as string | number | undefined) ?? null;
  let parentOrder: { id: string; org_id: string } | null = null;
  if (remoteOrderId !== null && remoteOrderId !== undefined) {
    const { data: orderRow } = await supabase
      .from("warehouse_orders")
      .select("id, org_id")
      .eq("workspace_id", workspaceId)
      .eq("external_order_id", String(remoteOrderId))
      .maybeSingle();
    parentOrder = orderRow ?? null;
  }

  const recreditResults: {
    refund_line_item_id: string | number | null;
    sku: string | null;
    quantity: number;
    status: "ok" | "skipped_no_restock" | "skipped_zero_quantity" | "sku_unresolved" | "error";
    reason?: string;
  }[] = [];

  for (const rli of refundLineItems) {
    const refundLineItemId = (rli.id as string | number | undefined) ?? null;
    const lineItemId = (rli.line_item_id as string | number | undefined) ?? null;
    const restockType = (rli.restock_type as string | undefined) ?? null;
    const quantity = (rli.quantity as number | undefined) ?? 0;

    if (restockType !== "return") {
      recreditResults.push({
        refund_line_item_id: refundLineItemId,
        sku: null,
        quantity,
        status: "skipped_no_restock",
        reason: restockType ?? "missing_restock_type",
      });
      continue;
    }

    if (quantity <= 0) {
      recreditResults.push({
        refund_line_item_id: refundLineItemId,
        sku: null,
        quantity,
        status: "skipped_zero_quantity",
      });
      continue;
    }

    // Resolve SKU — prefer the parent warehouse_order_items row keyed by
    // remote line_item_id (canonical). Falls back to nothing if the parent
    // order isn't ours (could be a refund for an order that landed before
    // the connection went active).
    let warehouseSku: string | null = null;

    if (parentOrder && lineItemId !== null) {
      const { data: orderItem } = await supabase
        .from("warehouse_order_items")
        .select("sku")
        .eq("order_id", parentOrder.id)
        .eq("shopify_line_item_id", String(lineItemId))
        .maybeSingle();
      if (orderItem?.sku) {
        warehouseSku = orderItem.sku;
      }
    }

    // Fallback — try by SKU passed inline on the refund_line_item (Shopify
    // includes the original SKU on most payload variants).
    if (!warehouseSku && rli.sku) {
      const remoteSku = String(rli.sku);
      if (connectionId) {
        const { data: mapping } = await supabase
          .from("client_store_sku_mappings")
          .select("variant_id, warehouse_product_variants!inner(sku)")
          .eq("connection_id", connectionId)
          .eq("remote_sku", remoteSku)
          .maybeSingle();
        const wpv = mapping?.warehouse_product_variants as unknown as { sku: string } | null;
        if (wpv?.sku) warehouseSku = wpv.sku;
      }
    }

    if (!warehouseSku) {
      recreditResults.push({
        refund_line_item_id: refundLineItemId,
        sku: null,
        quantity,
        status: "sku_unresolved",
        reason: "no_warehouse_order_item_or_mapping",
      });
      continue;
    }

    const correlationId = `refund:${eventId}:${refundLineItemId ?? lineItemId ?? "anon"}`;
    try {
      const result = await recordInventoryChange({
        workspaceId,
        sku: warehouseSku,
        delta: quantity,
        source: platform === "woocommerce" ? "woocommerce" : "shopify",
        correlationId,
        metadata: {
          webhook_event_id: eventId,
          platform,
          kind: "refund",
          refund_id: data.id,
          refund_line_item_id: refundLineItemId,
          remote_line_item_id: lineItemId,
          parent_order_id: parentOrder?.id ?? null,
        },
      });
      recreditResults.push({
        refund_line_item_id: refundLineItemId,
        sku: warehouseSku,
        quantity,
        status: result.success || result.alreadyProcessed ? "ok" : "error",
      });
    } catch (err) {
      recreditResults.push({
        refund_line_item_id: refundLineItemId,
        sku: warehouseSku,
        quantity,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Surface any unresolved or errored rows to the review queue so staff can
  // reconcile manually. Rule #55 — actionable, deduplicated by group_key.
  const failures = recreditResults.filter(
    (r) => r.status === "sku_unresolved" || r.status === "error",
  );
  if (failures.length > 0 && parentOrder) {
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        org_id: parentOrder.org_id,
        category: "refund_partial_apply",
        severity: failures.some((f) => f.status === "error") ? "high" : "medium",
        title: `Refund ${data.id}: ${failures.length} line item(s) need manual review`,
        description: failures
          .map(
            (f) =>
              `rli=${f.refund_line_item_id ?? "?"} sku=${f.sku ?? "?"} qty=${f.quantity} ${f.status}${f.reason ? ` (${f.reason})` : ""}`,
          )
          .join("; "),
        metadata: {
          refund_id: data.id,
          parent_order_id: parentOrder.id,
          recredit_results: recreditResults,
        },
        status: "open",
        group_key: `refund_partial:${eventId}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
  }

  // Trigger downstream push so cleared inventory is reflected on every
  // channel — same pattern as orders/create.
  if (recreditResults.some((r) => r.status === "ok")) {
    await Promise.allSettled([
      tasks.trigger("bandcamp-inventory-push", {}),
      tasks.trigger("multi-store-inventory-push", {}),
    ]).catch(() => {
      /* non-critical */
    });
  }

  await supabase.from("webhook_events").update({ status: "processed" }).eq("id", eventId);

  return {
    processed: true,
    refund_id: data.id,
    parent_order_id: parentOrder?.id ?? null,
    recredits: recreditResults,
  };
}

/**
 * Order-cancelled handler — Shopify `orders/cancelled`.
 *
 * Payload shape (per Shopify Admin API):
 *   { id, cancelled_at, cancel_reason, line_items: [{ id, fulfillment_status, ...}] }
 *
 * Re-credits the inventory the original `orders/create` decremented MINUS
 * any units that were already fulfilled before the cancel arrived (HRD-08.1
 * partial-cancel case). Uses the SAME line-item-id-keyed correlation-ID
 * base as `handleOrderCreated`, but with a `cancel:` prefix so the
 * underlying `(sku, correlation_id)` UNIQUE constraint dedups retries
 * without colliding with the original decrement.
 *
 * F-1 / HRD-08.1 contract:
 *   - DB is source of truth for fulfilled_quantity (set by handleOrderCreated
 *     and — once HRD-28 ships GraphQL fulfillmentCreate — by mark-platform-
 *     fulfilled). On disagreement with the cancel webhook payload, DB wins.
 *   - For every line where fulfilled_quantity > 0, we emit a separate
 *     `webhook_events` row with `status='cancel_after_fulfillment_partial'`
 *     for forensics. Stable external_webhook_id makes that insert idempotent
 *     across cancel retries.
 *   - Lines with remaining = 0 (fully fulfilled) are recorded in the result
 *     as `skipped_already_fulfilled` and contribute zero inventory delta.
 *
 * Idempotency strategy: the warehouse_orders row's fulfillment_status is
 * flipped to 'cancelled' once. Re-deliveries find the existing 'cancelled'
 * row and short-circuit with `reason='already_cancelled'`. The recredit
 * loop is itself idempotent thanks to recordInventoryChange's correlation
 * ID dedup, so even a retried cancel that races past the status check
 * results in zero double-credits.
 */
async function handleOrderCancelled(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  _connectionId: string | undefined,
) {
  const eventId = event.id as string;
  const workspaceId = event.workspace_id as string;
  const platform = (event.platform as string) ?? "shopify";

  const remoteOrderId = (data.id as string | number | undefined) ?? null;
  if (remoteOrderId === null || remoteOrderId === undefined) {
    return { processed: false, reason: "missing_order_id" };
  }

  const { data: order } = await supabase
    .from("warehouse_orders")
    .select("id, org_id, fulfillment_status")
    .eq("workspace_id", workspaceId)
    .eq("external_order_id", String(remoteOrderId))
    .maybeSingle();

  if (!order) {
    // The cancel arrived for an order we never ingested. Common cases:
    // (a) order was created BEFORE the connection went active, (b) the
    // orders/create webhook is in the recovery sweeper queue and hasn't
    // landed yet. Return without error so the row is marked processed.
    await supabase.from("webhook_events").update({ status: "processed" }).eq("id", eventId);
    return { processed: true, reason: "order_not_found", remote_order_id: remoteOrderId };
  }

  if (order.fulfillment_status === "cancelled") {
    return { processed: true, reason: "already_cancelled", orderId: order.id };
  }

  // Re-credit each warehouse_order_items row. The correlation-ID prefix
  // keeps the recredit distinct from the original decrement so retries
  // don't collide.
  const { data: items } = await supabase
    .from("warehouse_order_items")
    .select("id, sku, quantity, fulfilled_quantity, shopify_line_item_id")
    .eq("order_id", order.id);

  // F-1: build a lookup of webhook line_items by id so we can cross-check the
  // DB-side fulfilled_quantity against the webhook's fulfillment_status. The
  // DB always wins on conflict (most recent ground truth from our own
  // fulfillment writes); the webhook's hint is used for telemetry only.
  const webhookLineItemsById = new Map<string, Record<string, unknown>>();
  for (const li of (data.line_items as Array<Record<string, unknown>> | undefined) ?? []) {
    if (li.id !== undefined && li.id !== null) {
      webhookLineItemsById.set(String(li.id), li);
    }
  }

  const recreditResults: {
    sku: string;
    quantity: number;
    status: "ok" | "error" | "skipped_already_fulfilled";
    reason?: string;
  }[] = [];

  for (const item of items ?? []) {
    if (!item.sku || !item.quantity || item.quantity <= 0) continue;

    // F-1 / HRD-08.1 — DB is source of truth for fulfilled_quantity.
    const dbFulfilled = (item.fulfilled_quantity as number | undefined) ?? 0;

    const webhookLi = item.shopify_line_item_id
      ? webhookLineItemsById.get(item.shopify_line_item_id)
      : undefined;
    const webhookFulfillmentStatus =
      (webhookLi?.fulfillment_status as string | null | undefined) ?? null;
    const webhookFulfilledHint =
      webhookFulfillmentStatus === "fulfilled" ? (item.quantity as number) : 0;
    const dbWebhookDisagree = dbFulfilled !== webhookFulfilledHint;

    const remaining = Math.max(0, (item.quantity as number) - dbFulfilled);

    // F-1: telemetry row for any line that was partially-or-fully fulfilled
    // when the cancel arrived. Stable external_webhook_id makes the insert
    // idempotent across retries; transient/duplicate failures are swallowed
    // because the recredit decision below is the only mandatory write.
    if (dbFulfilled > 0) {
      try {
        await supabase.from("webhook_events").insert({
          workspace_id: workspaceId,
          platform,
          external_webhook_id: `cancel-fulfilled:${eventId}:${item.id}`,
          topic: "orders/cancelled.cancel_after_fulfillment_partial",
          status: "cancel_after_fulfillment_partial",
          metadata: {
            parent_webhook_event_id: eventId,
            order_id: order.id,
            warehouse_order_item_id: item.id,
            sku: item.sku,
            original_quantity: item.quantity,
            fulfilled_quantity: dbFulfilled,
            remaining_quantity: remaining,
            webhook_fulfillment_status: webhookFulfillmentStatus,
            db_webhook_disagree: dbWebhookDisagree,
          },
        });
      } catch {
        /* idempotent retry / transient — non-critical */
      }
    }

    if (remaining <= 0) {
      // Fully-fulfilled line — no recredit. Telemetry above captured the
      // audit row. recreditResults entry is informational only.
      recreditResults.push({
        sku: item.sku,
        quantity: 0,
        status: "skipped_already_fulfilled",
        reason: `fulfilled_quantity=${dbFulfilled} of ${item.quantity}`,
      });
      continue;
    }

    const lineItemId = item.shopify_line_item_id ?? item.id;
    const correlationId = `cancel:${eventId}:${item.sku}:${lineItemId}`;

    try {
      const result = await recordInventoryChange({
        workspaceId,
        sku: item.sku,
        delta: remaining,
        source: platform === "woocommerce" ? "woocommerce" : "shopify",
        correlationId,
        metadata: {
          webhook_event_id: eventId,
          platform,
          kind: "cancel",
          order_id: order.id,
          remote_order_id: remoteOrderId,
          warehouse_order_item_id: item.id,
          original_quantity: item.quantity,
          fulfilled_quantity: dbFulfilled,
          remaining_quantity: remaining,
        },
      });
      recreditResults.push({
        sku: item.sku,
        quantity: remaining,
        status: result.success || result.alreadyProcessed ? "ok" : "error",
      });
    } catch (err) {
      recreditResults.push({
        sku: item.sku,
        quantity: remaining,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await supabase
    .from("warehouse_orders")
    .update({ fulfillment_status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", order.id);

  // Phase 5 §9.6 D1.b — release every open commit for this order. We
  // release ALL skus (no `skus` filter) because cancel terminates the
  // entire order, regardless of partial-fulfillment state. Lines that
  // were already fulfilled and recorded skipped_already_fulfilled
  // above may not have an open commit (they were released by
  // mark-platform-fulfilled), in which case this releases 0 rows for
  // that SKU and is a safe no-op.
  //
  // Idempotency: a retried orders/cancelled webhook hits this branch
  // a second time. The first call flipped released_at; the second
  // call's UPDATE WHERE released_at IS NULL matches 0 rows. Released
  // count is 0, no double-decrement of committed_quantity.
  try {
    const releaseResult = await releaseOrderItems({
      workspaceId,
      orderId: order.id,
      reason: "order_cancelled",
    });
    if (releaseResult.released > 0) {
      console.info(
        `[process-client-store-webhook] releaseOrderItems(cancel): released ${releaseResult.released} commits for order ${order.id}`,
      );
    }
  } catch (relErr) {
    const msg = relErr instanceof Error ? relErr.message : String(relErr);
    console.error("[process-client-store-webhook] releaseOrderItems(cancel) failed:", msg);
    await supabase.from("sensor_readings").insert({
      workspace_id: workspaceId,
      sensor_name: "inv.commit_ledger_release_failed",
      status: "warning",
      message: `releaseOrderItems(cancel) failed for order ${order.id}: ${msg.slice(0, 200)}`,
      value: { order_id: order.id, platform, error: msg, kind: "cancel" },
    });
  }

  // Surface any errored rows to the review queue.
  const failures = recreditResults.filter((r) => r.status === "error");
  if (failures.length > 0) {
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        org_id: order.org_id,
        category: "cancel_partial_apply",
        severity: "high",
        title: `Order ${order.id}: cancel re-credit failed for ${failures.length} SKU(s)`,
        description: failures
          .map((f) => `${f.sku}: qty=${f.quantity} ${f.reason ?? "error"}`)
          .join("; "),
        metadata: { order_id: order.id, recredit_results: recreditResults },
        status: "open",
        group_key: `cancel_partial:${eventId}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
  }

  if (recreditResults.some((r) => r.status === "ok")) {
    await Promise.allSettled([
      tasks.trigger("bandcamp-inventory-push", {}),
      tasks.trigger("multi-store-inventory-push", {}),
    ]).catch(() => {
      /* non-critical */
    });
  }

  await supabase.from("webhook_events").update({ status: "processed" }).eq("id", eventId);

  return {
    processed: true,
    orderId: order.id,
    remote_order_id: remoteOrderId,
    recredits: recreditResults,
  };
}
