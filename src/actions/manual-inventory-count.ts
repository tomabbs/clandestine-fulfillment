"use server";

/**
 * Saturday Workstream 2 (2026-04-18) — manual inventory count entry.
 *
 * Backs `/admin/inventory/manual-count`. Staff land on the page Tuesday/Wednesday,
 * pick a client, and enter live on-hand counts via a bulk table editor. Entries
 * are absolute counts ("this SKU has 47 units now"), not deltas.
 *
 * Write contract per row (chosen via AskQuestion responses ws2_count_semantics
 * + ws2_fanout_gating + the safest defaults for skipped ws2_table_scope /
 * ws2_zero_handling questions):
 *
 *  1. Compute delta = newAvailable - currentAvailable.
 *  2. Hard-block any submission that would land available < 0. The row is NOT
 *     written. A warehouse_review_queue item is upserted (severity:'high',
 *     category:'manual_count_negative_block', group_key per workspace+sku) so
 *     staff investigate the upstream sync bug rather than silently work around
 *     it. Re-detection bumps occurrence_count via the UNIQUE group_key index.
 *  3. delta === 0 → no-op (skipped, returned as 'no_change').
 *  4. force !== true AND ANY of (|delta| > 10 / currentAvailable === 0 AND
 *     newAvailable > 0 / currentAvailable > 0 AND newAvailable === 0) → return
 *     'requires_confirm' with the gate that triggered it. UI re-submits with
 *     force:true after operator taps "Confirm".
 *  5. Otherwise call recordInventoryChange({source:'manual_inventory_count'})
 *     with correlationId 'manual-count:{userId}:{batchId}:{sku}' (stable per
 *     row → safe retries).
 *  6. On success AND delta !== 0, fire-and-forget tasks.trigger(
 *       'shipstation-v2-adjust-on-sku', { workspaceId, sku, delta, ... })
 *     so ShipStation v2 reflects the count immediately. The task is
 *     fanout-guard aware, ledger-gated, and pinned to shipstationQueue
 *     (concurrencyLimit: 1) so a 200-row batch cannot exceed v2 60 req/min.
 *  7. Bandcamp fanout: nothing extra to wire — recordInventoryChange()
 *     internally calls fanoutInventoryChange() which already enqueues
 *     bandcamp-inventory-push for any SKU with a bandcamp mapping. Same
 *     for Clandestine Shopify and client store fanout.
 *
 * Rule #4 (Server Actions for mutations), Rule #5 (Zod at boundary),
 * Rule #6 (companion .test.ts), Rule #20 (single inventory write path),
 * Rule #41 (Server Actions stay <30s — bulk ceiling enforced via
 * MAX_ENTRIES_PER_BATCH below; large catalogs paginate client-side),
 * Rule #48 (Server Actions never call ShipStation v2 directly — always
 * delegate to the Trigger task).
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ShipstationV2AdjustOnSkuPayload } from "@/trigger/tasks/shipstation-v2-adjust-on-sku";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max rows per batch. Bounds Server Action runtime (Rule #41) and review-queue
 *  blast radius if a whole submit hits the negative-block path. */
const MAX_ENTRIES_PER_BATCH = 200;

/** Threshold above which a confirmation tap is required (chosen ws2_count_semantics
 *  → absolute_with_threshold). |delta| > this triggers the gate. */
const HIGH_DELTA_THRESHOLD = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const tableQuerySchema = z.object({
  orgId: z.string().uuid(),
  search: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(100),
});

const submitSchema = z.object({
  orgId: z.string().uuid(),
  entries: z
    .array(
      z.object({
        sku: z.string().min(1).max(255),
        newAvailable: z.number().int().min(0).max(1_000_000),
        force: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(MAX_ENTRIES_PER_BATCH),
});

// ─────────────────────────────────────────────────────────────────────────────
// Read: bulk count table
// ─────────────────────────────────────────────────────────────────────────────

export interface ManualCountRow {
  variantId: string;
  sku: string;
  productTitle: string;
  variantTitle: string | null;
  formatName: string | null;
  currentAvailable: number;
  countStatus: "idle" | "count_in_progress";
}

export interface ManualCountTableResult {
  rows: ManualCountRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getManualCountTable(input: {
  orgId: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<ManualCountTableResult> {
  const { workspaceId } = await requireStaff();
  const validated = tableQuerySchema.parse(input);

  const supabase = createServiceRoleClient();
  const offset = (validated.page - 1) * validated.pageSize;

  let query = supabase
    .from("warehouse_inventory_levels")
    .select(
      `
        id,
        variant_id,
        sku,
        available,
        count_status,
        warehouse_product_variants!inner (
          id,
          title,
          format_name,
          warehouse_products!inner (
            id,
            title,
            org_id
          )
        )
      `,
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .eq("warehouse_product_variants.warehouse_products.org_id", validated.orgId);

  if (validated.search) {
    query = query.or(
      `sku.ilike.%${validated.search}%,warehouse_product_variants.warehouse_products.title.ilike.%${validated.search}%`,
    );
  }

  query = query.order("sku", { ascending: true }).range(offset, offset + validated.pageSize - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`Failed to fetch manual count table: ${error.message}`);

  type Row = {
    id: string;
    variant_id: string;
    sku: string;
    available: number;
    count_status: "idle" | "count_in_progress";
    warehouse_product_variants: {
      id: string;
      title: string | null;
      format_name: string | null;
      warehouse_products: { id: string; title: string; org_id: string };
    };
  };

  const rows: ManualCountRow[] = ((data as unknown as Row[] | null) ?? []).map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    productTitle: r.warehouse_product_variants.warehouse_products.title,
    variantTitle: r.warehouse_product_variants.title,
    formatName: r.warehouse_product_variants.format_name,
    currentAvailable: r.available,
    countStatus: r.count_status ?? "idle",
  }));

  return {
    rows,
    total: count ?? 0,
    page: validated.page,
    pageSize: validated.pageSize,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write: bulk submission
// ─────────────────────────────────────────────────────────────────────────────

export type EntryStatus =
  | "applied"
  | "no_change"
  | "blocked_negative"
  | "requires_confirm"
  | "skipped_count_in_progress"
  | "unknown_sku"
  | "error";

export interface EntryResult {
  sku: string;
  status: EntryStatus;
  /** Reason text for non-applied statuses (e.g. 'high_delta', 'crosses_zero'). */
  reason?: string;
  /** Pre-write available value. */
  previousAvailable?: number;
  /** Post-write available value (delta-applied). Equal to previousAvailable on no_change. */
  newAvailable?: number;
  /** Signed delta actually written (only set when status === 'applied'). */
  delta?: number;
}

export interface SubmitManualInventoryCountsResult {
  batchId: string;
  appliedCount: number;
  noChangeCount: number;
  blockedCount: number;
  requiresConfirmCount: number;
  unknownCount: number;
  errorCount: number;
  results: EntryResult[];
}

export async function submitManualInventoryCounts(input: {
  orgId: string;
  entries: Array<{ sku: string; newAvailable: number; force?: boolean }>;
}): Promise<SubmitManualInventoryCountsResult> {
  const { userId, workspaceId } = await requireStaff();
  const validated = submitSchema.parse(input);

  const supabase = createServiceRoleClient();
  const batchId = crypto.randomUUID();

  // Pre-fetch current inventory for all SKUs in one query (avoid N+1).
  const skus = validated.entries.map((e) => e.sku);
  const { data: levels, error: levelsError } = await supabase
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
    .eq("workspace_id", workspaceId)
    .in("sku", skus);

  if (levelsError) {
    throw new Error(`Failed to pre-fetch inventory: ${levelsError.message}`);
  }

  type LevelRow = {
    sku: string;
    available: number;
    count_status: "idle" | "count_in_progress";
    warehouse_product_variants: { id: string; warehouse_products: { org_id: string } };
  };

  const levelMap = new Map<string, LevelRow>();
  for (const row of (levels as unknown as LevelRow[] | null) ?? []) {
    levelMap.set(row.sku, row);
  }

  const results: EntryResult[] = [];

  for (const entry of validated.entries) {
    const level = levelMap.get(entry.sku);

    if (!level) {
      results.push({ sku: entry.sku, status: "unknown_sku", reason: "sku_not_in_workspace" });
      continue;
    }

    if (level.warehouse_product_variants.warehouse_products.org_id !== validated.orgId) {
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
      // Defense in depth — Zod schema already rejects negative inputs.
      // The interesting case "would land negative" can't happen with absolute
      // set semantics; we keep the branch for symmetry with the count session
      // path that does delta-based math.
      await upsertNegativeBlockReview(supabase, {
        workspaceId,
        orgId: validated.orgId,
        sku: entry.sku,
        currentAvailable,
        attemptedNewAvailable: newAvailable,
        userId,
        batchId,
      });
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

    const correlationId = `manual-count:${userId}:${batchId}:${entry.sku}`;

    try {
      const writeResult = await recordInventoryChange({
        workspaceId,
        sku: entry.sku,
        delta,
        source: "manual_inventory_count",
        correlationId,
        metadata: {
          batch_id: batchId,
          counted_by: userId,
          org_id: validated.orgId,
          previous_available: currentAvailable,
          new_available: newAvailable,
          force: !!entry.force,
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

      // Fire-and-forget ShipStation v2 sync. Rule #48: never call v2 inline
      // from a Server Action. The task is queue-pinned and ledger-gated so
      // duplicate enqueues from retries are safe.
      try {
        const ssPayload: ShipstationV2AdjustOnSkuPayload = {
          workspaceId,
          sku: entry.sku,
          delta,
          correlationId,
          reason: "manual_inventory_count",
          metadata: {
            batch_id: batchId,
            counted_by: userId,
            org_id: validated.orgId,
            previous_available: currentAvailable,
            new_available: newAvailable,
          },
        };
        await tasks.trigger("shipstation-v2-adjust-on-sku", ssPayload);
      } catch (ssErr) {
        // Non-critical: Phase 5 reconcile sensor will catch the drift.
        // Log but don't fail the row — DB+Redis are already updated.
        console.error(
          `[submitManualInventoryCounts] failed to enqueue ShipStation v2 sync for ${entry.sku}:`,
          ssErr instanceof Error ? ssErr.message : ssErr,
        );
      }

      results.push({
        sku: entry.sku,
        status: "applied",
        previousAvailable: currentAvailable,
        newAvailable,
        delta,
      });
    } catch (err) {
      console.error(
        `[submitManualInventoryCounts] write failed for sku=${entry.sku}:`,
        err instanceof Error ? err.message : err,
      );
      results.push({
        sku: entry.sku,
        status: "error",
        reason: err instanceof Error ? err.message : "unknown",
        previousAvailable: currentAvailable,
        newAvailable,
      });
    }
  }

  return {
    batchId,
    appliedCount: results.filter((r) => r.status === "applied").length,
    noChangeCount: results.filter((r) => r.status === "no_change").length,
    blockedCount: results.filter((r) => r.status === "blocked_negative").length,
    requiresConfirmCount: results.filter((r) => r.status === "requires_confirm").length,
    unknownCount: results.filter((r) => r.status === "unknown_sku").length,
    errorCount: results.filter((r) => r.status === "error").length,
    results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: review queue upsert for negative-block events
// ─────────────────────────────────────────────────────────────────────────────

async function upsertNegativeBlockReview(
  supabase: ReturnType<typeof createServiceRoleClient>,
  params: {
    workspaceId: string;
    orgId: string;
    sku: string;
    currentAvailable: number;
    attemptedNewAvailable: number;
    userId: string;
    batchId: string;
  },
): Promise<void> {
  const groupKey = `manual-count.negative-block:${params.workspaceId}:${params.sku}`;
  const { error } = await supabase.from("warehouse_review_queue").upsert(
    {
      workspace_id: params.workspaceId,
      org_id: params.orgId,
      category: "manual_count_negative_block",
      severity: "high",
      title: `Manual count would land SKU ${params.sku} negative`,
      description:
        `Staff submitted a manual count of ${params.attemptedNewAvailable} for SKU ${params.sku}, ` +
        `but current available is ${params.currentAvailable}. The write was REJECTED. ` +
        `This usually indicates an upstream sync bug — investigate before allowing override.`,
      metadata: {
        sku: params.sku,
        current_available: params.currentAvailable,
        attempted_new_available: params.attemptedNewAvailable,
        attempted_by_user_id: params.userId,
        batch_id: params.batchId,
        source: "manual_inventory_count",
      },
      group_key: groupKey,
    },
    { onConflict: "group_key" },
  );

  if (error) {
    console.error(
      `[submitManualInventoryCounts] failed to upsert review queue item for ${params.sku}:`,
      error.message,
    );
  }
}
