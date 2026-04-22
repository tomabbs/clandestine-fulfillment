// Phase 6.5 + Phase 5 (HRD-11) — Bandcamp shipping verifier (per-workspace polarity).
//
// Two execution modes, gated per-workspace by `workspaces.bc_verify_direct_primary`:
//
// LEGACY mode (`bc_verify_direct_primary = false`, the default):
//   ShipStation's Bandcamp store connector + Phase 4.3 writeback with
//   `notify_order_source: true` (v2) / `notifySalesChannel: true` (v1) is the
//   PRIMARY path. We wait for SS to mark the shipment, then verify on the BC
//   side. Selection requires `shipstation_marked_shipped_at IS NOT NULL` and
//   that timestamp >= 30 min old. If BC shows the order shipped, we stamp
//   success; if not, we fall back to direct push (treated as an alarm —
//   `bandcamp.connector_fallback`).
//
// DIRECT-PRIMARY mode (`bc_verify_direct_primary = true`, HRD-11):
//   Direct push to Bandcamp is the PRIMARY path. We no longer wait on the
//   SS connector. Selection drops the `shipstation_marked_shipped_at` filter;
//   any shipment with `bandcamp_payment_id` + `tracking_number` whose
//   `bandcamp_synced_at IS NULL` and whose `created_at` is at least 5 min old
//   (small grace window so the inline post-label-purchase push has a chance
//   to land first) is a candidate. We still BC-API-check first — if BC
//   already shows shipped (because the SS connector beat us OR because the
//   inline push landed in the same second), we stamp success without
//   re-pushing. Otherwise we enqueue `bandcamp-mark-shipped` — and emit a
//   `bandcamp.direct_primary_push` sensor reading (HEALTHY status, since
//   this is the EXPECTED path under direct-primary).
//
// Cron: */30 * * * * — keeps the existing cadence; the BC API call is the
// rate-limited side, not the cron.
//
// Per-workspace flip is operator-controlled via `flipBandcampPrimaryToDirect`
// Server Action (HRD-11.1) which hard-checks (a) 48 h of SS quiet on that
// workspace's open shipments AND (b) `shipstation_sync_paused = true`.
// Per-workspace rollback: flip back to `false` to restore legacy behavior
// for that workspace alone.

import { logger, schedules, tasks } from "@trigger.dev/sdk";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

const PRIMARY_GRACE_MS = 30 * 60 * 1000; // Legacy mode: SS connector has up to this long before we assume it failed.
const DIRECT_PRIMARY_GRACE_MS = 5 * 60 * 1000; // Direct-primary mode: small grace so the inline push can land first.
const GET_ORDERS_WINDOW_DAYS = 30; // Pull a 30d window of BC orders per band; covers most pending shipments.
const MAX_SHIPMENTS_PER_RUN = 200;

interface VerifyResult {
  scanned: number;
  /** Legacy mode: SS connector pushed and BC has ship_date. */
  ss_connector_succeeded: number;
  /** Legacy mode: SS connector did not push (alarm); we are pushing directly. */
  fell_back_to_direct_push: number;
  /** Direct-primary mode: BC already showed shipped, no push needed. */
  direct_primary_already_shipped: number;
  /** Direct-primary mode: enqueued direct push (the expected path). */
  direct_primary_pushed: number;
  errors: number;
  /** Number of workspaces processed under direct-primary polarity. */
  workspaces_direct_primary: number;
  /** Number of workspaces processed under legacy SS-primary polarity. */
  workspaces_legacy: number;
}

type ShipmentRow = {
  id: unknown;
  workspace_id: unknown;
  org_id: unknown;
  bandcamp_payment_id: unknown;
  tracking_number: unknown;
  carrier: unknown;
  ship_date: unknown;
  shipstation_marked_shipped_at: unknown;
};

type TaggedShipment = ShipmentRow & { _directPrimary: boolean };

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

  // Phase 5 (HRD-11): determine which workspaces have flipped polarity.
  const { data: dpWorkspaces, error: dpErr } = await supabase
    .from("workspaces")
    .select("id")
    .eq("bc_verify_direct_primary", true);
  if (dpErr) {
    logger.warn("[bandcamp-shipping-verify] direct-primary workspace lookup failed", {
      error: dpErr.message,
    });
  }
  const directPrimarySet = new Set<string>((dpWorkspaces ?? []).map((row) => row.id as string));
  const directPrimaryIds = Array.from(directPrimarySet);

  // Legacy selection: workspaces NOT in directPrimarySet, where SS connector
  // marked the shipment at least 30 min ago and BC is still unsynced.
  const ssCutoffIso = new Date(Date.now() - PRIMARY_GRACE_MS).toISOString();
  let legacyQuery = supabase
    .from("warehouse_shipments")
    .select(
      "id, workspace_id, org_id, bandcamp_payment_id, tracking_number, carrier, ship_date, shipstation_marked_shipped_at",
    )
    .not("bandcamp_payment_id", "is", null)
    .not("tracking_number", "is", null)
    .not("shipstation_marked_shipped_at", "is", null)
    .is("bandcamp_synced_at", null)
    .lte("shipstation_marked_shipped_at", ssCutoffIso)
    .limit(MAX_SHIPMENTS_PER_RUN);
  if (directPrimaryIds.length > 0) {
    // PostgREST `not.in` syntax: surround the list in parentheses.
    legacyQuery = legacyQuery.not("workspace_id", "in", `(${directPrimaryIds.join(",")})`);
  }
  const { data: legacyRows, error: legacyErr } = await legacyQuery;

  if (legacyErr) {
    logger.warn("[bandcamp-shipping-verify] legacy query failed", { error: legacyErr.message });
    return emptyResult(1);
  }

  // Direct-primary selection: workspaces IN directPrimarySet, drop the SS
  // filter, only require a 5-min grace window since shipment creation so the
  // inline post-label-purchase push has a fair chance to land first.
  let directPrimaryRows: ShipmentRow[] = [];
  if (directPrimaryIds.length > 0) {
    const dpCutoffIso = new Date(Date.now() - DIRECT_PRIMARY_GRACE_MS).toISOString();
    const { data: dpRows, error: dpRowsErr } = await supabase
      .from("warehouse_shipments")
      .select(
        "id, workspace_id, org_id, bandcamp_payment_id, tracking_number, carrier, ship_date, shipstation_marked_shipped_at, created_at",
      )
      .not("bandcamp_payment_id", "is", null)
      .not("tracking_number", "is", null)
      .is("bandcamp_synced_at", null)
      .lte("created_at", dpCutoffIso)
      .in("workspace_id", directPrimaryIds)
      .limit(MAX_SHIPMENTS_PER_RUN);
    if (dpRowsErr) {
      logger.warn("[bandcamp-shipping-verify] direct-primary query failed", {
        error: dpRowsErr.message,
      });
      return emptyResult(1);
    }
    directPrimaryRows = (dpRows ?? []) as ShipmentRow[];
  }

  const tagged: TaggedShipment[] = [
    ...((legacyRows ?? []) as ShipmentRow[]).map((r) => ({ ...r, _directPrimary: false })),
    ...directPrimaryRows.map((r) => ({ ...r, _directPrimary: true })),
  ];

  if (tagged.length === 0) {
    return emptyResult(0);
  }

  // Group shipments by (workspace_id, org_id) so we can batch BC API calls.
  // Each (workspace, org) maps to at most one bandcamp_connection. Polarity
  // is workspace-level so all shipments in a group share the same flag.
  const byConnectionKey = new Map<
    string,
    {
      workspaceId: string;
      orgId: string | null;
      directPrimary: boolean;
      shipments: TaggedShipment[];
    }
  >();
  for (const s of tagged) {
    const key = `${s.workspace_id}:${s.org_id ?? "_"}`;
    const existing = byConnectionKey.get(key);
    if (existing) {
      existing.shipments.push(s);
    } else {
      byConnectionKey.set(key, {
        workspaceId: s.workspace_id as string,
        orgId: (s.org_id as string | null) ?? null,
        directPrimary: s._directPrimary,
        shipments: [s],
      });
    }
  }

  const totals: VerifyResult = {
    scanned: tagged.length,
    ss_connector_succeeded: 0,
    fell_back_to_direct_push: 0,
    direct_primary_already_shipped: 0,
    direct_primary_pushed: 0,
    errors: 0,
    workspaces_direct_primary: 0,
    workspaces_legacy: 0,
  };

  // Per-workspace tallies for the per-workspace sensor reading below.
  const byWorkspace = new Map<
    string,
    {
      directPrimary: boolean;
      scanned: number;
      ssConnectorOk: number;
      fellBack: number;
      directAlreadyShipped: number;
      directPushed: number;
      errors: number;
    }
  >();

  for (const group of byConnectionKey.values()) {
    const wsTally = byWorkspace.get(group.workspaceId) ?? {
      directPrimary: group.directPrimary,
      scanned: 0,
      ssConnectorOk: 0,
      fellBack: 0,
      directAlreadyShipped: 0,
      directPushed: 0,
      errors: 0,
    };
    const beforeOk = totals.ss_connector_succeeded;
    const beforeFb = totals.fell_back_to_direct_push;
    const beforeDpOk = totals.direct_primary_already_shipped;
    const beforeDpPush = totals.direct_primary_pushed;
    const beforeErr = totals.errors;

    try {
      await processConnectionGroup(supabase, group, totals);
    } catch (err) {
      totals.errors++;
      logger.warn("[bandcamp-shipping-verify] group failed", {
        workspaceId: group.workspaceId,
        orgId: group.orgId,
        directPrimary: group.directPrimary,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    wsTally.scanned += group.shipments.length;
    wsTally.ssConnectorOk += totals.ss_connector_succeeded - beforeOk;
    wsTally.fellBack += totals.fell_back_to_direct_push - beforeFb;
    wsTally.directAlreadyShipped += totals.direct_primary_already_shipped - beforeDpOk;
    wsTally.directPushed += totals.direct_primary_pushed - beforeDpPush;
    wsTally.errors += totals.errors - beforeErr;
    byWorkspace.set(group.workspaceId, wsTally);

    if (group.directPrimary) {
      totals.workspaces_direct_primary++;
    } else {
      totals.workspaces_legacy++;
    }
  }

  // Per-workspace sensor reading so Phase 7.1 (channel health) can alert on
  // either polarity slipping. Direct-primary workspaces should see push>0 +
  // errors=0 as healthy steady state; legacy workspaces should see fellBack=0.
  const sensorRows = Array.from(byWorkspace.entries()).map(([wsId, t]) => ({
    workspace_id: wsId,
    sensor_name: "trigger:bandcamp-shipping-verify",
    status: t.errors > 0 ? "warning" : "healthy",
    message: t.directPrimary
      ? `direct-primary: scanned=${t.scanned}, BC-already-shipped=${t.directAlreadyShipped}, pushed=${t.directPushed}, errors=${t.errors}`
      : `legacy: scanned=${t.scanned}, SS-ok=${t.ssConnectorOk}, fell-back=${t.fellBack}, errors=${t.errors}`,
    value: { ...t },
  }));
  if (sensorRows.length > 0) {
    await supabase.from("sensor_readings").insert(sensorRows);
  }

  logger.log("[bandcamp-shipping-verify] done", { ...totals });
  return totals;
}

function emptyResult(errors: number): VerifyResult {
  return {
    scanned: 0,
    ss_connector_succeeded: 0,
    fell_back_to_direct_push: 0,
    direct_primary_already_shipped: 0,
    direct_primary_pushed: 0,
    errors,
    workspaces_direct_primary: 0,
    workspaces_legacy: 0,
  };
}

async function processConnectionGroup(
  supabase: ReturnType<typeof createServiceRoleClient>,
  group: {
    workspaceId: string;
    orgId: string | null;
    directPrimary: boolean;
    shipments: TaggedShipment[];
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
      await enqueueDirectPush(
        supabase,
        group.workspaceId,
        String(s.id),
        totals,
        group.directPrimary,
        "no_bc_connection",
      );
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
      // BC already shows shipped. Stamp synced and skip the push.
      // - Legacy mode: SS connector did the work (the original Phase 6.5 happy path).
      // - Direct-primary mode: either the inline post-label-purchase push beat
      //   us, or the SS connector still happened to fire — either way, no need
      //   to push again.
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
          directPrimary: group.directPrimary,
          error: stampErr.message,
        });
        continue;
      }
      if (group.directPrimary) {
        totals.direct_primary_already_shipped++;
        await supabase.from("sensor_readings").insert({
          workspace_id: group.workspaceId,
          sensor_name: "bandcamp.direct_primary_already_shipped",
          status: "healthy",
          message: `BC already shows shipped for payment_id=${paymentId} (direct-primary; nothing to push)`,
          value: { payment_id: paymentId, shipment_id: s.id },
        });
      } else {
        totals.ss_connector_succeeded++;
        await supabase.from("sensor_readings").insert({
          workspace_id: group.workspaceId,
          sensor_name: "bandcamp.connector_success",
          status: "healthy",
          message: `SS connector successfully pushed payment_id=${paymentId} to BC`,
          value: { payment_id: paymentId, shipment_id: s.id },
        });
      }
      continue;
    }

    // BC has the order but no ship_date.
    // - Legacy mode: SS connector hasn't fired (or fired but failed) → fall
    //   back to direct push as an alarm.
    // - Direct-primary mode: this is the EXPECTED path. Enqueue the direct
    //   push and emit a healthy sensor reading.
    await enqueueDirectPush(
      supabase,
      group.workspaceId,
      String(s.id),
      totals,
      group.directPrimary,
      group.directPrimary ? "direct_primary_push" : "ss_connector_did_not_push",
    );
  }
}

async function enqueueDirectPush(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  shipmentId: string,
  totals: VerifyResult,
  directPrimary: boolean,
  reason: string,
): Promise<void> {
  try {
    await tasks.trigger("bandcamp-mark-shipped", { shipmentId });
    if (directPrimary) {
      totals.direct_primary_pushed++;
      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "bandcamp.direct_primary_push",
        status: "healthy",
        message: `Enqueued direct BC push for shipment ${shipmentId} (direct-primary; reason=${reason})`,
        value: { shipment_id: shipmentId, reason },
      });
    } else {
      totals.fell_back_to_direct_push++;
      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "bandcamp.connector_fallback",
        status: "warning",
        message: `Fell back to direct BC push for shipment ${shipmentId} (reason=${reason})`,
        value: { shipment_id: shipmentId, reason },
      });
    }
  } catch (err) {
    totals.errors++;
    logger.warn("[bandcamp-shipping-verify] direct push enqueue failed", {
      shipmentId,
      directPrimary,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
