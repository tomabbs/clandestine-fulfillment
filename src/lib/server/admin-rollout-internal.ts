/**
 * Phase 6 (finish-line plan v4) — internal rollout helper.
 *
 * The single write path for `workspaces.fanout_rollout_percent`. Both the
 * staff Server Action (`setFanoutRolloutPercent`, src/actions/admin-rollout.ts)
 * and the `ramp-halt-criteria-sensor` Trigger task call this helper. Keeping
 * it lower-level than the Server Action means the sensor's emergency
 * rollback path does NOT depend on a Supabase auth session, which Trigger
 * tasks don't carry. Per plan v4 reviewer B §3:
 *
 *   "the halt-criteria sensor MUST NOT call [the Server Action] directly —
 *    Trigger.dev tasks don't carry a Supabase auth session and the Server
 *    Action's auth assumptions would fail at the worst possible moment
 *    (during a real incident)."
 *
 * Contract:
 *   - Validates 0 <= percent <= 100.
 *   - Reads the current row + appends a new audit element atomically (RPC
 *     would be ideal; we fall back to a read-then-write here because the
 *     audit JSONB is append-only and only this helper writes it; race-loss
 *     is fine — both writes land — and the audit JSON shape itself
 *     surfaces concurrent writes via timestamps).
 *   - Uses the service-role client so it works from any context (staff
 *     Server Action, Trigger task, debug script).
 *   - Audit row carries an explicit actor discriminated union so we can
 *     distinguish staff-driven changes from sensor-driven emergency
 *     rollbacks in post-mortem.
 */
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export type RolloutActor =
  | { kind: "staff"; userId: string }
  | { kind: "sensor"; sensorRun: string }
  | { kind: "script"; scriptName: string };

export interface RolloutAuditEntry {
  ts: string;
  percent_before: number | null;
  percent_after: number;
  reason: string;
  actor: RolloutActor;
  sensor_run?: string;
}

export interface SetRolloutInternalParams {
  workspaceId: string;
  percent: number;
  reason: string;
  actor: RolloutActor;
}

export interface SetRolloutInternalResult {
  success: boolean;
  workspaceId: string;
  percentBefore: number | null;
  percentAfter: number;
  auditEntry: RolloutAuditEntry;
  error?: string;
}

export async function setFanoutRolloutPercentInternal(
  params: SetRolloutInternalParams,
): Promise<SetRolloutInternalResult> {
  const { workspaceId, percent, reason, actor } = params;

  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    return {
      success: false,
      workspaceId,
      percentBefore: null,
      percentAfter: percent,
      auditEntry: buildAuditEntry({ percentBefore: null, percentAfter: percent, reason, actor }),
      error: `percent must be an integer 0..100 (got ${percent})`,
    };
  }

  const supabase = createServiceRoleClient();
  const { data: ws, error: readErr } = await supabase
    .from("workspaces")
    .select("fanout_rollout_percent, fanout_rollout_audit")
    .eq("id", workspaceId)
    .single();

  if (readErr || !ws) {
    return {
      success: false,
      workspaceId,
      percentBefore: null,
      percentAfter: percent,
      auditEntry: buildAuditEntry({ percentBefore: null, percentAfter: percent, reason, actor }),
      error: `workspace lookup failed: ${readErr?.message ?? "unknown"}`,
    };
  }

  const percentBefore = (ws.fanout_rollout_percent as number | null) ?? null;
  const auditEntry = buildAuditEntry({ percentBefore, percentAfter: percent, reason, actor });

  const existingAudit = Array.isArray(ws.fanout_rollout_audit)
    ? (ws.fanout_rollout_audit as RolloutAuditEntry[])
    : [];

  const { error: writeErr } = await supabase
    .from("workspaces")
    .update({
      fanout_rollout_percent: percent,
      fanout_rollout_audit: [...existingAudit, auditEntry],
    })
    .eq("id", workspaceId);

  if (writeErr) {
    return {
      success: false,
      workspaceId,
      percentBefore,
      percentAfter: percent,
      auditEntry,
      error: `update failed: ${writeErr.message}`,
    };
  }

  return {
    success: true,
    workspaceId,
    percentBefore,
    percentAfter: percent,
    auditEntry,
  };
}

function buildAuditEntry(params: {
  percentBefore: number | null;
  percentAfter: number;
  reason: string;
  actor: RolloutActor;
}): RolloutAuditEntry {
  const entry: RolloutAuditEntry = {
    ts: new Date().toISOString(),
    percent_before: params.percentBefore,
    percent_after: params.percentAfter,
    reason: params.reason,
    actor: params.actor,
  };
  if (params.actor.kind === "sensor") {
    entry.sensor_run = params.actor.sensorRun;
  }
  return entry;
}
