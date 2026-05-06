/**
 * Phase 1 §9.2 D1 + Pass 2 D5 — per-(connection_id, sku) client-store push.
 *
 * Replaces the empty-payload `multi-store-inventory-push` enqueue from the
 * focused-push side of `inventory-fanout.ts`. The 5-min cron stays alive
 * as a drift safety net (X-2 audit) — this task is the steady-state happy
 * path that drops fanout latency from ~5 min to <30 s.
 *
 * Pass 2 platform routing:
 *   - **Shopify** → routes through `setShopifyInventoryCas` (per-connection
 *     transport). Absolute-write with compareQuantity + @idempotent and
 *     a 3-attempt 50/150/400ms hot-path retry loop. CAS exhaustion files
 *     a `cas_exhausted` review queue item and returns `cas_exhausted`
 *     status (does NOT throw — the reconcile sweep picks up residual drift).
 *   - **Squarespace / WooCommerce** → stays on the legacy
 *     `createStoreSyncClient(...).pushInventory(...)` dispatcher.
 *     Squarespace's stock_quantity PUT and WooCommerce's stock_quantity
 *     PUT do NOT have a CAS analog — their HTTP layer is "set absolute,
 *     last write wins". Per-platform mismatch detection is handled by the
 *     `inv.propagation_lag` sensor + the cron sweep, not inline.
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
 *   6. Shopify-specific (Pass 2): mapping.remote_inventory_item_id missing.
 *      Means the OAuth-discover pass hasn't populated the inventory item
 *      GID yet — without it, CAS can't address Shopify's inventory ledger.
 *      Returns `skipped_no_remote_inventory_item_id`. Falling back to the
 *      legacy dispatcher would silently bypass CAS, so we'd rather skip
 *      and surface staff to re-run the discovery.
 *   7. `external_sync_events` ledger acquired (`UNIQUE(system, correlation_id,
 *      sku, action)` where action=`cas_set` for Shopify, `set` for others)
 *      — duplicate retries collide, return `skipped_ledger_duplicate`.
 *   8. `effective_sellable` value identical to `last_pushed_quantity` —
 *      no-op push (saves an HTTPS round-trip and an
 *      `inventory_levels/update` echo from Shopify). Applies to legacy
 *      dispatcher only; Shopify CAS path skips this gate because CAS
 *      always wants to converge against Shopify's actual remote, not
 *      our last-pushed memory.
 *
 * On success:
 *   - Shopify (Pass 2 CAS path): `setShopifyInventoryCas` writes the
 *     ledger row + per-attempt history.
 *   - Legacy path: marks the ledger row `success` with pushed quantity.
 *   - Both: update `client_store_sku_mappings.last_pushed_quantity` +
 *     `last_pushed_at` so Rule #65 echo-cancellation works on the next
 *     storefront webhook.
 *
 * On failure:
 *   - Shopify CAS exhaustion: returns `cas_exhausted` (helper handled
 *     ledger + review queue). Does NOT throw.
 *   - Shopify CAS non-CAS error / legacy push error: marks the ledger
 *     row `error` and re-throws so Trigger.dev retries via its built-in
 *     policy.
 *
 * Rules: #7 (service-role), #12 (IDs only), #15 (stable correlation_id),
 *        #43 (single-write fanout step 4), #44 (track last_pushed_*),
 *        #58 (single owner file: this one for client-store per-SKU push).
 */

import { logger, task } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { shouldFanoutToConnection } from "@/lib/server/client-store-fanout-gate";
import { recordShadowPush } from "@/lib/server/connection-shadow-log";
import {
  computeEffectiveSellable,
  type EffectiveSellableChannel,
} from "@/lib/server/effective-sellable";
import {
  beginExternalSync,
  type ExternalSyncAction,
  type ExternalSyncSystem,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { setShopifyInventoryCas } from "@/lib/server/shopify-cas-retry";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { clientStorePushQueue } from "@/trigger/lib/client-store-push-queues";

/**
 * Shopify stores the REST `default_location_id` as the numeric id (per the
 * comment on `client_store_connections.default_location_id`). The CAS
 * helper expects a GraphQL GID. Tolerate both shapes — operators have
 * historically pasted the GID form into the staff UI by accident, and
 * we don't want to break those connections.
 */
function toShopifyLocationGid(value: string): string {
  return value.startsWith("gid://shopify/Location/") ? value : `gid://shopify/Location/${value}`;
}

/**
 * `remote_inventory_item_id` is set by `discoverShopifySkus` from the
 * Admin GraphQL response, which always returns a GID. Older code paths
 * (manual imports, hand-edited rows) might still carry a numeric REST
 * id, so normalise the same way as the location id.
 */
function toShopifyInventoryItemGid(value: string): string {
  return value.startsWith("gid://shopify/InventoryItem/")
    ? value
    : `gid://shopify/InventoryItem/${value}`;
}

export interface ClientStorePushOnSkuPayload {
  workspaceId: string;
  connectionId: string;
  /** Canonical warehouse variant id. New focused fanout path sends this. */
  variantId?: string;
  /** Preferred live alias row id. Prevents remote SKU reuse from changing target identity. */
  mappingId?: string;
  /** Canonical warehouse SKU. Kept for sellable calculation and legacy callers. */
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
      /** Pass 2: number of CAS attempts (Shopify only). 1 for legacy paths. */
      attempts?: number;
    }
  | {
      status: "cas_exhausted";
      connectionId: string;
      sku: string;
      ledgerId: string;
      attempts: number;
      lastActualQuantity: number | null;
    }
  | {
      status:
        | "skipped_guard"
        | "skipped_connection_missing"
        | "skipped_dormant"
        | "skipped_no_mapping"
        | "skipped_no_default_location"
        | "skipped_no_remote_inventory_item_id"
        | "skipped_unknown_platform"
        | "skipped_ledger_duplicate"
        | "skipped_unchanged_quantity"
        | "skipped_unknown_variant"
        | "skipped_critical_redis_pg_drift";
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
    const {
      workspaceId,
      connectionId,
      variantId,
      mappingId,
      sku,
      correlationId,
      reason,
      metadata,
    } = payload;
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

    const { data: criticalDrift } = await supabase
      .from("redis_pg_drift_observations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .eq("status", "critical")
      .limit(1);
    if ((criticalDrift ?? []).length > 0) {
      return {
        status: "skipped_critical_redis_pg_drift",
        connectionId,
        sku,
        reason: "critical_redis_pg_drift",
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

    // 4) mapping lookup — identity-first. Prefer the explicit mapping id from
    // inventory-fanout; fall back to (connection, variant_id); only legacy
    // payloads without a variant id use remote_sku=sku.
    const mappingSelect =
      "id, variant_id, remote_product_id, remote_variant_id, remote_inventory_item_id, remote_sku, last_pushed_quantity, safety_stock";
    let mapping: {
      id: string;
      variant_id: string;
      remote_product_id: string | null;
      remote_variant_id: string | null;
      remote_inventory_item_id: string | null;
      remote_sku: string;
      last_pushed_quantity: number | null;
      safety_stock: number | null;
    } | null = null;

    if (mappingId) {
      const { data } = await supabase
        .from("client_store_sku_mappings")
        .select(mappingSelect)
        .eq("id", mappingId)
        .eq("connection_id", conn.id)
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .maybeSingle();
      mapping = data;
    }

    if (!mapping && variantId) {
      const { data } = await supabase
        .from("client_store_sku_mappings")
        .select(mappingSelect)
        .eq("connection_id", conn.id)
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .eq("variant_id", variantId)
        .maybeSingle();
      mapping = data;
    }

    if (!mapping && !variantId) {
      const { data } = await supabase
        .from("client_store_sku_mappings")
        .select(mappingSelect)
        .eq("connection_id", conn.id)
        .eq("workspace_id", workspaceId)
        .eq("is_active", true)
        .eq("remote_sku", sku)
        .maybeSingle();
      mapping = data;
    }

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

    // 5b) Pass 2 — Shopify-only invariant. CAS needs the inventory item GID.
    //     If the OAuth-discover pass hasn't populated it (or the row was
    //     hand-edited away), skip with a dedicated status so staff
    //     re-run discovery rather than silently dropping into the
    //     non-CAS legacy dispatcher.
    if (conn.platform === "shopify" && !mapping.remote_inventory_item_id) {
      logger.warn("[client-store-push-on-sku] Shopify mapping missing remote_inventory_item_id", {
        connectionId,
        sku,
        mappingId: mapping.id,
      });
      return {
        status: "skipped_no_remote_inventory_item_id",
        connectionId,
        sku,
        reason: "remote_inventory_item_id_required_for_shopify_cas",
      };
    }

    // 6) no-op push elision — Rule #44 echo-cancellation baseline.
    //    SKIPPED for Shopify in Pass 2: CAS always wants to converge
    //    against Shopify's *actual* remote, not our memory of it. If
    //    Shopify and our `last_pushed_quantity` agree, the CAS write is
    //    @idempotent and effectively a no-op anyway.
    if (
      conn.platform !== "shopify" &&
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

    // 7) ledger acquire — idempotency. Action verb segments Pass 2 CAS
    //    writes (`cas_set`) from the legacy absolute-set path (`set`)
    //    so analytics / sensors can tell them apart.
    const ledgerAction: ExternalSyncAction = conn.platform === "shopify" ? "cas_set" : "set";
    const claim = await beginExternalSync(supabase, {
      system: syncSystem,
      correlation_id: correlationId,
      sku,
      action: ledgerAction,
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

    // 8a) Pass 2 — Shopify CAS branch (per-connection transport).
    if (conn.platform === "shopify") {
      // Type-narrowing: step 5 already checked default_location_id and
      // step 5b already checked remote_inventory_item_id, but TS can't
      // see that across the conditional branches. Re-assert here.
      const inventoryItemGid = toShopifyInventoryItemGid(
        mapping.remote_inventory_item_id as string,
      );
      const locationGid = toShopifyLocationGid(conn.default_location_id as string);

      try {
        const result = await setShopifyInventoryCas({
          supabase,
          transport: {
            kind: "per_connection",
            ctx: { storeUrl: conn.store_url, accessToken: conn.api_key as string },
          },
          inventoryItemId: inventoryItemGid,
          locationId: locationGid,
          workspaceId,
          orgId: conn.org_id ?? null,
          sku,
          correlationId,
          // Narrowed: in this branch `conn.platform === "shopify"` so the
          // ledger system is always the client-store flavor. (We can't pass
          // the broader `syncSystem` here — the CAS retry helper requires
          // a Shopify-only literal so its review-queue rows stay segmented.)
          system: "client_store_shopify",
          ledgerId: claim.id,
          // Re-read effective_sellable each retry — a sale that lands
          // between attempts moves the desired value with the truth.
          // The `remoteAvailable` parameter is the Shopify-side count;
          // we ignore it for compute (Postgres is truth) but the helper
          // forwards it as `expectedQuantity` for CAS.
          computeDesired: async () => {
            const fresh = await computeEffectiveSellable(supabase, {
              workspaceId,
              sku,
              channel,
              connectionId: conn.id,
            });
            return fresh.effectiveSellable;
          },
          reason: "fanout",
        });

        if (result.ok) {
          // Rule #44 / Rule #65 — record what we pushed for echo cancel.
          await supabase
            .from("client_store_sku_mappings")
            .update({
              last_pushed_quantity: result.finalNewQuantity,
              last_pushed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", mapping.id);

          // Phase 3 Pass 2 — shadow-mode write hook. Fires only when the
          // connection is currently in `cutover_state='shadow'`. The helper
          // is internally guarded (returns `skipped_not_shadow` for
          // legacy/direct) but we short-circuit here too so we don't
          // pay the function-call cost on the hot legacy/direct path.
          if (conn.cutover_state === "shadow") {
            await recordShadowPush({
              supabase,
              workspaceId,
              connectionId: conn.id,
              sku,
              correlationId,
              pushedQuantity: result.finalNewQuantity,
              cutoverStateAtPush: "shadow",
              shadowWindowToleranceSeconds: conn.shadow_window_tolerance_seconds,
              metadata: {
                platform: "shopify",
                push_path: "cas",
                attempts: result.attempts.length,
                ledger_id: claim.id,
                reason,
              },
            });
          }

          return {
            status: "ok",
            connectionId,
            sku,
            pushedQuantity: result.finalNewQuantity,
            ledgerId: claim.id,
            attempts: result.attempts.length,
          };
        }

        // CAS exhausted — helper marked ledger error + filed
        // cas_exhausted review queue row. Don't throw: reconcile sweep
        // picks up residual drift.
        return {
          status: "cas_exhausted",
          connectionId,
          sku,
          ledgerId: claim.id,
          attempts: result.attempts.length,
          lastActualQuantity: result.lastActualQuantity,
        };
      } catch (err) {
        // Defensive (the helper already marks ledger error before
        // throwing on non-CAS paths, but a computeDesired throw can
        // bubble through). Mark idempotently and re-throw for retry.
        try {
          await markExternalSyncError(supabase, claim.id, err);
        } catch {
          // ignore double-mark errors
        }
        logger.error("[client-store-push-on-sku] Shopify CAS pipeline failed", {
          connectionId,
          sku,
          correlationId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // 8b) Legacy dispatcher branch (Squarespace / WooCommerce).
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

      // Phase 3 Pass 2 — shadow-mode write hook (legacy dispatcher branch).
      // Squarespace + WooCommerce are absolute-set "last write wins" so
      // the shadow comparison still matters: SS Inventory Sync mirrors
      // those pushes into v2, and the comparison confirms they converge.
      if (conn.cutover_state === "shadow") {
        await recordShadowPush({
          supabase,
          workspaceId,
          connectionId: conn.id,
          sku,
          correlationId,
          pushedQuantity,
          cutoverStateAtPush: "shadow",
          shadowWindowToleranceSeconds: conn.shadow_window_tolerance_seconds,
          metadata: {
            platform: conn.platform,
            push_path: "legacy_dispatcher",
            ledger_id: claim.id,
            reason,
          },
        });
      }

      return {
        status: "ok",
        connectionId,
        sku,
        pushedQuantity,
        ledgerId: claim.id,
        attempts: 1,
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
