"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useCallback, useEffect, useRef, useState } from "react";
import { getImportDetail, getImportHistory, initiateImport } from "@/actions/pirate-ship";
import { Button } from "@/components/ui/button";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { WarehousePirateShipImport } from "@/lib/shared/types";

type ImportDetail = Awaited<ReturnType<typeof getImportDetail>>;

interface ImportMetrics {
  total_rows: number;
  matched_by_order: number;
  matched_by_customer: number;
  matched_by_alias: number;
  skipped_duplicate: number;
  sent_to_review: number;
  created_with_items: number;
  created_without_items: number;
}

interface ParsedErrors {
  metrics: ImportMetrics | null;
  perRowErrors: Array<{ row?: number; message: string }>;
}

// Normalises both JSONB shapes stored in warehouse_pirate_ship_imports.errors:
//   success  → object: { per_row_errors: [...], metrics: {...}, trigger_run_id?: string }
//   failure  → array:  [{ phase, message, timestamp, trigger_run_id? }]
// Never call .length or .map() directly on imp.errors — use this helper instead.
function parseImportErrors(raw: unknown): ParsedErrors {
  if (!raw) return { metrics: null, perRowErrors: [] };

  // Success shape: object with a 'metrics' key
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "metrics" in raw) {
    const obj = raw as { per_row_errors?: unknown[]; metrics: ImportMetrics };
    return {
      metrics: obj.metrics,
      perRowErrors: (obj.per_row_errors ?? []) as Array<{ row?: number; message: string }>,
    };
  }

  // Failure shape: array of error objects
  if (Array.isArray(raw)) {
    return {
      metrics: null,
      perRowErrors: raw as Array<{ row?: number; message: string }>,
    };
  }

  return { metrics: null, perRowErrors: [{ message: String(raw) }] };
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB client-side guard
const DISPLAY_ROW_LIMIT = 100; // Cap rendered rows to prevent browser freeze on large imports

export default function PirateShipImportPage() {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedImport, setSelectedImport] = useState<ImportDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Tracks the most recently uploaded import so we can auto-open it when it finishes
  const [pendingImportId, setPendingImportId] = useState<string | null>(null);
  // Prevents polling from re-opening a panel the user explicitly closed
  const [manuallyClosedIds, setManuallyClosedIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    data: historyData,
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useAppQuery({
    queryKey: queryKeys.pirateShipImports.all,
    queryFn: () => getImportHistory(),
    tier: CACHE_TIERS.REALTIME,
  });

  const handleViewDetail = useCallback(async (importId: string) => {
    setLoadingDetail(true);
    try {
      const detail = await getImportDetail(importId);
      setSelectedImport(detail);
    } catch {
      setSelectedImport(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const handleCloseDetail = useCallback(() => {
    if (selectedImport?.import?.id) {
      setManuallyClosedIds((prev) => new Set(prev).add(selectedImport.import?.id ?? ""));
    }
    setSelectedImport(null);
  }, [selectedImport]);

  // Recursive setTimeout — awaits refetchHistory before scheduling the next tick.
  // Prevents overlapping requests if the query takes longer than the poll interval.
  useEffect(() => {
    const imports = historyData?.imports ?? [];
    const hasInFlight = imports.some(
      (i: WarehousePirateShipImport) => i.status === "pending" || i.status === "processing",
    );

    // When polling stops, check if our tracked upload just finished — auto-open its detail
    if (!hasInFlight) {
      if (pendingImportId) {
        const finished = imports.find(
          (i: WarehousePirateShipImport) =>
            i.id === pendingImportId && (i.status === "completed" || i.status === "failed"),
        );
        if (finished && !manuallyClosedIds.has(finished.id)) {
          setPendingImportId(null);
          handleViewDetail(finished.id);
        }
      }
      return;
    }

    let cancelled = false;

    const schedulePoll = (): ReturnType<typeof setTimeout> => {
      return setTimeout(async () => {
        if (cancelled) return;
        await refetchHistory();
        if (!cancelled) {
          schedulePoll();
        }
      }, 2000);
    };

    const timer = schedulePoll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [historyData, pendingImportId, manuallyClosedIds, refetchHistory, handleViewDetail]);

  // Rule #68: Upload directly to Supabase Storage (4.5 MB Server Action limit)
  const handleUpload = useCallback(async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".xlsx")) {
      setUploadError("Please select an XLSX file");
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setUploadError("File too large (max 10 MB). Export a smaller date range from Pirate Ship.");
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase config");
      const supabase = createBrowserClient(supabaseUrl, supabaseKey);

      const timestamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `imports/${timestamp}-${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from("pirate-ship-imports")
        .upload(storagePath, file);

      if (uploadErr) {
        throw new Error(`Upload failed: ${uploadErr.message}`);
      }

      const { importId } = await initiateImport(storagePath, file.name);

      if (fileInputRef.current) fileInputRef.current.value = "";
      setPendingImportId(importId);
      refetchHistory();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [refetchHistory]);

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pirate Ship Import</h1>
        <p className="text-muted-foreground mt-1">
          Upload Pirate Ship XLSX exports to import shipment data.
        </p>
      </div>

      {/* Upload Section */}
      <div className="border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-medium">Upload XLSX</h2>
        <div className="flex items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="block w-full max-w-sm text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
          />
          <Button onClick={handleUpload} disabled={uploading}>
            {uploading ? "Uploading..." : "Import"}
          </Button>
        </div>
        {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
        {pendingImportId && (
          <p className="text-sm text-muted-foreground animate-pulse">
            Processing import — results will appear automatically...
          </p>
        )}
      </div>

      {/* Import History Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Import History</h2>
          <Button variant="outline" size="sm" onClick={() => refetchHistory()}>
            Refresh
          </Button>
        </div>

        {historyLoading ? (
          <div className="text-muted-foreground text-sm">Loading...</div>
        ) : !historyData?.imports.length ? (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">
            No imports yet. Upload a Pirate Ship XLSX to get started.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">File</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-left p-3 font-medium">Rows</th>
                  <th className="text-left p-3 font-medium">Processed</th>
                  <th className="text-left p-3 font-medium">Errors</th>
                  <th className="text-left p-3 font-medium">Date</th>
                  <th className="text-left p-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {historyData.imports.map((imp: WarehousePirateShipImport) => (
                  <tr key={imp.id} className="border-b last:border-0 hover:bg-muted/25">
                    <td className="p-3 font-mono text-xs max-w-[200px] truncate">
                      {imp.file_name}
                    </td>
                    <td className="p-3">
                      <StatusBadge status={imp.status} />
                    </td>
                    <td className="p-3 tabular-nums">{imp.row_count ?? "-"}</td>
                    <td className="p-3 tabular-nums">{imp.processed_count}</td>
                    <td className="p-3 tabular-nums">{imp.error_count}</td>
                    <td className="p-3 text-muted-foreground">
                      {new Date(imp.created_at).toLocaleString()}
                    </td>
                    <td className="p-3">
                      {imp.status === "completed" || imp.status === "failed" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewDetail(imp.id)}
                          disabled={loadingDetail}
                        >
                          Details
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail View */}
      {selectedImport && <ImportDetailPanel detail={selectedImport} onClose={handleCloseDetail} />}
    </div>
  );
}

function StatusBadge({ status }: { status: WarehousePirateShipImport["status"] }) {
  const styles: Record<WarehousePirateShipImport["status"], string> = {
    pending: "bg-yellow-100 text-yellow-800",
    processing: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

// Separate badge for review queue items — different status domain from import status
function ReviewStatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
      {status}
    </span>
  );
}

function ImportDetailPanel({ detail, onClose }: { detail: ImportDetail; onClose: () => void }) {
  if (!detail.import) return null;

  const imp = detail.import;
  const { metrics, perRowErrors } = parseImportErrors(imp.errors);
  const newShipments = metrics ? metrics.created_with_items + metrics.created_without_items : null;

  const displayedShipments = detail.matchedShipments.slice(0, DISPLAY_ROW_LIMIT);
  const displayedErrors = perRowErrors.slice(0, DISPLAY_ROW_LIMIT);
  const displayedUnmatched = detail.unmatchedItems.slice(0, DISPLAY_ROW_LIMIT);

  return (
    <div className="border rounded-lg p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Import Detail: {imp.file_name}</h2>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {/* Duplicate callout */}
      {metrics && metrics.skipped_duplicate > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
          <strong>
            {metrics.skipped_duplicate} duplicate tracking number
            {metrics.skipped_duplicate !== 1 ? "s" : ""} skipped
          </strong>{" "}
          — these shipments already exist from a previous import and were not re-imported.
        </div>
      )}

      {/* Metrics cards */}
      {metrics ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total Rows" value={imp.row_count ?? 0} />
          <StatCard label="New Shipments" value={newShipments ?? 0} highlight="good" />
          <StatCard label="Duplicates Skipped" value={metrics.skipped_duplicate} />
          <StatCard label="Matched by Order #" value={metrics.matched_by_order} highlight="good" />
          <StatCard
            label="Matched by Customer"
            value={metrics.matched_by_customer}
            highlight="good"
          />
          <StatCard
            label="Matched by Org Alias"
            value={metrics.matched_by_alias}
            highlight="good"
          />
          <StatCard
            label="Sent to Review"
            value={metrics.sent_to_review}
            highlight={metrics.sent_to_review > 0 ? "warn" : "neutral"}
          />
          <StatCard
            label="Parse Errors"
            value={imp.error_count}
            highlight={imp.error_count > 0 ? "bad" : "neutral"}
          />
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total Rows" value={imp.row_count ?? 0} />
          <StatCard label="Processed" value={imp.processed_count} />
          <StatCard label="Matched" value={detail.matchedShipments.length} />
          <StatCard label="Unmatched" value={detail.unmatchedItems.length} />
        </div>
      )}

      {/* Matched Shipments */}
      {detail.matchedShipments.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-sm">
            Matched Shipments ({detail.matchedShipments.length})
            {detail.matchedShipments.length > DISPLAY_ROW_LIMIT && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                — showing first {DISPLAY_ROW_LIMIT}
              </span>
            )}
          </h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Carrier</th>
                  <th className="text-left p-2 font-medium">Ship Date</th>
                  <th className="text-left p-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {displayedShipments.map(
                  (s: {
                    id: string;
                    tracking_number: string | null;
                    carrier: string | null;
                    ship_date: string | null;
                    shipping_cost: number | null;
                  }) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="p-2 font-mono text-xs">{s.tracking_number ?? "-"}</td>
                      <td className="p-2">{s.carrier ?? "-"}</td>
                      <td className="p-2">{s.ship_date ?? "-"}</td>
                      <td className="p-2 tabular-nums">
                        {s.shipping_cost != null ? `$${s.shipping_cost.toFixed(2)}` : "-"}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Unmatched Items */}
      {detail.unmatchedItems.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-sm text-destructive">
            Unmatched — Sent to Review ({detail.unmatchedItems.length})
            {detail.unmatchedItems.length > DISPLAY_ROW_LIMIT && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                — showing first {DISPLAY_ROW_LIMIT}
              </span>
            )}
          </h3>
          <div className="border border-destructive/20 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-destructive/5">
                  <th className="text-left p-2 font-medium">Row</th>
                  <th className="text-left p-2 font-medium">Recipient</th>
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {displayedUnmatched.map(
                  (item: { id: string; metadata: Record<string, unknown>; status: string }) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="p-2">{(item.metadata?.row_index as number) ?? "-"}</td>
                      <td className="p-2">
                        {(item.metadata?.recipient_name as string) ??
                          (item.metadata?.recipient_company as string) ??
                          "-"}
                      </td>
                      <td className="p-2 font-mono text-xs">
                        {(item.metadata?.tracking_number as string) ?? "-"}
                      </td>
                      <td className="p-2">
                        <ReviewStatusBadge status={item.status} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Parse Errors */}
      {displayedErrors.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-sm text-destructive">
            Parse Errors ({perRowErrors.length})
            {perRowErrors.length > DISPLAY_ROW_LIMIT && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                — showing first {DISPLAY_ROW_LIMIT}
              </span>
            )}
          </h3>
          <div className="border border-destructive/20 rounded-lg p-4 space-y-1">
            {displayedErrors.map((err) => (
              <div
                key={`err-${err.row ?? "x"}-${String(err.message).slice(0, 20)}`}
                className="text-xs text-destructive"
              >
                Row {err.row ?? "?"}: {err.message ?? "Unknown error"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight = "neutral",
}: {
  label: string;
  value: number;
  highlight?: "good" | "warn" | "bad" | "neutral";
}) {
  const valueClass =
    highlight === "bad"
      ? "text-destructive"
      : highlight === "warn"
        ? "text-yellow-700"
        : highlight === "good"
          ? "text-green-700"
          : "";

  return (
    <div className="border rounded-lg p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
