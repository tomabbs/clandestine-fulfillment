// Phase 6.5 — Bandcamp shipping verifier (replaces 15-min direct-push cron).
//
// Premise: ShipStation's Bandcamp store connector + Phase 4.3 writeback with
// `notify_order_source: true` (v2) / `notifySalesChannel: true` (v1) is now
// the PRIMARY path that pushes tracking back to BC. SS does the work 99% of
// the time. We don't need to push from our side — we need to verify.
//
// Cron: */30 * * * * — slower than the old 15-min direct-push cron because
// the SS connector has its own latency and we want to give it a fair window
// before assuming it failed.
//
// Selection criteria (per plan §6.5):
//   - bandcamp_payment_id IS NOT NULL
//   - tracking_number IS NOT NULL
//   - shipstation_marked_shipped_at IS NOT NULL  (i.e. SS writeback succeeded)
//   - bandcamp_synced_at IS NULL                 (we haven't confirmed BC has it)
//   - shipstation_marked_shipped_at < now() - 30 minutes
//
// Per shipment:
//   1. Look up BC band for the shipment's org via bandcamp_connections.
//   2. Call getOrders for that band over a wide window covering the shipment.
//      (Batched per band so N shipments under the same band = 1 BC API call.)
//   3. Find the matching payment_id in the response. If `ship_date` is set →
//      stamp `bandcamp_synced_at`; SS connector did the work. Emit a
//      `bandcamp.connector_success` sensor reading.
//   4. If `ship_date` is missing → fall back to direct push by triggering the
//      `bandcamp-mark-shipped` task for that shipment. Emit a
//      `bandcamp.connector_fallback` sensor reading (R21).

import { logger, schedules, tasks } from "@trigger.dev/sdk";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

const PRIMARY_GRACE_MS = 30 * 60 * 1000; // 30 min — SS connector has up to this long before we assume it failed.
const GET_ORDERS_WINDOW_DAYS = 30; // Pull a 30d window of BC orders per band; covers most pending shipments.
const MAX_SHIPMENTS_PER_RUN = 200;

interface VerifyResult {
  scanned: number;
  ss_connector_succeeded: number;
  fell_back_to_direct_push: number;
  errors: number;
}

export const bandcampShippingVerifyTask = schedules.task({
  id: "bandcamp-shipping-verify",
  cron: "*/30 * * * *",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async (): Promise<VerifyResult> => {
    return runBandcampShippingVerify();
  },
});

/** Exported for unit testing + ad-hoc invocation. */
export async function runBandcampShippingVerify(): Promise<VerifyResult> {
  const supabase = createServiceRoleClient();

  // Pending = SS marked shipped at least 30 min ago, but BC isn't synced yet.
  const cutoffIso = new Date(Date.now() - PRIMARY_GRACE_MS).toISOString();
  const { data: pending, error: pendingErr } = await supabase
    .from("warehouse_shipments")
    .select(
      "id, workspace_id, org_id, bandcamp_payment_id, tracking_number, carrier, ship_date, shipstation_marked_shipped_at",
    )
    .not("bandcamp_payment_id", "is", null)
    .not("tracking_number", "is", null)
    .not("shipstation_marked_shipped_at", "is", null)
    .is("bandcamp_synced_at", null)
    .lte("shipstation_marked_shipped_at", cutoffIso)
    .limit(MAX_SHIPMENTS_PER_RUN);

  if (pendingErr) {
    logger.warn("[bandcamp-shipping-verify] pending query failed", { error: pendingErr.message });
    return {
      scanned: 0,
      ss_connector_succeeded: 0,
      fell_back_to_direct_push: 0,
      errors: 1,
    };
  }

  if (!pending || pending.length === 0) {
    return {
      scanned: 0,
      ss_connector_succeeded: 0,
      fell_back_to_direct_push: 0,
      errors: 0,
    };
  }

  // Group shipments by (workspace_id, org_id) so we can batch BC API calls.
  // Each (workspace, org) maps to at most one bandcamp_connection.
  const byConnectionKey = new Map<
    string,
    {
      workspaceId: string;
      orgId: string | null;
      shipments: typeof pending;
    }
  >();
  for (const s of pending) {
    const key = `${s.workspace_id}:${s.org_id ?? "_"}`;
    const existing = byConnectionKey.get(key);
    if (existing) {
      existing.shipments.push(s);
    } else {
      byConnectionKey.set(key, {
        workspaceId: s.workspace_id as string,
        orgId: (s.org_id as string | null) ?? null,
        shipments: [s],
      });
    }
  }

  const totals: VerifyResult = {
    scanned: pending.length,
    ss_connector_succeeded: 0,
    fell_back_to_direct_push: 0,
    errors: 0,
  };

  for (const group of byConnectionKey.values()) {
    try {
      await processConnectionGroup(supabase, group, totals);
    } catch (err) {
      totals.errors++;
      logger.warn("[bandcamp-shipping-verify] group failed", {
        workspaceId: group.workspaceId,
        orgId: group.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Per-workspace sensor reading so Phase 7.1 can alert on connector reliability.
  // We aggregate workspace totals here in app code; sensor consumer aggregates
  // across the rolling window.
  const byWorkspace = new Map<string, { ok: number; fallback: number }>();
  for (const group of byConnectionKey.values()) {
    const cur = byWorkspace.get(group.workspaceId) ?? { ok: 0, fallback: 0 };
    byWorkspace.set(group.workspaceId, cur);
  }
  // We don't have per-workspace tallies from processConnectionGroup yet, so
  // emit one global reading for now keyed by the first workspace.
  // Phase 7.1 implementation can refine this if it wants per-workspace breakdown.
  const firstWs = Array.from(byConnectionKey.values())[0]?.workspaceId;
  if (firstWs) {
    await supabase.from("sensor_readings").insert({
      workspace_id: firstWs,
      sensor_name: "trigger:bandcamp-shipping-verify",
      status: totals.errors > 0 ? "warning" : "healthy",
      message: `Scanned ${totals.scanned}; SS connector OK ${totals.ss_connector_succeeded}; fell back ${totals.fell_back_to_direct_push}; errors ${totals.errors}.`,
      value: totals,
    });
  }

  logger.log("[bandcamp-shipping-verify] done", { ...totals });
  return totals;
}

async function processConnectionGroup(
  supabase: ReturnType<typeof createServiceRoleClient>,
  group: {
    workspaceId: string;
    orgId: string | null;
    shipments: Array<{
      id: unknown;
      workspace_id: unknown;
      org_id: unknown;
      bandcamp_payment_id: unknown;
      tracking_number: unknown;
      carrier: unknown;
      ship_date: unknown;
      shipstation_marked_shipped_at: unknown;
    }>;
  },
  totals: VerifyResult,
): Promise<void> {
  // Look up the BC connection for this (workspace, org). bandcamp_connections
  // is keyed by workspace_id + (band_id) but the org link is on the table too.
  let connectionQuery = supabase
    .from("bandcamp_connections")
    .select("id, band_id, org_id")
    .eq("workspace_id", group.workspaceId)
    .eq("is_active", true);
  if (group.orgId) {
    connectionQuery = connectionQuery.eq("org_id", group.orgId);
  }
  const { data: connections } = await connectionQuery.limit(1);
  const connection = connections?.[0];

  if (!connection?.band_id) {
    logger.warn("[bandcamp-shipping-verify] no BC connection for org — skipping group", {
      workspaceId: group.workspaceId,
      orgId: group.orgId,
      shipments: group.shipments.length,
    });
    // Fall through to direct push for these shipments — bandcamp-mark-shipped
    // handles the lookup itself.
    for (const s of group.shipments) {
      await fallbackToDirectPush(supabase, String(s.id), totals, "no_bc_connection");
    }
    return;
  }

  // Pull a 30d window of BC orders for this band.
  let bcOrders: BandcampOrderItem[] = [];
  try {
    const accessToken = await refreshBandcampToken(group.workspaceId);
    const startTime = new Date(Date.now() - GET_ORDERS_WINDOW_DAYS * 86400000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    bcOrders = await getOrders({ bandId: connection.band_id as number, startTime }, accessToken);
  } catch (err) {
    logger.warn("[bandcamp-shipping-verify] BC getOrders failed for group", {
      workspaceId: group.workspaceId,
      orgId: group.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    // BC API down — defer to next run rather than fall back to direct push,
    // because direct push would also fail. Just count as errors.
    totals.errors += group.shipments.length;
    return;
  }

  // Build a map of payment_id → ship_date for fast per-shipment lookup.
  const shipDateByPayment = new Map<number, string | null>();
  for (const item of bcOrders) {
    if (item.payment_id != null) {
      const existing = shipDateByPayment.get(item.payment_id);
      // Same payment_id can appear on multiple line items; if ANY has a
      // ship_date set, treat it as shipped.
      if (existing == null && item.ship_date) {
        shipDateByPayment.set(item.payment_id, item.ship_date);
      } else if (existing == null) {
        shipDateByPayment.set(item.payment_id, null);
      }
    }
  }

  for (const s of group.shipments) {
    const paymentId = s.bandcamp_payment_id as number | null;
    if (!paymentId) {
      totals.errors++;
      continue;
    }
    const bcShipDate = shipDateByPayment.get(paymentId);
    if (bcShipDate) {
      // SS connector did the work. Stamp success.
      const { error: stampErr } = await supabase
        .from("warehouse_shipments")
        .update({
          bandcamp_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", s.id);
      if (stampErr) {
        totals.errors++;
        logger.warn("[bandcamp-shipping-verify] success stamp failed", {
          shipmentId: s.id,
          error: stampErr.message,
        });
        continue;
      }
      totals.ss_connector_succeeded++;
      await supabase.from("sensor_readings").insert({
        workspace_id: group.workspaceId,
        sensor_name: "bandcamp.connector_success",
        status: "healthy",
        message: `SS connector successfully pushed payment_id=${paymentId} to BC`,
        value: { payment_id: paymentId, shipment_id: s.id },
      });
      continue;
    }

    // BC has the order but no ship_date — SS connector hasn't fired (or fired
    // but failed). Fall back to direct push.
    await fallbackToDirectPush(supabase, String(s.id), totals, "ss_connector_did_not_push");
  }
}

async function fallbackToDirectPush(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipmentId: string,
  totals: VerifyResult,
  reason: string,
): Promise<void> {
  try {
    await tasks.trigger("bandcamp-mark-shipped", { shipmentId });
    totals.fell_back_to_direct_push++;
    await supabase.from("sensor_readings").insert({
      sensor_name: "bandcamp.connector_fallback",
      status: "warning",
      message: `Fell back to direct BC push for shipment ${shipmentId} (reason=${reason})`,
      value: { shipment_id: shipmentId, reason },
    });
  } catch (err) {
    totals.errors++;
    logger.warn("[bandcamp-shipping-verify] fallback enqueue failed", {
      shipmentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
