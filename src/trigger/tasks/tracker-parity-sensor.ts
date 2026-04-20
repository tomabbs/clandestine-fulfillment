// Phase 10.5 prep — Daily AfterShip vs EasyPost tracker parity sensor.
//
// Compares per-shipment event counts over the last 30 days between the two
// tracking sources. Goal: confirm EP coverage matches or exceeds AfterShip
// BEFORE we sunset AfterShip (Phase 10.5 final step).
//
// Cron: 03:30 UTC daily. Emits ONE sensor reading per workspace with a
// breakdown of:
//   - shipments where EP-only events exist (AS missed; that's a WIN for EP)
//   - shipments where AS-only events exist (EP missed; investigate before sunset)
//   - shipments where both have events
//   - shipments where neither has events (shipment in pre-transit; expected)
//
// We do NOT block anything based on this sensor — it's purely diagnostic.
// The Phase 10.5 sunset gate consults this sensor's last 30 days of
// readings: if the AS-only count stays > 0 for any meaningful slice of
// active shipments, defer the sunset.

import { logger, schedules } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const WINDOW_DAYS = 30;

interface PerWorkspaceCounts {
  workspace_id: string;
  shipments_in_window: number;
  shipments_with_aftership_events: number;
  shipments_with_easypost_events: number;
  shipments_with_both: number;
  shipments_aftership_only: number;
  shipments_easypost_only: number;
  shipments_neither: number;
  parity_score: number; // (both / shipments_with_any_event) — 1.0 = perfect parity
}

export const trackerParitySensorTask = schedules.task({
  id: "tracker-parity-sensor",
  cron: "30 3 * * *",
  maxDuration: 180,
  run: async (): Promise<{ workspaces: PerWorkspaceCounts[] }> => {
    const supabase = createServiceRoleClient();
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

    const { data: workspaces } = await supabase.from("workspaces").select("id");
    const out: PerWorkspaceCounts[] = [];

    for (const ws of workspaces ?? []) {
      const counts = await scoreWorkspace(supabase, ws.id as string, sinceIso);
      out.push(counts);
      // Flag any workspace where AS is finding events EP missed — that's the
      // condition that blocks Phase 10.5 sunset.
      const status: "healthy" | "warning" =
        counts.shipments_aftership_only > 0 ? "warning" : "healthy";
      await supabase.from("sensor_readings").insert({
        workspace_id: ws.id,
        sensor_name: "tracker.parity_aftership_vs_easypost",
        status,
        message:
          `Last ${WINDOW_DAYS}d: ${counts.shipments_in_window} shipments; ` +
          `AS=${counts.shipments_with_aftership_events}, EP=${counts.shipments_with_easypost_events}, ` +
          `both=${counts.shipments_with_both}, AS-only=${counts.shipments_aftership_only}, ` +
          `EP-only=${counts.shipments_easypost_only}, neither=${counts.shipments_neither}, ` +
          `parity=${counts.parity_score.toFixed(3)}`,
        value: counts,
      });
    }

    logger.log("[tracker-parity-sensor] done", { workspaces: out.length });
    return { workspaces: out };
  },
});

async function scoreWorkspace(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  sinceIso: string,
): Promise<PerWorkspaceCounts> {
  const { data: shipments } = await supabase
    .from("warehouse_shipments")
    .select("id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", sinceIso)
    .not("tracking_number", "is", null)
    .limit(5000);

  const shipmentIds = (shipments ?? []).map((r) => r.id as string);
  if (shipmentIds.length === 0) {
    return {
      workspace_id: workspaceId,
      shipments_in_window: 0,
      shipments_with_aftership_events: 0,
      shipments_with_easypost_events: 0,
      shipments_with_both: 0,
      shipments_aftership_only: 0,
      shipments_easypost_only: 0,
      shipments_neither: 0,
      parity_score: 1,
    };
  }

  // Pull both event sources in parallel. Chunk the .in() to avoid PostgREST
  // URL-length limits at large shipment counts.
  const CHUNK = 200;
  const asSet = new Set<string>();
  const epSet = new Set<string>();
  for (let i = 0; i < shipmentIds.length; i += CHUNK) {
    const chunk = shipmentIds.slice(i, i + CHUNK);
    const [asRes, epRes] = await Promise.all([
      supabase
        .from("warehouse_tracking_events")
        .select("shipment_id")
        .eq("source", "aftership")
        .in("shipment_id", chunk),
      supabase
        .from("warehouse_tracking_events")
        .select("shipment_id")
        .eq("source", "easypost")
        .in("shipment_id", chunk),
    ]);
    for (const r of asRes.data ?? []) asSet.add(r.shipment_id as string);
    for (const r of epRes.data ?? []) epSet.add(r.shipment_id as string);
  }

  let both = 0;
  let asOnly = 0;
  let epOnly = 0;
  let neither = 0;
  for (const id of shipmentIds) {
    const a = asSet.has(id);
    const e = epSet.has(id);
    if (a && e) both++;
    else if (a) asOnly++;
    else if (e) epOnly++;
    else neither++;
  }
  const anyEvent = both + asOnly + epOnly;
  const parity = anyEvent === 0 ? 1 : both / anyEvent;
  return {
    workspace_id: workspaceId,
    shipments_in_window: shipmentIds.length,
    shipments_with_aftership_events: asSet.size,
    shipments_with_easypost_events: epSet.size,
    shipments_with_both: both,
    shipments_aftership_only: asOnly,
    shipments_easypost_only: epOnly,
    shipments_neither: neither,
    parity_score: parity,
  };
}
