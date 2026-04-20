/**
 * shipstation-export task
 *
 * Generates the ShipStation product-import file (CSV + XLSX) for a workspace
 * and uploads it to the `shipstation-exports` Storage bucket. Updates the
 * `shipstation_export_runs` row with file paths and coverage metrics.
 *
 * Server Actions never call this directly because building the export for
 * 3K+ variants regularly exceeds 30 seconds (Rule #41). The admin UI calls
 * `triggerShipstationExport`, which inserts a `shipstation_export_runs`
 * row and enqueues this task with the run ID (Rule #12).
 *
 * Rule #7: createServiceRoleClient — bypasses RLS to read across all orgs
 *           in the workspace.
 * Rule #54: heavy work routed via Trigger.
 */

import { logger, task } from "@trigger.dev/sdk";
import { buildShipstationExport } from "@/lib/server/shipstation-export";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface ShipstationExportPayload {
  runId: string;
}

export interface ShipstationExportTaskResult {
  run_id: string;
  status: "completed" | "failed";
  rows_written?: number;
  data_max_ts?: string | null;
  error?: string;
}

const BUCKET = "shipstation-exports";

export const shipstationExportTask = task({
  id: "shipstation-export",
  maxDuration: 600, // 10 min — full 3K-row export is ~7s today; cap leaves headroom.
  run: async (payload: ShipstationExportPayload, { ctx }): Promise<ShipstationExportTaskResult> => {
    const { runId } = payload;
    const supabase = createServiceRoleClient();

    const { data: run, error: runErr } = await supabase
      .from("shipstation_export_runs")
      .select("id, workspace_id, mode, since_ts, status")
      .eq("id", runId)
      .single();

    if (runErr || !run) {
      throw new Error(
        `shipstation_export_runs row not found: ${runId} (${runErr?.message ?? "—"})`,
      );
    }

    await supabase
      .from("shipstation_export_runs")
      .update({ status: "running", task_run_id: ctx.run.id })
      .eq("id", runId);

    try {
      const sinceTs = run.mode === "incremental" ? run.since_ts : null;
      logger.info("Building ShipStation export", { runId, mode: run.mode, sinceTs });

      const result = await buildShipstationExport({ supabase, sinceTs });

      logger.info("Export built — uploading to Storage", {
        runId,
        rows_written: result.summary.rows_written,
        total_variants_loaded: result.summary.total_variants_loaded,
      });

      // Storage paths: {workspace}/{yyyymmdd}/{runId}.{ext}
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
      const prefix = `${run.workspace_id}/${stamp.slice(0, 10).replace(/-/g, "")}/${runId}`;
      const csvPath = `${prefix}.csv`;
      const xlsxPath = `${prefix}.xlsx`;
      const summaryPath = `${prefix}.summary.json`;

      // CSV
      const { error: csvErr } = await supabase.storage
        .from(BUCKET)
        .upload(csvPath, Buffer.from(result.csv, "utf8"), {
          contentType: "text/csv; charset=utf-8",
          upsert: true,
        });
      if (csvErr) throw new Error(`CSV upload failed: ${csvErr.message}`);

      // XLSX
      const { error: xlsxErr } = await supabase.storage
        .from(BUCKET)
        .upload(xlsxPath, Buffer.from(result.xlsx), {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          upsert: true,
        });
      if (xlsxErr) throw new Error(`XLSX upload failed: ${xlsxErr.message}`);

      // Summary JSON
      const { error: sumErr } = await supabase.storage
        .from(BUCKET)
        .upload(summaryPath, Buffer.from(JSON.stringify(result.summary, null, 2), "utf8"), {
          contentType: "application/json",
          upsert: true,
        });
      if (sumErr) throw new Error(`summary upload failed: ${sumErr.message}`);

      const { error: updErr } = await supabase
        .from("shipstation_export_runs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          total_variants_loaded: result.summary.total_variants_loaded,
          rows_written: result.summary.rows_written,
          duplicates_skipped: result.summary.duplicates_skipped,
          data_max_ts: result.summary.data_max_ts,
          coverage: result.summary.coverage,
          duplicate_skus: result.summary.duplicate_skus,
          csv_storage_path: csvPath,
          xlsx_storage_path: xlsxPath,
          summary_storage_path: summaryPath,
        })
        .eq("id", runId);
      if (updErr) throw new Error(`run update failed: ${updErr.message}`);

      return {
        run_id: runId,
        status: "completed",
        rows_written: result.summary.rows_written,
        data_max_ts: result.summary.data_max_ts,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("ShipStation export failed", { runId, message });
      await supabase
        .from("shipstation_export_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: message,
        })
        .eq("id", runId);
      return { run_id: runId, status: "failed", error: message };
    }
  },
});
