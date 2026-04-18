/**
 * Phase 3 (finish-line plan v4) — Trigger task variant of `submitManualInventoryCounts`
 * for very large batches. Built as a Rule #41 hardening artifact.
 *
 * Why this exists:
 *   `submitManualInventoryCounts` (src/actions/manual-inventory-count.ts) caps
 *   inline batches at MAX_ENTRIES_PER_BATCH=200 today. With per-row recordInventoryChange()
 *   + per-row v2 enqueue + per-row review-queue dedup, a 200-row batch can
 *   approach Vercel's 60s Server Action timeout. Per Rule #41, anything that
 *   may exceed 30s should be offloaded to Trigger.
 *
 *   This task accepts the SAME payload shape as `submitManualInventoryCounts`,
 *   walks the same per-row write contract, and returns the same result shape.
 *   Callers can therefore route conservatively: <=10 entries inline (safe),
 *   11..200 inline today (legacy path), >200 enqueue here. As production
 *   experience accumulates we can lower the inline cap without touching the
 *   business logic — it's the same code path either way.
 *
 *   v4 plan also notes a UX-visible benefit: a Trigger run produces a
 *   navigable run page in the Trigger.dev dashboard for operator triage of
 *   slow batches.
 *
 * What this task does NOT do:
 *   It does NOT factor the per-row write logic out of
 *   `submitManualInventoryCounts` into a shared helper today. That would be
 *   a follow-up refactor (`bulk-batch-correlation-grouping` deferred slug).
 *   For now this task re-implements the contract by pulling the small
 *   utilities it needs and re-issuing the same per-row writes; tests assert
 *   contract parity.
 *
 * Idempotency:
 *   The Server Action that enqueues this task supplies a stable `batchId`
 *   (UUID) that flows into every per-row correlation_id (
 *   `manual-count:{userId}:{batchId}:{sku}`). A duplicate Trigger run with
 *   the same payload hits the unique key on `warehouse_inventory_activity`
 *   and `external_sync_events` and silently no-ops at row level.
 *
 * Queue: `shipstation` (concurrencyLimit:1) — same queue used by
 * `shipstation-v2-adjust-on-sku` so the v2 fanout traffic is naturally
 * serialized across direct-call and bulk-task callers.
 *
 * Rule #7 — service-role client.
 * Rule #20 — recordInventoryChange is the single inventory write path.
 * Rule #41 — heavy work belongs in Trigger.
 * Rule #59 — this task is NOT a bulk-shape exception; it still goes
 *            through recordInventoryChange per-row (200-row batch ceiling
 *            keeps the cost bounded).
 */

import { logger, task } from "@trigger.dev/sdk";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

const HIGH_DELTA_THRESHOLD = 10;

export interface BulkUpdateAvailableEntry {
  sku: string;
  newAvailable: number;
  /** When true, bypasses the high-delta + zero-crossing confirmation gate. */
  force?: boolean;
}

export interface BulkUpdateAvailablePayload {
  workspaceId: string;
  orgId: string;
  userId: string;
  /** Stable per logical bulk operation. UI re-submission re-uses the same id. */
  batchId: string;
  entries: BulkUpdateAvailableEntry[];
}

export type BulkUpdateAvailableEntryStatus =
  | "applied"
  | "no_change"
  | "blocked_negative"
  | "requires_confirm"
  | "skipped_count_in_progress"
  | "unknown_sku"
  | "error";

export interface BulkUpdateAvailableEntryResult {
  sku: string;
  status: BulkUpdateAvailableEntryStatus;
  reason?: string;
  previousAvailable?: number;
  newAvailable?: number;
  delta?: number;
}

export interface BulkUpdateAvailableResult {
  batchId: string;
  appliedCount: number;
  noChangeCount: number;
  blockedCount: number;
  requiresConfirmCount: number;
  unknownCount: number;
  errorCount: number;
  results: BulkUpdateAvailableEntryResult[];
}

export const bulkUpdateAvailableTask = task({
  id: "bulk-update-available",
  queue: shipstationQueue,
  maxDuration: 900,
  run: async (payload: BulkUpdateAvailablePayload): Promise<BulkUpdateAvailableResult> => {
    if (payload.entries.length === 0) {
      return {
        batchId: payload.batchId,
        appliedCount: 0,
        noChangeCount: 0,
        blockedCount: 0,
        requiresConfirmCount: 0,
        unknownCount: 0,
        errorCount: 0,
        results: [],
      };
    }

    logger.info("bulk-update-available start", {
      workspaceId: payload.workspaceId,
      orgId: payload.orgId,
      batchId: payload.batchId,
      entryCount: payload.entries.length,
    });

    const supabase = createServiceRoleClient();

    const skus = payload.entries.map((e) => e.sku);
    const { data: levelsRaw, error: levelsError } = await supabase
      .from("warehouse_inventory_levels")
      .select(
        `
        sku,
        available,
        count_status,
        warehouse_product_variants!inner (
          id,
          warehouse_products!inner (org_id)
        )
      `,
      )
      .eq("workspace_id", payload.workspaceId)
      .in("sku", skus);

    if (levelsError) {
      throw new Error(
        `bulk-update-available: failed to pre-fetch inventory: ${levelsError.message}`,
      );
    }

    type LevelRow = {
      sku: string;
      available: number;
      count_status: "idle" | "count_in_progress";
      warehouse_product_variants: { id: string; warehouse_products: { org_id: string } };
    };
    const levelMap = new Map<string, LevelRow>();
    for (const row of (levelsRaw as unknown as LevelRow[] | null) ?? []) {
      levelMap.set(row.sku, row);
    }

    const results: BulkUpdateAvailableEntryResult[] = [];

    for (const entry of payload.entries) {
      const level = levelMap.get(entry.sku);

      if (!level) {
        results.push({ sku: entry.sku, status: "unknown_sku", reason: "sku_not_in_workspace" });
        continue;
      }
      if (level.warehouse_product_variants.warehouse_products.org_id !== payload.orgId) {
        results.push({ sku: entry.sku, status: "unknown_sku", reason: "sku_not_in_org" });
        continue;
      }
      if ((level.count_status ?? "idle") === "count_in_progress") {
        results.push({
          sku: entry.sku,
          status: "skipped_count_in_progress",
          reason: "active_count_session",
        });
        continue;
      }

      const currentAvailable = level.available;
      const newAvailable = entry.newAvailable;
      const delta = newAvailable - currentAvailable;

      if (newAvailable < 0) {
        results.push({
          sku: entry.sku,
          status: "blocked_negative",
          reason: "negative_target",
          previousAvailable: currentAvailable,
        });
        continue;
      }

      if (delta === 0) {
        results.push({
          sku: entry.sku,
          status: "no_change",
          previousAvailable: currentAvailable,
          newAvailable: currentAvailable,
        });
        continue;
      }

      if (!entry.force) {
        let confirmReason: string | null = null;
        if (Math.abs(delta) > HIGH_DELTA_THRESHOLD) {
          confirmReason = "high_delta";
        } else if (currentAvailable === 0 && newAvailable > 0) {
          confirmReason = "rising_from_zero";
        } else if (currentAvailable > 0 && newAvailable === 0) {
          confirmReason = "falling_to_zero";
        }
        if (confirmReason) {
          results.push({
            sku: entry.sku,
            status: "requires_confirm",
            reason: confirmReason,
            previousAvailable: currentAvailable,
            newAvailable,
          });
          continue;
        }
      }

      const correlationId = `manual-count:${payload.userId}:${payload.batchId}:${entry.sku}`;

      try {
        const writeResult = await recordInventoryChange({
          workspaceId: payload.workspaceId,
          sku: entry.sku,
          delta,
          source: "manual_inventory_count",
          correlationId,
          metadata: {
            batch_id: payload.batchId,
            counted_by: payload.userId,
            org_id: payload.orgId,
            previous_available: currentAvailable,
            new_available: newAvailable,
            force: !!entry.force,
            origin: "bulk-update-available-task",
          },
        });

        if (!writeResult.success) {
          results.push({
            sku: entry.sku,
            status: "error",
            reason: "record_inventory_change_failed",
            previousAvailable: currentAvailable,
            newAvailable,
          });
          continue;
        }

        results.push({
          sku: entry.sku,
          status: "applied",
          previousAvailable: currentAvailable,
          newAvailable,
          delta,
        });
      } catch (err) {
        logger.error("bulk-update-available row failed", {
          sku: entry.sku,
          error: err instanceof Error ? err.message : String(err),
        });
        results.push({
          sku: entry.sku,
          status: "error",
          reason: "exception",
          previousAvailable: currentAvailable,
          newAvailable,
        });
      }
    }

    const summary: BulkUpdateAvailableResult = {
      batchId: payload.batchId,
      appliedCount: results.filter((r) => r.status === "applied").length,
      noChangeCount: results.filter((r) => r.status === "no_change").length,
      blockedCount: results.filter((r) => r.status === "blocked_negative").length,
      requiresConfirmCount: results.filter((r) => r.status === "requires_confirm").length,
      unknownCount: results.filter((r) => r.status === "unknown_sku").length,
      errorCount: results.filter((r) => r.status === "error").length,
      results,
    };

    logger.info("bulk-update-available done", {
      batchId: payload.batchId,
      appliedCount: summary.appliedCount,
      noChangeCount: summary.noChangeCount,
      blockedCount: summary.blockedCount,
      requiresConfirmCount: summary.requiresConfirmCount,
      unknownCount: summary.unknownCount,
      errorCount: summary.errorCount,
    });

    return summary;
  },
});
