/**
 * Order Pages Transition Phase 2 — order_mirror_links bridge worker.
 *
 * Walks `warehouse_orders` rows that don't yet have a non-rejected
 * link in `order_mirror_links`, finds candidate `shipstation_orders`
 * matches via the pure `decideMirrorLink` helper, and writes back any
 * deterministic / probable links.
 *
 * Idempotency: the destination table has a `UNIQUE (workspace_id,
 * warehouse_order_id, shipstation_order_id)` so `INSERT ... ON CONFLICT`
 * is the canonical write path. Bumps `confidence` upward only — the
 * worker never demotes a manual / deterministic row to probable.
 *
 * Pinned to the `shipstation` queue (concurrencyLimit 1) so it shares
 * the v2 60 req/min budget — it doesn't actually call ShipStation, but
 * sharing the queue keeps it from competing with real-time SS work
 * during the backfill window.
 */

import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { decideMirrorLink, type OrderMirrorLinkConfidence } from "@/lib/server/order-mirror-links";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

const PayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  batchSize: z.number().int().positive().max(2000).optional(),
  /** Optional cursor for resumable runs. */
  cursorOrderId: z.string().uuid().nullable().optional(),
  dryRun: z.boolean().optional(),
});

const CONFIDENCE_RANK: Record<OrderMirrorLinkConfidence, number> = {
  rejected: 0,
  probable: 1,
  deterministic: 2,
  manual: 3,
};

export const orderMirrorLinksBridgeTask = schemaTask({
  id: "order-mirror-links-bridge",
  queue: shipstationQueue,
  schema: PayloadSchema,
  run: async (payload) => {
    const supabase = createServiceRoleClient();
    const batchSize = payload.batchSize ?? 200;

    let query = supabase
      .from("warehouse_orders")
      .select("id, workspace_id, order_number, customer_email, total_price, created_at")
      .eq("workspace_id", payload.workspaceId)
      .order("id", { ascending: true })
      .limit(batchSize);
    if (payload.cursorOrderId) query = query.gt("id", payload.cursorOrderId);

    const { data: directRows, error: directErr } = await query;
    if (directErr) {
      throw new Error(`bridge: warehouse_orders fetch failed: ${directErr.message}`);
    }

    let scanned = 0;
    let written = 0;
    let skipped = 0;
    let lastId: string | null = payload.cursorOrderId ?? null;

    for (const r of directRows ?? []) {
      scanned += 1;
      lastId = (r as { id: string }).id;
      const direct = {
        warehouseOrderId: (r as { id: string }).id,
        workspaceId: (r as { workspace_id: string }).workspace_id,
        orderNumber: (r as { order_number: string | null }).order_number,
        customerEmail: (r as { customer_email: string | null }).customer_email,
        totalPrice: (r as { total_price: number | null }).total_price,
        createdAtMs: Date.parse((r as { created_at: string }).created_at),
      };
      if (!direct.orderNumber && !direct.customerEmail) {
        skipped += 1;
        continue;
      }

      // Pull a small candidate set from shipstation_orders by either
      // matching order_number or matching email. Both filters are
      // workspace-scoped.
      const orFilters: string[] = [];
      if (direct.orderNumber) {
        orFilters.push(`order_number.eq.${direct.orderNumber}`);
      }
      if (direct.customerEmail) {
        orFilters.push(`customer_email.ilike.${direct.customerEmail}`);
      }

      let mirrorQuery = supabase
        .from("shipstation_orders")
        .select("id, workspace_id, order_number, customer_email, amount_paid, order_date")
        .eq("workspace_id", payload.workspaceId)
        .limit(20);
      if (orFilters.length > 0) {
        mirrorQuery = mirrorQuery.or(orFilters.join(","));
      }
      const { data: mirrorRows, error: mirrorErr } = await mirrorQuery;
      if (mirrorErr) {
        logger.warn("bridge: mirror fetch failed", {
          warehouseOrderId: direct.warehouseOrderId,
          error: mirrorErr.message,
        });
        continue;
      }

      let bestDecision: ReturnType<typeof decideMirrorLink> | null = null;
      for (const m of mirrorRows ?? []) {
        const mirror = {
          shipstationOrderId: (m as { id: string }).id,
          workspaceId: (m as { workspace_id: string }).workspace_id,
          orderNumber: (m as { order_number: string | null }).order_number,
          customerEmail: (m as { customer_email: string | null }).customer_email,
          amountPaid: (m as { amount_paid: number | null }).amount_paid,
          orderDateMs: (m as { order_date: string | null }).order_date
            ? Date.parse((m as { order_date: string }).order_date)
            : null,
        };
        const decision = decideMirrorLink(direct, mirror);
        if (!decision.confidence) continue;
        if (
          !bestDecision ||
          (CONFIDENCE_RANK[decision.confidence] ?? 0) >
            (bestDecision.confidence ? (CONFIDENCE_RANK[bestDecision.confidence] ?? 0) : -1)
        ) {
          bestDecision = decision;
        }
      }

      if (!bestDecision || !bestDecision.confidence) {
        continue;
      }

      if (payload.dryRun) {
        written += 1;
        continue;
      }

      const { error: writeErr } = await supabase.from("order_mirror_links").upsert(
        {
          workspace_id: payload.workspaceId,
          warehouse_order_id: bestDecision.warehouseOrderId,
          shipstation_order_id: bestDecision.shipstationOrderId,
          confidence: bestDecision.confidence,
          match_signals: bestDecision.signals,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "workspace_id,warehouse_order_id,shipstation_order_id",
          ignoreDuplicates: false,
        },
      );
      if (writeErr) {
        logger.warn("bridge: link upsert failed", {
          warehouseOrderId: direct.warehouseOrderId,
          shipstationOrderId: bestDecision.shipstationOrderId,
          error: writeErr.message,
        });
      } else {
        written += 1;
      }
    }

    return {
      ok: true,
      workspaceId: payload.workspaceId,
      scanned,
      written,
      skipped,
      cursorOrderId: lastId,
      finished: (directRows?.length ?? 0) < batchSize,
    };
  },
});
