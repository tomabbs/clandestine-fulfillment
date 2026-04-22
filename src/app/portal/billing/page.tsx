"use client";

import { useMemo, useState } from "react";
import { getUserContext } from "@/actions/auth";
import {
  getClientBillingSnapshotDetail,
  getClientBillingSnapshots,
  getClientCurrentMonthPreview,
} from "@/actions/billing";
import { BlockList } from "@/components/shared/block-list";
import { Button } from "@/components/ui/button";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { type QueryScope, queryKeysV2 } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// Portal billing: viewer="client" + workspaceId + orgId. The viewer dim
// matters here because getClientBillingSnapshotDetail returns a DIFFERENT
// shape than the admin getBillingSnapshotDetail used in /admin/billing —
// without the viewer slot, switching auth contexts could serve the wrong shape.
function makePortalScope(workspaceId: string, orgId: string): QueryScope {
  return { workspaceId, orgId, viewer: "client" };
}

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

function BillingMetric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-sm" : "text-sm"}>{value}</p>
    </div>
  );
}

export default function BillingPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: ctx } = useAppQuery({
    queryKey: queryKeysV2.authContext.user("client"),
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";
  const orgId = ctx?.orgId ?? "";
  const scopeReady = !!workspaceId && !!orgId;
  // Always build a stable scope object — when scopeReady is false the enabled
  // gate prevents the query from running, so the placeholder workspaceId/orgId
  // values never reach the server. Keeping the scope shape stable avoids two
  // distinct cache buckets churning on hydration.
  const scope: QueryScope = useMemo(
    () => makePortalScope(workspaceId || "_", orgId || "_"),
    [workspaceId, orgId],
  );

  const { data, isLoading, error } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.billing.snapshots(scope),
    queryFn: () => getClientBillingSnapshots({ pageSize: 50 }),
    enabled: scopeReady,
  });

  const { data: preview } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.billing.preview(scope),
    queryFn: () => getClientCurrentMonthPreview(),
    enabled: scopeReady,
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
    return (
      <SnapshotDetail
        id={selectedId}
        scope={scope}
        scopeReady={scopeReady}
        onBack={() => setSelectedId(null)}
      />
    );
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
        <BlockList
          className="mt-2"
          items={data.snapshots}
          itemKey={(s) => s.id}
          density="ops"
          ariaLabel="Billing statements"
          renderHeader={({ row: s }) => (
            <div>
              <p className="font-medium">{s.billing_period}</p>
              {((
                (s.snapshot_data as Record<string, unknown> | null)?.warnings as
                  | string[]
                  | undefined
              )?.length ?? 0) > 0 && (
                <p className="text-xs text-yellow-600 mt-0.5">Billing note attached</p>
              )}
            </div>
          )}
          renderExceptionZone={({ row: s }) => <StatusBadge status={s.status} />}
          renderBody={({ row: s }) => (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <BillingMetric label="Total" value={`$${s.grand_total.toFixed(2)}`} mono />
              <BillingMetric label="Date" value={new Date(s.created_at).toLocaleDateString()} />
            </div>
          )}
          renderActions={({ row: s }) => (
            <div className="flex gap-2">
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
          )}
        />
      )}
    </div>
  );
}

// === Read-only Snapshot Detail ===

function SnapshotDetail({
  id,
  scope,
  scopeReady,
  onBack,
}: {
  id: string;
  scope: QueryScope;
  scopeReady: boolean;
  onBack: () => void;
}) {
  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.billing.snapshotDetail(scope, id),
    queryFn: () => getClientBillingSnapshotDetail(id),
    enabled: scopeReady,
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
          <BlockList
            className="mt-2"
            items={included}
            itemKey={(s) => s.shipment_id}
            density="ops"
            ariaLabel="Included shipments"
            renderHeader={({ row: s }) => (
              <p className="font-mono text-xs">{s.tracking_number ?? "—"}</p>
            )}
            renderBody={({ row: s }) => (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <BillingMetric label="Ship Date" value={s.ship_date ?? "—"} />
                <BillingMetric label="Carrier" value={s.carrier ?? "—"} />
                <BillingMetric label="Format" value={s.format_name} />
                <BillingMetric label="Shipping" value={`$${s.shipping_cost.toFixed(2)}`} mono />
                <BillingMetric label="Pick/Pack" value={`$${s.pick_pack_cost.toFixed(2)}`} mono />
                <BillingMetric label="Material" value={`$${s.material_cost.toFixed(2)}`} mono />
              </div>
            )}
          />
        </div>
      )}

      {/* Storage */}
      {storageItems.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Storage Charges</h3>
          <BlockList
            className="mt-2"
            items={storageItems}
            itemKey={(item) => item.sku}
            density="ops"
            ariaLabel="Storage charges"
            renderHeader={({ row: item }) => <p className="font-mono text-xs">{item.sku}</p>}
            renderBody={({ row: item }) => (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <BillingMetric label="Billable Units" value={String(item.billable_units)} />
                <BillingMetric label="Fee" value={`$${item.storage_fee.toFixed(2)}`} mono />
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}
