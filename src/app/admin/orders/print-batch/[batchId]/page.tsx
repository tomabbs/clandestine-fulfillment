// Phase 9.1c — print batch page.
//
// /admin/orders/print-batch/[batchId] renders an aggregated print-friendly
// view of every label in the batch: per-row outcome (ok / failed),
// downloadable label PDF link, plus a single-click "Print all PDFs" anchor
// that opens each PDF in a new window. Staff page through pages of paper
// and reprint selectively from the failed list.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface PageProps {
  params: { batchId: string };
}

interface PerOrderEntry {
  uuid: string;
  ok: boolean;
  warehouseShipmentId?: string | null;
  error?: string;
}

export default async function PrintBatchPage({ params }: PageProps) {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: batch } = await supabase
    .from("print_batch_jobs")
    .select("id, status, progress, shipment_ids, expires_at, created_at, created_by")
    .eq("id", params.batchId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!batch) notFound();

  const shipmentIds = (batch.shipment_ids ?? []) as string[];
  const { data: shipments } =
    shipmentIds.length > 0
      ? await supabase
          .from("warehouse_shipments")
          .select(
            "id, tracking_number, carrier, service, label_data, shipstation_order_id, ship_date",
          )
          .in("id", shipmentIds)
      : { data: [] };

  const progress = (batch.progress ?? {}) as {
    total?: number;
    succeeded?: number;
    failed?: number;
    per_order?: Record<string, PerOrderEntry>;
  };
  const perOrder = Object.values(progress.per_order ?? {});
  const failedRows = perOrder.filter((p) => !p.ok);

  const succeeded = progress.succeeded ?? 0;
  const failed = progress.failed ?? 0;
  const total = progress.total ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Print batch</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {batch.id.slice(0, 8)} · status: {batch.status} · created{" "}
            {new Date(batch.created_at as string).toLocaleString()}
          </p>
        </div>
        <Link href="/admin/orders" className="text-sm text-blue-600 hover:underline">
          ← Back to orders
        </Link>
      </div>

      <div className="rounded-md border bg-muted/20 p-3 text-sm">
        <strong>{total}</strong> total · <strong>{succeeded}</strong> ok · <strong>{failed}</strong>{" "}
        failed
      </div>

      {failedRows.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
          <h2 className="mb-1 font-semibold text-red-900">Failed ({failedRows.length})</h2>
          <ul className="space-y-1 text-xs">
            {failedRows.map((r) => (
              <li key={r.uuid} className="font-mono">
                {r.uuid.slice(0, 8)}: {r.error ?? "unknown error"}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-red-800">
            Re-select these orders in the cockpit and re-run the bulk buy to retry.
          </p>
        </div>
      )}

      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Tracking</th>
              <th className="px-3 py-2 text-left">Carrier / Service</th>
              <th className="px-3 py-2 text-left">SS Order</th>
              <th className="px-3 py-2 text-right">Label</th>
            </tr>
          </thead>
          <tbody>
            {(shipments ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No labels purchased in this batch.
                </td>
              </tr>
            )}
            {(shipments ?? []).map((s) => {
              const labelData = (s.label_data ?? {}) as Record<string, unknown>;
              const labelUrl = typeof labelData.label_url === "string" ? labelData.label_url : null;
              return (
                <tr key={s.id as string} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">
                    {(s.tracking_number as string | null) ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {(s.carrier as string | null) ?? "—"} · {(s.service as string | null) ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {String((s.shipstation_order_id as string | null) ?? "—").slice(0, 12)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {labelUrl ? (
                      <a
                        href={labelUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        Open PDF →
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Batch expires {new Date(batch.expires_at as string).toLocaleString()} (purged nightly).
      </p>
    </div>
  );
}
