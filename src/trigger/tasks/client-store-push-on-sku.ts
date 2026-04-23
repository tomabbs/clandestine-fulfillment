/**
 * Phase 1 §9.2 D1 — per-(connection_id, sku) client-store push.
 *
 * Replaces the empty-payload `multi-store-inventory-push` enqueue from the
 * focused-push side of `inventory-fanout.ts`. The 5-min cron stays alive
 * as a drift safety net (X-2 audit) — this task is the steady-state happy
 * path that drops fanout latency from ~5 min to <30 s.
 *
 * Skip cascade (in order, all short-circuit):
 *   1. fanout-guard (`client_store` integration kill switch + per-workspace
 *      rollout bucket).
 *   2. connection lookup fails — connection deleted between enqueue and
 *      run.
 *   3. `shouldFanoutToConnection(conn)` denies — connection went dormant
 *      between enqueue and run (`do_not_fanout`, auth_failed, etc.).
 *   4. `client_store_sku_mappings` row missing for (connection_id, sku) —
 *      mapping was deactivated or removed between enqueue and run.
 *   5. `connection.default_location_id` missing — HRD-05 invariant
 *      (Shopify only). Without a chosen location, `pushInventory` would
 *      fall back to whatever location Shopify reports first, which can
 *      differ from the staff-chosen warehouse location.
 *   6. `external_sync_events` ledger acquired (`UNIQUE(system, correlation_id,
 *      sku, action='set')`) — duplicate retries collide, return
 *      `skipped_ledger_duplicate`.
 *   7. `effective_sellable` value identical to `last_pushed_quantity` —
 *      no-op push (saves an HTTPS round-trip and an
 *      `inventory_levels/update` echo from Shopify).
 *
 * On success:
 *   - Calls `client.pushInventory(sku, effectiveSellable, idempotencyKey)`.
 *   - Updates `client_store_sku_mappings.last_pushed_quantity` +
 *     `last_pushed_at` so Rule #65 echo-cancellation works on the next
 *     storefront webhook AND so Pass 2 Shopify CAS has the right
 *     `changeFromQuantity` baseline.
 *   - Marks the ledger row `success` with the pushed quantity in
 *     `response_body`.
 *
 * On failure:
 *   - Marks the ledger row `error` with the error body.
 *   - Re-throws so Trigger.dev retries via its built-in policy (the task
 *     does NOT carry a custom retry — Trigger.dev defaults are sufficient
 *     for transient network errors).
 *
 * Echo / CAS layering reminder (plan §9.2 D7):
 *   `effectiveSellable` is the value we PUSH. The CAS comparator
 *   (`changeFromQuantity`) — when Pass 2 lands — uses raw remote
 *   `available` (last observed via `last_pushed_quantity`), NOT the
 *   safety-stock-adjusted value. Mixing the two would make every CAS call
 *   mismatch on local reservation churn instead of real concurrent
 *   writes.
 *
 * Rules: #7 (service-role), #12 (IDs only), #15 (stable correlation_id),
 *        #43 (single-write fanout step 4), #44 (track last_pushed_*),
 *        #58 (single owner file: this one for client-store per-SKU push).
 */

import { logger, task } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { shouldFanoutToConnection } from "@/lib/server/client-store-fanout-gate";
import {
  computeEffectiveSellable,
  type EffectiveSellableChannel,
} from "@/lib/server/effective-sellable";
import {
  beginExternalSync,
  type ExternalSyncSystem,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { clientStorePushQueue } from "@/trigger/lib/client-store-push-queues";

export interface ClientStorePushOnSkuPayload {
  workspaceId: string;
  connectionId: string;
  sku: string;
  /**
   * Stable per-logical-operation. e.g. `fanout:{sku}:{ts}`,
   * `webhook:shopify:{webhookId}:{sku}`, `manual:{userId}:{batchId}:{sku}`.
   * NEVER a random UUID per network call (Rule #15) — the ledger
   * UNIQUE(system, correlation_id, sku, action) is what makes retries
   * idempotent.
   */
  correlationId: string;
  /** Free-text reason for diagnostics. e.g. `fanout:shopify_webhook`. */
  reason: string;
  metadata?: Record<string, unknown>;
}

export type ClientStorePushOnSkuResult =
  | {
      status: "ok";
      connectionId: string;
      sku: string;
      pushedQuantity: number;
      ledgerId: string;
    }
  | {
      status:
        | "skipped_guard"
        | "skipped_connection_missing"
        | "skipped_dormant"
        | "skipped_no_mapping"
        | "skipped_no_default_location"
        | "skipped_unknown_platform"
        | "skipped_ledger_duplicate"
        | "skipped_unchanged_quantity"
        | "skipped_unknown_variant";
      connectionId: string;
      sku: string;
      reason: string;
    };

/**
 * Map a `client_store_connections.platform` value onto the channel name
 * expected by `computeEffectiveSellable`. Centralised so a typo at the
 * call site can't silently flush the wrong channel's reserve.
 */
function platformToChannel(platform: string): EffectiveSellableChannel | null {
  switch (platform) {
    case "shopify":
      return "client_store_shopify";
    case "squarespace":
      return "client_store_squarespace";
    case "woocommerce":
      return "client_store_woocommerce";
    default:
      return null;
  }
}

function platformToSyncSystem(platform: string): ExternalSyncSystem | null {
  switch (platform) {
    case "shopify":
      return "client_store_shopify";
    case "squarespace":
      return "client_store_squarespace";
    case "woocommerce":
      return "client_store_woocommerce";
    default:
      return null;
  }
}

export const clientStorePushOnSkuTask = task({
  id: "client-store-push-on-sku",
  queue: clientStorePushQueue,
  maxDuration: 60,
  run: async (payload: ClientStorePushOnSkuPayload): Promise<ClientStorePushOnSkuResult> => {
    const { workspaceId, connectionId, sku, correlationId, reason, metadata } = payload;
    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("client_store", correlationId);
    if (!decision.allow) {
      logger.info("[client-store-push-on-sku] guard skip", {
        workspaceId,
        connectionId,
        sku,
        correlationId,
        reason: decision.reason,
      });
      return {
        status: "skipped_guard",
        connectionId,
        sku,
        reason: decision.reason,
      };
    }

    // 2) connection lookup
    const { data: connection } = await supabase
      .from("client_store_connections")
      .select("*")
      .eq("id", connectionId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (!connection) {
      logger.warn("[client-store-push-on-sku] connection missing — skipping", {
        workspaceId,
        connectionId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_connection_missing",
        connectionId,
        sku,
        reason: "connection_not_found",
      };
    }

    const conn = connection as ClientStoreConnection;

    // 3) dormancy gate (Phase 0.8 single chokepoint)
    const fanoutDecision = shouldFanoutToConnection(conn);
    if (!fanoutDecision.allow) {
      logger.info("[client-store-push-on-sku] dormant connection — skipping", {
        connectionId,
        sku,
        correlationId,
        reason: fanoutDecision.reason,
      });
      return {
        status: "skipped_dormant",
        connectionId,
        sku,
        reason: fanoutDecision.reason ?? "dormant",
      };
    }

    // Map platform → channel + sync system. Unknown platforms (BigCommerce
    // etc. — present in the schema as future enum values but not yet
    // wired) bail out cleanly.
    const channel = platformToChannel(conn.platform);
    const syncSystem = platformToSyncSystem(conn.platform);
    if (!channel || !syncSystem) {
      logger.warn("[client-store-push-on-sku] unsupported platform", {
        connectionId,
        platform: conn.platform,
      });
      return {
        status: "skipped_unknown_platform",
        connectionId,
        sku,
        reason: `platform_${conn.platform}_not_supported`,
      };
    }

    // HRD-05 invariant for Shopify: refuse to push without an explicit
    // staff-chosen location. The store-sync-client falls back to "first
    // location reported by Shopify" which silently differs from the
    // operator's chosen warehouse.
    if (conn.platform === "shopify" && !conn.default_location_id) {
      logger.warn("[client-store-push-on-sku] Shopify connection missing default_location_id", {
        connectionId,
        sku,
      });
      return {
        status: "skipped_no_default_location",
        connectionId,
        sku,
        reason: "default_location_id_required_for_shopify",
      };
    }

    // 4) mapping lookup — both `remote_sku` (the storefront's SKU) AND
    //    variant_id resolution.
    const { data: mapping } = await supabase
      .from("client_store_sku_mappings")
      .select(
        "id, variant_id, remote_product_id, remote_variant_id, remote_sku, last_pushed_quantity, safety_stock",
      )
      .eq("connection_id", conn.id)
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .eq("remote_sku", sku)
      .maybeSingle();

    if (!mapping) {
      logger.info("[client-store-push-on-sku] no active mapping — skipping", {
        connectionId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_no_mapping",
        connectionId,
        sku,
        reason: "no_active_mapping",
      };
    }

    // 5) compute effective sellable via shared helper (X-7 dual-edit).
    const sellable = await computeEffectiveSellable(supabase, {
      workspaceId,
      sku,
      channel,
      connectionId: conn.id,
    });

    if (sellable.reason === "variant_not_found") {
      logger.warn("[client-store-push-on-sku] variant not in workspace — skipping", {
        workspaceId,
        sku,
      });
      return {
        status: "skipped_unknown_variant",
        connectionId,
        sku,
        reason: "variant_not_found",
      };
    }

    const pushedQuantity = sellable.effectiveSellable;

    // 6) no-op push elision — Rule #44 echo-cancellation baseline.
    if (
      typeof mapping.last_pushed_quantity === "number" &&
      mapping.last_pushed_quantity === pushedQuantity
    ) {
      logger.info("[client-store-push-on-sku] quantity unchanged — skipping", {
        connectionId,
        sku,
        pushedQuantity,
      });
      return {
        status: "skipped_unchanged_quantity",
        connectionId,
        sku,
        reason: "no_op_same_as_last_pushed",
      };
    }

    // 7) ledger acquire — idempotency
    const claim = await beginExternalSync(supabase, {
      system: syncSystem,
      correlation_id: correlationId,
      sku,
      action: "set",
      request_body: {
        connection_id: conn.id,
        platform: conn.platform,
        remote_sku: mapping.remote_sku,
        pushed_quantity: pushedQuantity,
        available: sellable.available,
        committed: sellable.committedQuantity,
        safety_stock: sellable.safetyStock,
        safety_source: sellable.safetySource,
        reason,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      logger.info("[client-store-push-on-sku] ledger short-circuit", {
        connectionId,
        sku,
        correlationId,
        reason: claim.reason,
        existing_status: claim.existing_status,
      });
      return {
        status: "skipped_ledger_duplicate",
        connectionId,
        sku,
        reason: claim.reason,
      };
    }

    // 8) push to remote storefront via the dispatcher
    try {
      const skuMappingContext = new Map([
        [
          mapping.remote_sku ?? sku,
          {
            remoteProductId: mapping.remote_product_id,
            remoteVariantId: mapping.remote_variant_id,
          },
        ],
      ]);
      const client = createStoreSyncClient(conn, skuMappingContext);
      // Idempotency key includes the pushed value so a retry of the SAME
      // logical operation is dedup'd by the platform's own idempotency
      // store (where supported), and a NEW value lands as a distinct
      // operation. The ledger above handles the cross-app idempotency.
      const idempotencyKey = `client-store-push:${conn.id}:${mapping.id}:${pushedQuantity}`;
      await client.pushInventory(mapping.remote_sku ?? sku, pushedQuantity, idempotencyKey);

      // Rule #44 / Rule #65 — record the value pushed so future
      // storefront webhooks can echo-cancel against this baseline.
      await supabase
        .from("client_store_sku_mappings")
        .update({
          last_pushed_quantity: pushedQuantity,
          last_pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", mapping.id);

      await markExternalSyncSuccess(supabase, claim.id, {
        pushed_quantity: pushedQuantity,
        ok: true,
      });

      return {
        status: "ok",
        connectionId,
        sku,
        pushedQuantity,
        ledgerId: claim.id,
      };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[client-store-push-on-sku] push failed", {
        connectionId,
        sku,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
