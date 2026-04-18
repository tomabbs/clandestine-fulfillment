/**
 * Phase 6 (finish-line plan v4) — ramp-halt-criteria-sensor.
 *
 * Cron task that:
 *   1. Reads `sensor_readings` from the last 1 hour (activity window).
 *   2. Filters out stress-harness rows (`excludeStressArtifacts`).
 *   3. Computes spot-check drift_major fraction from the latest
 *      megaplan-spot-check run within the window.
 *   4. Computes ShipStation v2 5xx rate from the v2 client telemetry table
 *      if present, else `null`.
 *   5. Calls `evaluateRampHaltCriteria` with the prior run's spot-check
 *      tripped state for §5.3 two-consecutive-runs persistence.
 *   6. If action ∈ { halt, halt_and_page } AND current rollout > 0%:
 *      • Calls `setFanoutRolloutPercentInternal(0)` with actor=sensor.
 *      • Writes a critical review-queue item with full findings.
 *   7. Always writes a `ramp_halt_evaluator` `sensor_readings` row so we
 *      have an audit trail of what the sensor saw and decided.
 *
 * Persistence of `priorRunSpotCheckTriggered`: stored on the workspace as
 * a JSONB column `ramp_sensor_state.lastSpotCheckTripped`. We write through
 * the same workspace row to keep state colocated.
 *
 * Cron cadence: every 2 minutes during ramp (Phase 7), tightened to every
 * 15 minutes post-ramp (Phase 8e). Adjust via the `cron` field; the
 * evaluator itself is cadence-agnostic.
 *
 * Per finish-line v4 reviewer B §3 (decoupling):
 *   This task NEVER calls the staff Server Action `setFanoutRolloutPercent`
 *   directly — Trigger tasks don't carry a Supabase auth session and the
 *   staff auth check would fail at the worst possible moment. It calls
 *   the lower-level `setFanoutRolloutPercentInternal` helper instead.
 */

import { schedules } from "@trigger.dev/sdk";
import { setFanoutRolloutPercentInternal } from "@/lib/server/admin-rollout-internal";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  evaluateRampHaltCriteria,
  type HaltEvaluatorReading,
} from "@/trigger/lib/ramp-halt-evaluator";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
const STRESS_PREFIX = "STRESS-";

export const rampHaltCriteriaSensorTask = schedules.task({
  id: "ramp-halt-criteria-sensor",
  cron: "*/2 * * * *",
  maxDuration: 60,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const sensorRunId = ctx.run.id;
    const windowStart = new Date(Date.now() - ACTIVITY_WINDOW_MS).toISOString();

    const { data: workspaces, error: wsErr } = await supabase
      .from("workspaces")
      .select("id, fanout_rollout_percent, ramp_sensor_state")
      .limit(1);
    if (wsErr || !workspaces || workspaces.length === 0) {
      return { skipped: true, reason: `workspace lookup failed: ${wsErr?.message ?? "no rows"}` };
    }
    const ws = workspaces[0];
    const currentPercent = (ws.fanout_rollout_percent as number | null) ?? 100;
    const priorState = (ws.ramp_sensor_state as { lastSpotCheckTripped?: boolean } | null) ?? null;

    const { data: readings } = await supabase
      .from("sensor_readings")
      .select("sensor_name, status, value, created_at")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: false })
      .limit(500);

    const recentReadings: HaltEvaluatorReading[] = (readings ?? [])
      .filter((r) => !looksLikeStressArtifact(r.value))
      .map((r) => ({
        sensorName: r.sensor_name,
        status: r.status as HaltEvaluatorReading["status"],
        value: (r.value as Record<string, unknown> | null) ?? undefined,
        ts: r.created_at,
      }));

    const spotCheckDriftMajorFraction = await fetchSpotCheckDriftMajorFraction(
      supabase,
      windowStart,
    );

    const v2_5xxRate = await fetchShipstationV2_5xxRate(supabase, windowStart);

    const result = evaluateRampHaltCriteria({
      recentReadings,
      priorRunSpotCheckTriggered: priorState?.lastSpotCheckTripped ?? null,
      spotCheckDriftMajorFraction,
      shipstationV2_5xxRate: v2_5xxRate,
    });

    let halted = false;
    if (
      (result.action.kind === "halt" || result.action.kind === "halt_and_page") &&
      currentPercent > 0
    ) {
      halted = true;
      const internalRes = await setFanoutRolloutPercentInternal({
        workspaceId: ws.id,
        percent: 0,
        reason: `auto-halt by ramp-halt-criteria-sensor: ${result.action.reason}`,
        actor: { kind: "sensor", sensorRun: sensorRunId },
      });
      if (!internalRes.success) {
        await supabase.from("warehouse_review_queue").insert({
          workspace_id: ws.id,
          severity: "critical",
          title: "ramp-halt-criteria-sensor failed to write halt",
          description: `Sensor tried to halt ramp but write failed: ${internalRes.error}. Manual intervention required.`,
          group_key: `ramp-halt-write-failure:${sensorRunId}`,
        });
      }

      await supabase.from("warehouse_review_queue").insert({
        workspace_id: ws.id,
        severity: result.action.kind === "halt_and_page" ? "critical" : "high",
        title:
          result.action.kind === "halt_and_page"
            ? "RAMP HALTED + PAGE: " + result.action.reason
            : "RAMP HALTED: " + result.action.reason,
        description: JSON.stringify(
          {
            sensor_run: sensorRunId,
            previous_percent: currentPercent,
            findings: result.findings,
          },
          null,
          2,
        ),
        group_key: `ramp-halt:${sensorRunId}`,
      });
    }

    await supabase.from("sensor_readings").insert({
      workspace_id: ws.id,
      sensor_name: "ramp_halt_evaluator",
      status:
        result.action.kind === "halt_and_page"
          ? "critical"
          : result.action.kind === "halt"
            ? "critical"
            : result.action.kind === "warn"
              ? "warning"
              : "healthy",
      value: {
        action: result.action,
        findings: result.findings,
        currentPercent,
        spotCheckDriftMajorFraction,
        shipstationV2_5xxRate: v2_5xxRate,
        readingsCount: recentReadings.length,
        sensorRun: sensorRunId,
        halted,
      },
      message: result.action.reason,
    });

    await supabase
      .from("workspaces")
      .update({
        ramp_sensor_state: {
          ...(priorState ?? {}),
          lastSpotCheckTripped: result.spotCheckTrippedThisRun,
          lastEvaluatedAt: new Date().toISOString(),
          lastSensorRun: sensorRunId,
        },
      })
      .eq("id", ws.id);

    return {
      action: result.action,
      halted,
      currentPercent,
      newPercent: halted ? 0 : currentPercent,
    };
  },
});

function looksLikeStressArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.stress_run_id === "string" && v.stress_run_id.length > 0) return true;
  if (typeof v.correlation_id === "string" && v.correlation_id.startsWith(STRESS_PREFIX))
    return true;
  if (typeof v.sku === "string" && v.sku.startsWith(STRESS_PREFIX)) return true;
  return false;
}

/**
 * Reads the latest `megaplan-spot-check` run's drift_major fraction from
 * `sensor_readings`. The spot-check task writes a row with sensor_name
 * `megaplan_spot_check` and value.driftMajorFraction. Returns null if no
 * run completed inside the window.
 */
async function fetchSpotCheckDriftMajorFraction(
  supabase: ReturnType<typeof createServiceRoleClient>,
  windowStart: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("sensor_readings")
    .select("value, created_at")
    .eq("sensor_name", "megaplan_spot_check")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  const v = row.value as { driftMajorFraction?: unknown } | null;
  if (!v || typeof v.driftMajorFraction !== "number") return null;
  return v.driftMajorFraction;
}

/**
 * Reads ShipStation v2 5xx rate over the activity window from
 * `sensor_readings`. Looks for sensor_name `shipstation_v2_5xx_rate` with
 * value.rate. Returns null if no such reading exists. We deliberately do
 * NOT compute this inline by querying request logs — that's the v2 client
 * telemetry's job.
 */
async function fetchShipstationV2_5xxRate(
  supabase: ReturnType<typeof createServiceRoleClient>,
  windowStart: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("sensor_readings")
    .select("value, created_at")
    .eq("sensor_name", "shipstation_v2_5xx_rate")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  const v = row.value as { rate?: unknown } | null;
  if (!v || typeof v.rate !== "number") return null;
  return v.rate;
}
