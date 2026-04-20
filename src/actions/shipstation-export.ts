"use server";

/**
 * ShipStation product-import export — Server Actions.
 *
 * Three staff-only verbs:
 *   - `triggerShipstationExport({ mode })` — inserts a `shipstation_export_runs`
 *     row + enqueues the `shipstation-export` Trigger task. For `incremental`
 *     mode, copies `since_ts` from the previous COMPLETED run's `data_max_ts`.
 *     Returns the run ID for polling.
 *   - `listShipstationExportRuns({ limit })` — recent runs panel.
 *   - `getShipstationExportDownloadUrls({ runId })` — fresh signed URLs
 *     (1h expiry) for the CSV / XLSX / summary JSON in Storage.
 *
 * Rule #41: heavy work routed via Trigger.dev — Server Actions stay bounded.
 * Rule #48: never call APIs from Server Actions; always enqueue.
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ShipstationExportPayload } from "@/trigger/tasks/shipstation-export";

const SIGNED_URL_TTL_SEC = 60 * 60; // 1 hour
const BUCKET = "shipstation-exports";

// ─── triggerShipstationExport ────────────────────────────────────────────────

const TRIGGER_INPUT = z.object({
  mode: z.enum(["full", "incremental"]),
});

export interface TriggerShipstationExportResult {
  runId: string;
  taskRunId: string;
  mode: "full" | "incremental";
  sinceTs: string | null;
}

export async function triggerShipstationExport(
  input: z.input<typeof TRIGGER_INPUT>,
): Promise<TriggerShipstationExportResult> {
  const parsed = TRIGGER_INPUT.parse(input);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();

  // For incremental, derive since_ts from the most recent COMPLETED run for
  // this workspace. If no prior run exists, behave like a full export
  // (since_ts = null) — first incremental run = full export.
  let sinceTs: string | null = null;
  if (parsed.mode === "incremental") {
    const { data: lastRun, error: lastErr } = await supabase
      .from("shipstation_export_runs")
      .select("data_max_ts")
      .eq("workspace_id", ctx.userRecord.workspace_id)
      .eq("status", "completed")
      .not("data_max_ts", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastErr) throw new Error(`previous-run lookup failed: ${lastErr.message}`);
    sinceTs = lastRun?.data_max_ts ?? null;
  }

  const { data: run, error: insertErr } = await supabase
    .from("shipstation_export_runs")
    .insert({
      workspace_id: ctx.userRecord.workspace_id,
      triggered_by_user_id: ctx.userRecord.id,
      mode: parsed.mode,
      since_ts: sinceTs,
      status: "pending",
    })
    .select("id")
    .single();
  if (insertErr || !run) {
    throw new Error(`failed to create export run: ${insertErr?.message ?? "no row"}`);
  }

  const payload: ShipstationExportPayload = { runId: run.id };
  const handle = await tasks.trigger("shipstation-export", payload);

  await supabase
    .from("shipstation_export_runs")
    .update({ task_run_id: handle.id })
    .eq("id", run.id);

  return {
    runId: run.id,
    taskRunId: handle.id,
    mode: parsed.mode,
    sinceTs,
  };
}

// ─── listShipstationExportRuns ───────────────────────────────────────────────

const LIST_INPUT = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

export interface ShipstationExportRunRow {
  id: string;
  mode: "full" | "incremental";
  status: "pending" | "running" | "completed" | "failed";
  since_ts: string | null;
  data_max_ts: string | null;
  total_variants_loaded: number | null;
  rows_written: number | null;
  duplicates_skipped: number | null;
  error: string | null;
  task_run_id: string | null;
  csv_storage_path: string | null;
  xlsx_storage_path: string | null;
  summary_storage_path: string | null;
  started_at: string;
  completed_at: string | null;
  triggered_by_user_id: string | null;
}

export async function listShipstationExportRuns(
  input?: z.input<typeof LIST_INPUT>,
): Promise<ShipstationExportRunRow[]> {
  const parsed = LIST_INPUT.parse(input ?? {});
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("shipstation_export_runs")
    .select(
      "id, mode, status, since_ts, data_max_ts, total_variants_loaded, rows_written, duplicates_skipped, error, task_run_id, csv_storage_path, xlsx_storage_path, summary_storage_path, started_at, completed_at, triggered_by_user_id",
    )
    .eq("workspace_id", ctx.userRecord.workspace_id)
    .order("started_at", { ascending: false })
    .limit(parsed.limit ?? 25);
  if (error) throw new Error(error.message);
  return (data ?? []) as ShipstationExportRunRow[];
}

// ─── getShipstationExportDownloadUrls ────────────────────────────────────────

const DOWNLOAD_INPUT = z.object({
  runId: z.string().uuid(),
});

export interface ShipstationExportDownloadUrls {
  csv: string | null;
  xlsx: string | null;
  summary: string | null;
}

export async function getShipstationExportDownloadUrls(
  input: z.input<typeof DOWNLOAD_INPUT>,
): Promise<ShipstationExportDownloadUrls> {
  const parsed = DOWNLOAD_INPUT.parse(input);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  const { data: run, error } = await supabase
    .from("shipstation_export_runs")
    .select("workspace_id, status, csv_storage_path, xlsx_storage_path, summary_storage_path")
    .eq("id", parsed.runId)
    .single();
  if (error || !run) throw new Error(`run not found: ${error?.message ?? "—"}`);
  if (run.workspace_id !== ctx.userRecord.workspace_id) {
    throw new Error("Cross-workspace download not permitted");
  }
  if (run.status !== "completed") {
    throw new Error(`run is not completed (status=${run.status})`);
  }

  async function sign(path: string | null): Promise<string | null> {
    if (!path) return null;
    const { data, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SEC, { download: true });
    if (signErr) throw new Error(`failed to sign ${path}: ${signErr.message}`);
    return data?.signedUrl ?? null;
  }

  return {
    csv: await sign(run.csv_storage_path),
    xlsx: await sign(run.xlsx_storage_path),
    summary: await sign(run.summary_storage_path),
  };
}
