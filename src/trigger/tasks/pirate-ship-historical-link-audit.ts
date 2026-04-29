/**
 * Order Pages Transition Phase 0 — historical Pirate Ship link audit.
 *
 * One-shot (per-workspace) audit that flags `warehouse_shipments` rows
 * where the parent `warehouse_orders.created_at` is more than 180 days
 * BEFORE the shipment's effective ship date. These are the residual
 * shipments that were linked under the old order-number-only matcher
 * before the temporal-window matcher landed (Phase 5 of the plan).
 *
 * Design contract (plan §"Pirate Ship historical audit"):
 *   - NEVER auto-unlink. Mislinked shipments may be referenced by live
 *     customer tracking links; auto-unlinking would 404 the customer.
 *   - Surface every candidate as a `warehouse_review_queue` row with
 *     `category = 'pirate_ship_potential_mislink'`, `severity='medium'`,
 *     `group_key = 'pirate-ship-mislink:{workspace}:{shipmentId}'` so a
 *     re-run is idempotent. Ops manually unlinks after customer outreach.
 *   - Pinned to the `shipstation` queue (concurrencyLimit: 1) — same
 *     queue as the other ShipStation/Pirate-Ship reconcile work so the
 *     audit cannot starve real-time fulfillment.
 *   - Idempotent: re-running on the same workspace will NOT create
 *     duplicate review rows (group_key + occurrence_count via the
 *     existing review-queue pattern).
 *
 * Deferred (intentionally out of Phase 0 scope):
 *   - Auto-relink to a better candidate order. Phase 5 introduces the
 *     temporal-window matcher; this audit only surfaces the suspect
 *     legacy rows.
 */

import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

const PayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Window in days before the shipment date. Defaults to 180. */
  skewDays: z.number().int().positive().max(3650).optional(),
  /** Cap on rows examined per run (per-workspace). Defaults to 5_000. */
  limit: z.number().int().positive().max(50_000).optional(),
  /** When true, only count candidates without writing review rows. */
  dryRun: z.boolean().optional(),
});

export const pirateShipHistoricalLinkAuditTask = schemaTask({
  id: "pirate-ship-historical-link-audit",
  queue: shipstationQueue,
  schema: PayloadSchema,
  run: async (payload) => {
    const supabase = createServiceRoleClient();
    const skewDays = payload.skewDays ?? 180;
    const skewMs = skewDays * 86_400_000;
    const limit = payload.limit ?? 5_000;
    const dryRun = payload.dryRun ?? false;

    const cutoffIso = new Date(Date.now() - skewMs).toISOString();

    const { data, error } = await supabase
      .from("warehouse_shipments")
      .select(
        "id, workspace_id, ship_date, created_at, order_id, tracking_number, label_source, warehouse_orders(id, created_at, order_number)",
      )
      .eq("workspace_id", payload.workspaceId)
      .eq("label_source", "pirate_ship")
      .not("order_id", "is", null)
      .lt("created_at", cutoffIso)
      .limit(limit);

    if (error) {
      logger.error("pirate-ship-historical-link-audit fetch failed", { error: error.message });
      throw new Error(`fetch failed: ${error.message}`);
    }

    let scanned = 0;
    let candidates = 0;
    let written = 0;
    let writeErrors = 0;

    for (const row of data ?? []) {
      scanned += 1;
      const r = row as {
        id: string;
        ship_date: string | null;
        created_at: string;
        order_id: string;
        tracking_number: string | null;
        warehouse_orders:
          | { id: string; created_at: string; order_number: string | null }
          | { id: string; created_at: string; order_number: string | null }[]
          | null;
      };
      const orderRow = Array.isArray(r.warehouse_orders)
        ? r.warehouse_orders[0]
        : r.warehouse_orders;
      if (!orderRow?.created_at) continue;
      const shipMs = Date.parse(r.ship_date ?? r.created_at);
      const orderMs = Date.parse(orderRow.created_at);
      if (Number.isNaN(shipMs) || Number.isNaN(orderMs)) continue;
      const skew = shipMs - orderMs;
      if (skew <= skewMs) continue;
      candidates += 1;
      if (dryRun) continue;

      const groupKey = `pirate-ship-mislink:${payload.workspaceId}:${r.id}`;

      // Use UPSERT-like upsert via group_key uniqueness pattern. The review
      // queue table doesn't have a UNIQUE on group_key, so we manually
      // dedupe with a head-only existence check. Re-running this task is
      // therefore O(scanned) DB reads but never creates a duplicate row.
      const { data: existing, error: existErr } = await supabase
        .from("warehouse_review_queue")
        .select("id, occurrence_count")
        .eq("workspace_id", payload.workspaceId)
        .eq("category", "pirate_ship_potential_mislink")
        .eq("group_key", groupKey)
        .maybeSingle();
      if (existErr) {
        writeErrors += 1;
        continue;
      }
      if (existing) {
        const { error: updateErr } = await supabase
          .from("warehouse_review_queue")
          .update({
            occurrence_count: (existing.occurrence_count ?? 1) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        if (updateErr) writeErrors += 1;
        continue;
      }

      const { error: insertErr } = await supabase.from("warehouse_review_queue").insert({
        workspace_id: payload.workspaceId,
        category: "pirate_ship_potential_mislink",
        severity: "medium",
        title: "Pirate Ship shipment may be mislinked to an old order",
        description:
          `Shipment ${r.id} (Pirate Ship) is linked to an order created ` +
          `${Math.floor(skew / 86_400_000)} days before the shipment date. Likely ` +
          `the legacy order-number-only matcher picked the wrong parent. Verify ` +
          `before unlinking — customer tracking links may reference this shipment.`,
        status: "open",
        group_key: groupKey,
        metadata: {
          shipment_id: r.id,
          tracking_number: r.tracking_number,
          ship_date: r.ship_date,
          shipment_created_at: r.created_at,
          order_id: r.order_id,
          order_created_at: orderRow.created_at,
          order_number: orderRow.order_number,
          skew_days: Math.floor(skew / 86_400_000),
          skew_threshold_days: skewDays,
          audit_task: "pirate-ship-historical-link-audit",
        },
      });
      if (insertErr) {
        writeErrors += 1;
      } else {
        written += 1;
      }
    }

    logger.info("pirate-ship-historical-link-audit completed", {
      workspaceId: payload.workspaceId,
      skewDays,
      limit,
      scanned,
      candidates,
      written,
      writeErrors,
      dryRun,
    });

    return {
      workspaceId: payload.workspaceId,
      skewDays,
      limit,
      dryRun,
      scanned,
      candidates,
      written,
      writeErrors,
    };
  },
});
