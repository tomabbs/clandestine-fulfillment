"use client";

import { useState } from "react";
import { getUserContext } from "@/actions/auth";
import {
  getClientBillingSnapshotDetail,
  getClientBillingSnapshots,
  getClientCurrentMonthPreview,
} from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-yellow-100 text-yellow-800",
    sent: "bg-blue-100 text-blue-800",
    paid: "bg-green-100 text-green-800",
    overdue: "bg-red-100 text-red-800",
    void: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        colors[status] ?? "bg-gray-100 text-gray-800"
      }`}
    >
      {status}
    </span>
  );
}

export default function BillingPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";
  const orgId = ctx?.orgId ?? "";

  const { data, isLoading, error } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.snapshots({ orgId }),
    queryFn: () => getClientBillingSnapshots({ pageSize: 50 }),
    enabled: !!workspaceId && !!orgId,
  });

  const { data: preview } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: ["billing-preview", orgId],
    queryFn: () => getClientCurrentMonthPreview(),
    enabled: !!workspaceId && !!orgId,
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  if (selectedId) {
    return <SnapshotDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      {preview && (
        <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold">Current Month ({preview.billingPeriod})</h2>
            <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">
              Estimated
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Shipments</p>
              <p className="font-mono font-medium">{preview.shipmentCount}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Shipping</p>
              <p className="font-mono font-medium">${preview.totalShipping.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Storage</p>
              <p className="font-mono font-medium">${preview.totalStorage.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Est. Total</p>
              <p className="font-mono font-semibold">${preview.estimatedTotal.toFixed(2)}</p>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading billing history…</p>
      ) : !data?.snapshots.length ? (
        <p className="text-muted-foreground text-sm">No billing statements yet.</p>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Period</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-right p-3 font-medium">Total</th>
                <th className="text-right p-3 font-medium">Date</th>
                <th className="text-right p-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.snapshots.map((s) => {
                const snapshotWarnings =
                  ((s.snapshot_data as Record<string, unknown> | null)?.warnings as
                    | string[]
                    | undefined) ?? [];
                return (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="p-3 font-medium">
                      {s.billing_period}
                      {snapshotWarnings.length > 0 && (
                        <p className="text-xs text-yellow-600 mt-0.5">Billing note attached</p>
                      )}
                    </td>
                    <td className="p-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="p-3 text-right font-mono">${s.grand_total.toFixed(2)}</td>
                    <td className="p-3 text-right text-muted-foreground">
                      {new Date(s.created_at).toLocaleDateString()}
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <Button variant="outline" size="sm" onClick={() => setSelectedId(s.id)}>
                          View
                        </Button>
                        {s.stripe_invoice_id && (
                          <a
                            href={`https://invoice.stripe.com/i/${s.stripe_invoice_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-2.5 h-7 text-[0.8rem] font-medium hover:bg-muted hover:text-foreground transition-all"
                          >
                            Download
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// === Read-only Snapshot Detail ===

function SnapshotDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: ["billing", "snapshot-detail", id],
    queryFn: () => getClientBillingSnapshotDetail(id),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground text-sm">Loading statement…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground text-sm">Statement not found.</p>
      </div>
    );
  }

  const { snapshot } = data;
  const sd = snapshot.snapshot_data as Record<string, unknown>;
  const included = (sd.included_shipments ?? []) as Array<{
    shipment_id: string;
    tracking_number: string | null;
    ship_date: string | null;
    carrier: string | null;
    shipping_cost: number;
    format_name: string;
    pick_pack_cost: number;
    material_cost: number;
  }>;
  const storageItems = (sd.storage_line_items ?? []) as Array<{
    sku: string;
    billable_units: number;
    storage_fee: number;
  }>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Statement — {snapshot.billing_period}
          </h1>
          <StatusBadge status={snapshot.status} />
        </div>
        {snapshot.stripe_invoice_id && (
          <a
            href={`https://invoice.stripe.com/i/${snapshot.stripe_invoice_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center justify-center rounded-lg border border-border bg-background px-2.5 h-7 text-[0.8rem] font-medium hover:bg-muted hover:text-foreground transition-all"
          >
            Download Invoice
          </a>
        )}
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: "Shipping", value: snapshot.total_shipping },
          { label: "Pick & Pack", value: snapshot.total_pick_pack },
          { label: "Materials", value: snapshot.total_materials },
          { label: "Storage", value: snapshot.total_storage },
          { label: "Adjustments", value: snapshot.total_adjustments },
          { label: "Grand Total", value: snapshot.grand_total },
        ].map((item) => (
          <div key={item.label} className="border rounded-lg p-3">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="text-lg font-mono font-semibold">${(item.value ?? 0).toFixed(2)}</p>
          </div>
        ))}
      </div>

      {/* Shipments */}
      {included.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Shipments ({included.length})</h3>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Ship Date</th>
                  <th className="text-left p-2 font-medium">Carrier</th>
                  <th className="text-left p-2 font-medium">Format</th>
                  <th className="text-right p-2 font-medium">Shipping</th>
                  <th className="text-right p-2 font-medium">Pick/Pack</th>
                  <th className="text-right p-2 font-medium">Material</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {included.map((s) => (
                  <tr key={s.shipment_id}>
                    <td className="p-2 font-mono text-xs">{s.tracking_number ?? "—"}</td>
                    <td className="p-2">{s.ship_date ?? "—"}</td>
                    <td className="p-2">{s.carrier ?? "—"}</td>
                    <td className="p-2">{s.format_name}</td>
                    <td className="p-2 text-right font-mono">${s.shipping_cost.toFixed(2)}</td>
                    <td className="p-2 text-right font-mono">${s.pick_pack_cost.toFixed(2)}</td>
                    <td className="p-2 text-right font-mono">${s.material_cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Storage */}
      {storageItems.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Storage Charges</h3>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">SKU</th>
                  <th className="text-right p-2 font-medium">Billable Units</th>
                  <th className="text-right p-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {storageItems.map((item) => (
                  <tr key={item.sku}>
                    <td className="p-2 font-mono text-xs">{item.sku}</td>
                    <td className="p-2 text-right">{item.billable_units}</td>
                    <td className="p-2 text-right font-mono">${item.storage_fee.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
