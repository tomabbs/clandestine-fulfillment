"use server";

/**
 * Server Actions backing /admin/settings/megaplan-verification.
 *
 * - triggerSpotCheck: enqueues a one-off run of the megaplan-spot-check task.
 *   The button on the verification page calls this so operators can re-verify
 *   on demand without waiting for the next cron tick.
 * - listSpotCheckRuns: paginated read of recent run rows (header data only).
 * - getSpotCheckArtifact: fetches the rendered markdown artifact for one run.
 *
 * All three require staff auth via requireStaff(). RLS on
 * megaplan_spot_check_runs is staff-only-select so even with the cookie the
 * client portal couldn't read these.
 *
 * Plan reference: §C.6 (v6 hardening: requireStaff destructure correction +
 * createServerSupabaseClient rename).
 */

import { tasks } from "@trigger.dev/sdk";
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export async function triggerSpotCheck(): Promise<{ runHandleId: string }> {
  await requireStaff();
  const handle = await tasks.trigger("megaplan-spot-check", {});
  return { runHandleId: handle.id };
}

export interface SpotCheckRunSummary {
  id: string;
  started_at: string;
  finished_at: string | null;
  sampled_sku_count: number;
  drift_agreed_count: number;
  drift_minor_count: number;
  drift_major_count: number;
  delayed_propagation_count: number;
}

export async function listSpotCheckRuns(limit = 50): Promise<SpotCheckRunSummary[]> {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("megaplan_spot_check_runs")
    .select(
      "id, started_at, finished_at, sampled_sku_count, drift_agreed_count, drift_minor_count, drift_major_count, delayed_propagation_count",
    )
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as SpotCheckRunSummary[];
}

export interface SpotCheckArtifact {
  artifact_md: string | null;
  summary_json: unknown;
  started_at: string;
  finished_at: string | null;
}

export async function getSpotCheckArtifact(runId: string): Promise<SpotCheckArtifact> {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("megaplan_spot_check_runs")
    .select("artifact_md, summary_json, started_at, finished_at")
    .eq("id", runId)
    .single();
  if (error) throw error;
  return data as SpotCheckArtifact;
}
