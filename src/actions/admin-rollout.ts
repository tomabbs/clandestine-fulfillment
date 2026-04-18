"use server";

import {
  type SetRolloutInternalResult,
  setFanoutRolloutPercentInternal,
} from "@/lib/server/admin-rollout-internal";
/**
 * Phase 6 (finish-line plan v4) — staff Server Action wrapper for the rollout helper.
 *
 * Thin wrapper around `setFanoutRolloutPercentInternal` that adds:
 *   - staff auth (`requireStaff`)
 *   - input validation
 *   - actor=staff in audit trail
 *
 * The lower-level helper is intentionally callable from non-Server-Action
 * contexts (Trigger tasks, scripts) — this file is the staff-only entry
 * point for the admin UI ramp page.
 */
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export interface SetFanoutRolloutPercentInput {
  percent: number;
  reason: string;
}

export async function setFanoutRolloutPercent(
  input: SetFanoutRolloutPercentInput,
): Promise<SetRolloutInternalResult> {
  const { userId } = await requireStaff();

  const reason = input.reason?.trim();
  if (!reason || reason.length < 3) {
    throw new Error("reason is required (min 3 chars)");
  }

  const supabase = await createServerSupabaseClient();
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) throw new Error("No workspace found");

  return setFanoutRolloutPercentInternal({
    workspaceId: ws.id,
    percent: input.percent,
    reason,
    actor: { kind: "staff", userId },
  });
}

export interface RolloutAuditView {
  workspaceId: string;
  currentPercent: number;
  audit: Array<{
    ts: string;
    percent_before: number | null;
    percent_after: number;
    reason: string;
    actor: unknown;
    sensor_run?: string;
  }>;
}

export async function getFanoutRolloutAudit(): Promise<RolloutAuditView> {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, fanout_rollout_percent, fanout_rollout_audit")
    .limit(1)
    .single();

  if (error || !data) throw new Error(`workspace lookup failed: ${error?.message ?? "unknown"}`);

  const audit = Array.isArray(data.fanout_rollout_audit)
    ? (data.fanout_rollout_audit as RolloutAuditView["audit"])
    : [];

  return {
    workspaceId: data.id,
    currentPercent: (data.fanout_rollout_percent as number | null) ?? 100,
    audit,
  };
}
