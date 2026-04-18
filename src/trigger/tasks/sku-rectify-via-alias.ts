// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
// Rule #12: Task payload is IDs only — task fetches what it needs.
//
// Phase 0.5 — SKU rectify via ShipStation v1 product alias add. Plan
// §7.1.10 (concurrency hardened per second-pass reviewer).
//
// Hazards addressed inline:
//   1. Lost-update on full-resource PUT — per-product Redis mutex with
//      120s TTL (plan §7.1.10 Patch D1 — sized for v1 40 req/min Retry-After).
//   2. Pre-image not captured — `sku_remap_history.pre_image` now stores the
//      ENTIRE prior product (aliases array, sku, name, etc.) so a future
//      rollback or forensic diff has byte-for-byte truth.
//   3. Post-write unverified — re-GET after PUT and assert the alias is in
//      the returned aliases[] before marking history success.
//
// What this task does NOT do (out of Phase 0.5 scope):
//   - Bandcamp/Clandestine Shopify SKU renames (plan §7.1.10 hazard 2 —
//     defers to a follow-up `sku-rectify-via-rename.ts` task).
//   - Inventory hand-off at the alias-add boundary — the Patch D2 probe
//     confirmed `decrement` works at 1→0, so any in-flight orders during
//     the alias window are safe.

import { logger, task } from "@trigger.dev/sdk";
import {
  addAliasToProduct,
  getProduct,
  getProductBySku,
  type ShipStationProduct,
} from "@/lib/clients/shipstation";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { releaseMutex, tryAcquireMutex } from "@/trigger/lib/redis-mutex";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface SkuRectifyViaAliasPayload {
  /**
   * The conflict that motivated this rectify. Required so we can flip the
   * conflict row to `resolved` after success and link `sku_remap_history`
   * back to it for audit.
   */
  conflict_id: string;
  /**
   * The "owns inventory" SKU we're keeping as the ShipStation master. If
   * this differs from the ShipStation product's existing master sku,
   * lookup is by the master, not the alias.
   */
  master_sku: string;
  /**
   * The downstream SKU to add as an alias on the master. Must be the
   * channel's spelling — ShipStation Inventory Sync matches by exact
   * string.
   */
  alias_sku: string;
  /** Optional: which client store this alias is for (display only). */
  store_name?: string;
  /** Optional: ShipStation storeId to scope the alias to. */
  store_id?: number;
  /** Staff user who approved this rectify (for audit). */
  approved_by_user_id?: string;
}

export interface SkuRectifyViaAliasResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  shipstation_product_id?: number;
  history_id?: string;
}

export const skuRectifyViaAliasTask = task({
  id: "sku-rectify-via-alias",
  queue: shipstationQueue,
  // Worst case: mutex wait (30s) + 429 Retry-After (60s) + GET + PUT +
  // re-GET verify (≈10s) + jitter. 300s gives generous headroom.
  maxDuration: 300,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
  },
  run: async (payload: SkuRectifyViaAliasPayload, { ctx }): Promise<SkuRectifyViaAliasResult> => {
    const supabase = createServiceRoleClient();
    const correlationId = ctx.run.id;
    logger.info("sku-rectify-via-alias started", { correlationId, payload });

    // ── Load conflict + variant + workspace context ────────────────────────
    const { data: conflict, error: cErr } = await supabase
      .from("sku_sync_conflicts")
      .select("id, workspace_id, variant_id, status")
      .eq("id", payload.conflict_id)
      .single();
    if (cErr || !conflict) {
      throw new Error(`conflict ${payload.conflict_id} not found: ${cErr?.message}`);
    }
    if (conflict.status === "resolved") {
      logger.warn("conflict already resolved; skipping", { correlationId });
      return { status: "skipped", reason: "already_resolved" };
    }

    // ── Look up the ShipStation master product by SKU ──────────────────────
    const product = await getProductBySku(payload.master_sku);
    if (!product) {
      throw new Error(
        `ShipStation v1 has no product with master sku=${payload.master_sku} ` +
          `— either the master SKU is wrong or the product hasn't been imported yet`,
      );
    }

    // ── Idempotency claim BEFORE any external mutation ─────────────────────
    const claim = await beginExternalSync(supabase, {
      system: "shipstation_v1",
      correlation_id: correlationId,
      sku: payload.alias_sku,
      action: "alias_add",
      request_body: {
        productId: product.productId,
        master_sku: payload.master_sku,
        alias_sku: payload.alias_sku,
        store_id: payload.store_id ?? null,
        store_name: payload.store_name ?? null,
      },
    });

    if (!claim.acquired) {
      logger.info("alias_add already claimed for this correlation", {
        correlationId,
        reason: claim.reason,
        existing_id: claim.existing_id,
      });
      return {
        status: "skipped",
        reason: claim.reason,
        shipstation_product_id: product.productId,
      };
    }

    // ── Per-product Redis mutex (plan §7.1.10 hazard 1) ────────────────────
    const lockKey = `ssv1:product_lock:${product.productId}`;
    const lockToken = `${ctx.run.id}:${ctx.attempt.number}`;
    const handle = await tryAcquireMutex(lockKey, lockToken, 120);

    if (!handle) {
      // Another rectify is touching this product. Mark our claim as
      // errored (so the caller can re-queue with a new correlation if
      // they want) and let Trigger's retry backoff give the lock time
      // to free.
      await markExternalSyncError(supabase, claim.id, new Error("mutex_busy"), { lockKey });
      throw new Error(`mutex busy on ${lockKey} — Trigger will retry`);
    }

    let historyId: string | null = null;
    try {
      // ── Pre-image snapshot inside the mutex window ───────────────────────
      const preImage: ShipStationProduct = await getProduct(product.productId);

      const { data: historyRow, error: hErr } = await supabase
        .from("sku_remap_history")
        .insert({
          workspace_id: conflict.workspace_id,
          variant_id: conflict.variant_id,
          from_sku: payload.master_sku,
          to_sku: payload.alias_sku,
          platform: "shipstation_alias",
          changed_by_user_id: payload.approved_by_user_id ?? null,
          correlation_id: correlationId,
          conflict_id: conflict.id,
          status: "in_flight",
          pre_image: preImage as unknown as Record<string, unknown>,
        })
        .select("id")
        .single();
      if (hErr || !historyRow) {
        throw new Error(`failed to insert sku_remap_history: ${hErr?.message}`);
      }
      historyId = historyRow.id;

      // ── Mutate (idempotent on alias already present) ─────────────────────
      const writeResult = await addAliasToProduct({
        current: preImage,
        aliasSku: payload.alias_sku,
        storeId: payload.store_id,
        storeName: payload.store_name,
      });

      // ── Post-write verify: re-GET and confirm ────────────────────────────
      const verify = await getProduct(product.productId);
      const aliasPresent = verify.aliases.some((a) => a.name === payload.alias_sku);
      if (!aliasPresent) {
        throw new Error(
          `alias ${payload.alias_sku} missing after PUT on product ${product.productId}`,
        );
      }

      // ── Mark history success + ledger success ────────────────────────────
      const { error: histUpErr } = await supabase
        .from("sku_remap_history")
        .update({
          status: "success",
          completed_at: new Date().toISOString(),
          post_image: verify as unknown as Record<string, unknown>,
        })
        .eq("id", historyId);
      if (histUpErr) throw histUpErr;

      await markExternalSyncSuccess(supabase, claim.id, {
        productId: writeResult.productId,
        aliases: writeResult.aliases,
      });

      // ── Resolve the conflict ────────────────────────────────────────────
      const { error: resErr } = await supabase
        .from("sku_sync_conflicts")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolved_by: payload.approved_by_user_id ?? null,
          resolution_method: "alias_added",
        })
        .eq("id", conflict.id);
      if (resErr) throw resErr;

      logger.info("sku-rectify-via-alias success", {
        correlationId,
        productId: product.productId,
        aliases_after: verify.aliases.length,
      });

      return {
        status: "ok",
        shipstation_product_id: product.productId,
        history_id: historyId ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("sku-rectify-via-alias failed", { correlationId, message });
      if (historyId) {
        await supabase
          .from("sku_remap_history")
          .update({
            status: "error",
            error_message: message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", historyId);
      }
      await markExternalSyncError(supabase, claim.id, err);
      throw err;
    } finally {
      await releaseMutex(handle);
    }
  },
});
