"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useCallback, useRef, useState } from "react";
import { getImportDetail, getImportHistory, initiateImport } from "@/actions/pirate-ship";
import { Button } from "@/components/ui/button";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { WarehousePirateShipImport } from "@/lib/shared/types";

type ImportDetail = Awaited<ReturnType<typeof getImportDetail>>;

export default function PirateShipImportPage() {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedImport, setSelectedImport] = useState<ImportDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
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

  // Rule #68: Upload directly to Supabase Storage (4.5MB Server Action limit)
  const handleUpload = useCallback(async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".xlsx")) {
      setUploadError("Please select an XLSX file");
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase config");
      const supabase = createBrowserClient(supabaseUrl, supabaseKey);

      // Upload to storage with unique path
      const timestamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `imports/${timestamp}-${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from("pirate-ship-imports")
        .upload(storagePath, file);

      if (uploadErr) {
        throw new Error(`Upload failed: ${uploadErr.message}`);
      }

      // Call Server Action with storage path only (not file data)
      await initiateImport(storagePath, file.name);

      // Reset and refresh
      if (fileInputRef.current) fileInputRef.current.value = "";
      refetchHistory();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [refetchHistory]);

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
      {selectedImport && (
        <ImportDetailPanel detail={selectedImport} onClose={() => setSelectedImport(null)} />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: WarehousePirateShipImport["status"] }) {
  const styles = {
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

function ImportDetailPanel({ detail, onClose }: { detail: ImportDetail; onClose: () => void }) {
  return (
    <div className="border rounded-lg p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Import Detail: {detail.import.file_name}</h2>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Rows" value={detail.import.row_count ?? 0} />
        <StatCard label="Processed" value={detail.import.processed_count} />
        <StatCard label="Matched" value={detail.matchedShipments.length} />
        <StatCard label="Unmatched" value={detail.unmatchedItems.length} />
      </div>

      {/* Matched Shipments */}
      {detail.matchedShipments.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-sm">Matched Shipments</h3>
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
                {detail.matchedShipments.map(
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
          <h3 className="font-medium text-sm text-destructive">Unmatched (Review Queue)</h3>
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
                {detail.unmatchedItems.map(
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
                        <StatusBadge status={item.status as WarehousePirateShipImport["status"]} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Errors */}
      {detail.import.errors.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-sm text-destructive">Parse Errors</h3>
          <div className="border border-destructive/20 rounded-lg p-4 space-y-1">
            {detail.import.errors.map((err: Record<string, unknown>) => (
              <div
                key={`err-${(err.row as number) ?? "x"}-${(err.message as string)?.slice(0, 20) ?? ""}`}
                className="text-xs text-destructive"
              >
                Row {(err.row as number) ?? "?"}: {(err.message as string) ?? "Unknown error"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="border rounded-lg p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
