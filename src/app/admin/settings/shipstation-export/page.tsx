"use client";

import {
  Clock,
  Download,
  FileSpreadsheet,
  Loader2,
  PackageCheck,
  PackageX,
  Play,
  ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import {
  getShipstationExportDownloadUrls,
  listShipstationExportRuns,
  type ShipstationExportRunRow,
  triggerShipstationExport,
} from "@/actions/shipstation-export";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

/**
 * /admin/settings/shipstation-export
 *
 * Generates a ShipStation product-import file (CSV + XLSX) for every
 * variant in the warehouse. Two modes:
 *   - Full export — every variant.
 *   - Incremental — only variants created since the last completed export
 *     (`since_ts = previous run.data_max_ts`). First incremental run with
 *     no prior history behaves like a full export.
 *
 * Heavy work runs in the `shipstation-export` Trigger task; this page polls
 * `listShipstationExportRuns` every 3 seconds while a run is pending or
 * running. Completed runs expose 1-hour signed download URLs from the
 * `shipstation-exports` Storage bucket.
 */
export default function ShipstationExportPage() {
  const [pendingDownloadId, setPendingDownloadId] = useState<string | null>(null);

  const runsQuery = useAppQuery({
    queryKey: ["admin", "shipstation-export-runs"],
    queryFn: () => listShipstationExportRuns({ limit: 25 }),
    tier: CACHE_TIERS.SESSION,
    // Poll while any run is still in flight so the table refreshes itself.
    refetchInterval: (q) => {
      const data = q.state.data as ShipstationExportRunRow[] | undefined;
      if (!data) return false;
      return data.some((r) => r.status === "pending" || r.status === "running") ? 3000 : false;
    },
  });

  const triggerMut = useAppMutation({
    mutationFn: triggerShipstationExport,
    invalidateKeys: [["admin", "shipstation-export-runs"]],
  });

  const downloadMut = useAppMutation({
    mutationFn: async ({ runId, kind }: { runId: string; kind: "csv" | "xlsx" | "summary" }) => {
      setPendingDownloadId(runId);
      try {
        const urls = await getShipstationExportDownloadUrls({ runId });
        const url = urls[kind];
        if (!url) throw new Error(`No ${kind} file available for this run.`);
        window.open(url, "_blank", "noopener,noreferrer");
        return urls;
      } finally {
        setPendingDownloadId(null);
      }
    },
  });

  const lastCompleted = runsQuery.data?.find((r) => r.status === "completed");
  const lastSinceTs = lastCompleted?.data_max_ts ?? null;
  const anyInFlight = runsQuery.data?.some((r) => r.status === "pending" || r.status === "running");

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">ShipStation product export</h1>
        <p className="text-sm text-muted-foreground">
          Generate the ShipStation product-import file (CSV + XLSX) for every variant in the
          warehouse. The CSV uploads directly to ShipStation's product-import; the XLSX is for human
          review or filling in missing fields (locations, dimensions) before upload.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run a new export</CardTitle>
          <CardDescription>
            Heavy work runs in the <code>shipstation-export</code> Trigger task. The "Recent runs"
            table below polls every 3 seconds while the export is in flight, then exposes 1-hour
            download links.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={triggerMut.isPending || anyInFlight}
              onClick={() => triggerMut.mutate({ mode: "full" })}
            >
              {triggerMut.isPending && triggerMut.variables?.mode === "full" ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Enqueuing...
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-1" /> Export all products
                </>
              )}
            </Button>

            <Button
              variant="outline"
              disabled={triggerMut.isPending || anyInFlight}
              onClick={() => triggerMut.mutate({ mode: "incremental" })}
            >
              {triggerMut.isPending && triggerMut.variables?.mode === "incremental" ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Enqueuing...
                </>
              ) : (
                <>
                  <Clock className="h-3 w-3 mr-1" /> Export new since last
                </>
              )}
            </Button>

            {anyInFlight && (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> A run is already in progress.
              </span>
            )}
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <div>
              <strong>Last completed export:</strong>{" "}
              {lastCompleted ? (
                <>
                  {new Date(
                    lastCompleted.completed_at ?? lastCompleted.started_at,
                  ).toLocaleString()}{" "}
                  — {lastCompleted.rows_written ?? 0} products
                </>
              ) : (
                "no exports yet"
              )}
            </div>
            <div>
              <strong>Incremental cutoff:</strong>{" "}
              {lastSinceTs
                ? `variants created after ${new Date(lastSinceTs).toLocaleString()}`
                : "no prior runs — first incremental run will export everything"}
            </div>
          </div>

          {triggerMut.error && (
            <p className="text-sm text-destructive">
              Trigger error:{" "}
              {triggerMut.error instanceof Error ? triggerMut.error.message : "unknown"}
            </p>
          )}
          {downloadMut.error && (
            <p className="text-sm text-destructive">
              Download error:{" "}
              {downloadMut.error instanceof Error ? downloadMut.error.message : "unknown"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            From <code>shipstation_export_runs</code> — most recent first. Download links expire
            after 1 hour; click "Download" again to mint a fresh signed URL.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BlockList
            className="mt-3"
            items={runsQuery.data ?? []}
            itemKey={(row) => row.id}
            loading={runsQuery.isLoading}
            density="ops"
            ariaLabel="ShipStation export runs"
            renderHeader={({ row }) => (
              <div className="min-w-0">
                <p className="text-sm font-medium">{new Date(row.started_at).toLocaleString()}</p>
                <div className="mt-1">
                  <ModeBadge mode={row.mode} />
                </div>
              </div>
            )}
            renderExceptionZone={({ row }) => (
              <div className="space-y-1">
                <RunStatusBadge status={row.status} />
                {row.error && (
                  <p className="text-xs text-destructive max-w-full break-words">{row.error}</p>
                )}
              </div>
            )}
            renderBody={({ row }) => (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <RunMetric label="Rows written" value={row.rows_written ?? "—"} />
                <RunMetric label="Skipped dupes" value={row.duplicates_skipped ?? "—"} />
                <RunMetric
                  label="Cutoff"
                  value={
                    row.mode === "incremental"
                      ? row.since_ts
                        ? `> ${new Date(row.since_ts).toLocaleString()}`
                        : "(no prior - full)"
                      : "—"
                  }
                />
              </div>
            )}
            renderActions={({ row }) => (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    row.status !== "completed" ||
                    !row.csv_storage_path ||
                    (downloadMut.isPending && pendingDownloadId === row.id)
                  }
                  onClick={() => downloadMut.mutate({ runId: row.id, kind: "csv" })}
                  title="Download CSV (upload this to ShipStation)"
                >
                  <Download className="h-3 w-3 mr-1" /> CSV
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    row.status !== "completed" ||
                    !row.xlsx_storage_path ||
                    (downloadMut.isPending && pendingDownloadId === row.id)
                  }
                  onClick={() => downloadMut.mutate({ runId: row.id, kind: "xlsx" })}
                  title="Download XLSX (human review)"
                >
                  <FileSpreadsheet className="h-3 w-3 mr-1" /> XLSX
                </Button>
              </div>
            )}
            emptyState={
              <EmptyState
                icon={FileSpreadsheet}
                title="No exports yet"
                description="Start a full or incremental export to populate this list."
              />
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

function RunMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm tabular-nums">{value}</p>
    </div>
  );
}

function ModeBadge({ mode }: { mode: "full" | "incremental" }) {
  return mode === "full" ? (
    <Badge variant="secondary">full</Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <Clock className="h-3 w-3" /> incremental
    </Badge>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <Badge variant="secondary" className="gap-1">
        <PackageCheck className="h-3 w-3" /> {status}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="gap-1 text-destructive">
        <PackageX className="h-3 w-3" /> {status}
      </Badge>
    );
  }
  if (status === "running") {
    return (
      <Badge variant="outline" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> {status}
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="outline" className="gap-1">
        <ShieldAlert className="h-3 w-3" /> {status}
      </Badge>
    );
  }
  return <Badge variant="secondary">{status}</Badge>;
}
