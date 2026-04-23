/**
 * Phase 4 — SHIP_NOTIFY (and any inventory-mutating event) → Bandcamp
 * focused per-SKU push.
 *
 * Triggered by `process-shipstation-shipment` after each line item's
 * successful `recordInventoryChange()`. Mirrors the new
 * `warehouse_inventory_levels.available` for that SKU onto Bandcamp via
 * `update_quantities`, gated through the `external_sync_events` ledger
 * (plan §1.4.2) keyed by `ship:{shipmentId}:{sku}` so retries are
 * idempotent.
 *
 * Why a separate task (not inline in process-shipstation-shipment):
 *   - SHIP_NOTIFY processor runs on `shipstationQueue`. Calling Bandcamp
 *     OAuth endpoints inline would violate Rule #9 (Bandcamp OAuth
 *     serialization across tasks via `bandcampQueue`). Pinning this task
 *     to `bandcampQueue` (concurrencyLimit: 1) keeps Bandcamp API calls
 *     serialized application-wide and prevents `duplicate_grant` token
 *     destruction.
 *
 * Skip rules (in order):
 *   1. `fanout-guard` (`bandcamp` integration kill switch + per-workspace
 *      rollout bucket).
 *   2. Variant not found in workspace.
 *   3. Distro variant (`warehouse_products.org_id IS NULL`) — distro
 *      products are not Bandcamp upstream by definition.
 *   4. No `bandcamp_product_mappings` row for the variant — no Bandcamp
 *      side to push to.
 *   5. `push_mode NOT IN ('normal','manual_override')` — Phase 1 contract
 *      (blocked_baseline / blocked_multi_origin are skipped at source).
 *   6. Variant is a bundle parent — bundle-aggregated pushes go through
 *      the cron `bandcamp-inventory-push` path (which has the bundle math
 *      hot loop). Per-SKU focused push is component-level only.
 *   7. Option-level mapping (the package has `options` on Bandcamp) —
 *      deferred to the cron path. Focused push is package-level only in
 *      Phase 4.
 *   8. Ledger short-circuit (`already_in_flight` / `already_succeeded` /
 *      `already_errored`).
 *
 * Push math: `pushed_quantity = MAX(0, available - effective_safety)`
 * where `available` is `warehouse_inventory_levels.available` for the
 * variant and `effective_safety = COALESCE(per_sku.safety_stock,
 * workspace.default_safety_stock, 3)`. Identical formula to the cron
 * path so cron + focused push agree.
 *
 * Rule #7  — service-role client.
 * Rule #9  — bandcampQueue (OAuth serialization).
 * Rule #12 — payload IDs only.
 * Rule #43 — fanout step (4) for SHIP_NOTIFY-originated inventory writes.
 */

import { logger, task } from "@trigger.dev/sdk";
import { refreshBandcampToken, updateQuantities } from "@/lib/clients/bandcamp";
import { computeEffectiveSellable } from "@/lib/server/effective-sellable";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export interface BandcampPushOnSkuPayload {
  workspaceId: string;
  sku: string;
  /** Stable per-logical-operation. e.g. `ship:{shipmentId}:{sku}`. */
  correlationId: string;
  /** Free-text reason for diagnostics. e.g. `shipstation_ship_notify`. */
  reason: string;
  /** Optional metadata captured on the ledger row. */
  metadata?: Record<string, unknown>;
}

export type BandcampPushOnSkuResult =
  | {
      status: "ok";
      correlationId: string;
      sku: string;
      pushed_quantity: number;
      ledger_id: string;
    }
  | {
      status:
        | "skipped_guard"
        | "skipped_unknown_variant"
        | "skipped_distro"
        | "skipped_no_mapping"
        | "skipped_push_mode"
        | "skipped_bundle_parent"
        | "skipped_option_level"
        | "skipped_ledger_duplicate";
      correlationId: string;
      sku: string;
      reason: string;
    };

export const bandcampPushOnSkuTask = task({
  id: "bandcamp-push-on-sku",
  queue: bandcampQueue,
  maxDuration: 60,
  run: async (payload: BandcampPushOnSkuPayload): Promise<BandcampPushOnSkuResult> => {
    const { workspaceId, sku, correlationId, reason, metadata } = payload;
    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("bandcamp", correlationId);
    if (!decision.allow) {
      logger.info("[bandcamp-push-on-sku] guard skip", {
        workspaceId,
        sku,
        correlationId,
        reason: decision.reason,
      });
      return {
        status: "skipped_guard",
        correlationId,
        sku,
        reason: decision.reason,
      };
    }

    // 2) resolve variant + owning product (for distro detection)
    const { data: variantRow } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, warehouse_products!inner(org_id)")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();

    const variant = variantRow as {
      id: string;
      sku: string;
      warehouse_products?: { org_id: string | null };
    } | null;

    if (!variant) {
      logger.warn("[bandcamp-push-on-sku] unknown variant — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_unknown_variant",
        correlationId,
        sku,
        reason: "variant_not_found",
      };
    }

    // 3) distro skip — defensive
    if (variant.warehouse_products?.org_id == null) {
      logger.info("[bandcamp-push-on-sku] distro variant — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_distro",
        correlationId,
        sku,
        reason: "org_id_is_null",
      };
    }

    // 4) bundle parent exclusion
    const { data: bundleHit } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("bundle_variant_id", variant.id)
      .limit(1)
      .maybeSingle();

    if (bundleHit) {
      logger.info("[bandcamp-push-on-sku] variant is bundle parent — cron handles bundles", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_bundle_parent",
        correlationId,
        sku,
        reason: "bundle_focused_push_deferred",
      };
    }

    // 5) Bandcamp mapping + push_mode gate
    const { data: mapping } = await supabase
      .from("bandcamp_product_mappings")
      .select(
        "id, bandcamp_item_id, bandcamp_item_type, push_mode, last_quantity_sold, bandcamp_origin_quantities",
      )
      .eq("workspace_id", workspaceId)
      .eq("variant_id", variant.id)
      .maybeSingle();

    if (!mapping || !mapping.bandcamp_item_id || !mapping.bandcamp_item_type) {
      logger.info("[bandcamp-push-on-sku] no Bandcamp mapping — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_no_mapping",
        correlationId,
        sku,
        reason: "no_bandcamp_mapping",
      };
    }

    if (mapping.push_mode !== "normal" && mapping.push_mode !== "manual_override") {
      logger.info("[bandcamp-push-on-sku] push_mode blocked — skipping", {
        workspaceId,
        sku,
        correlationId,
        push_mode: mapping.push_mode,
      });
      return {
        status: "skipped_push_mode",
        correlationId,
        sku,
        reason: `push_mode_${mapping.push_mode}`,
      };
    }

    // 6) option-level mapping defer (focused push is package-level only in Phase 4)
    const originQuantities = (mapping.bandcamp_origin_quantities ?? null) as Array<{
      option_quantities?: Array<unknown> | null;
    }> | null;
    const hasOptionLevel = !!originQuantities?.some(
      (o) => Array.isArray(o.option_quantities) && o.option_quantities.length > 0,
    );
    if (hasOptionLevel) {
      logger.info("[bandcamp-push-on-sku] option-level mapping — deferring to cron", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_option_level",
        correlationId,
        sku,
        reason: "option_level_focused_push_deferred",
      };
    }

    // 7) compute pushed_quantity via the shared push-formula helper
    //    (Phase 1 §9.2 D8 / N-13 / X-7). This is the same source of truth
    //    the new client-store and clandestine per-SKU tasks use AND the
    //    `bandcamp-inventory-push` cron uses below — eliminating the
    //    dual-edit hazard where a focused-push delta could disagree with
    //    a cron sweep landing seconds later for the same SKU.
    const sellable = await computeEffectiveSellable(supabase, {
      workspaceId,
      sku,
      channel: "bandcamp",
    });
    const pushedQuantity = sellable.effectiveSellable;

    // 8) ledger acquire — idempotency
    const claim = await beginExternalSync(supabase, {
      system: "bandcamp",
      correlation_id: correlationId,
      sku,
      action: "modify",
      request_body: {
        bandcamp_item_id: mapping.bandcamp_item_id,
        bandcamp_item_type: mapping.bandcamp_item_type,
        quantity_available: pushedQuantity,
        quantity_sold: mapping.last_quantity_sold ?? 0,
        reason,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      logger.info("[bandcamp-push-on-sku] ledger short-circuit", {
        workspaceId,
        sku,
        correlationId,
        reason: claim.reason,
        existing_status: claim.existing_status,
      });
      return {
        status: "skipped_ledger_duplicate",
        correlationId,
        sku,
        reason: claim.reason,
      };
    }

    // 9) push to Bandcamp via OAuth (serialized via bandcampQueue)
    try {
      const accessToken = await refreshBandcampToken(workspaceId);
      await updateQuantities(
        [
          {
            item_id: mapping.bandcamp_item_id,
            item_type: mapping.bandcamp_item_type,
            quantity_available: pushedQuantity,
            quantity_sold: mapping.last_quantity_sold ?? 0,
          },
        ],
        accessToken,
      );
      await markExternalSyncSuccess(supabase, claim.id, {
        pushed_quantity: pushedQuantity,
        ok: true,
      });
      return {
        status: "ok",
        correlationId,
        sku,
        pushed_quantity: pushedQuantity,
        ledger_id: claim.id,
      };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[bandcamp-push-on-sku] updateQuantities failed", {
        workspaceId,
        sku,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
