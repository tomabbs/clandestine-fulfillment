"use client";

import { Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createBillingAdjustment,
  createBillingRule,
  createClientOverride,
  createFormatCost,
  deleteClientOverride,
  getAuthWorkspaceId,
  getBillingRules,
  getBillingSnapshotDetail,
  getBillingSnapshots,
  getClientOverrides,
  getFormatCosts,
  updateBillingRule,
  updateFormatCost,
} from "@/actions/billing";
import { getClients } from "@/actions/clients";
import { type PageSize, PaginationBar } from "@/components/shared/pagination-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { WarehouseBillingRule, WarehouseFormatCost } from "@/lib/shared/types";

type Tab = "snapshots" | "default-rates" | "client-overrides" | "formats" | "adjustments";

function formatDateUTC(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(0, 10);
}

export default function BillingPage() {
  const [hydrated, setHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("snapshots");

  const {
    data: workspaceId,
    isLoading: wsLoading,
    error: wsError,
  } = useAppQuery({
    queryKey: ["auth", "workspace-id"],
    queryFn: () => getAuthWorkspaceId(),
    tier: CACHE_TIERS.SESSION,
  });

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated || wsLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <h1 className="sr-only">Billing</h1>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading billing...
      </div>
    );
  }

  if (wsError) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight mb-4">Billing</h1>
        <Card>
          <CardContent className="py-8 text-center text-destructive">
            {(wsError as Error).message}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight mb-4">Billing</h1>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            You are not authorized to view billing.
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "snapshots", label: "Snapshots" },
    { key: "default-rates", label: "Default Rates" },
    { key: "client-overrides", label: "Client Overrides" },
    { key: "formats", label: "Format Costs" },
    { key: "adjustments", label: "Adjustments" },
  ];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "snapshots" && <SnapshotsTab workspaceId={workspaceId} />}
      {activeTab === "default-rates" && <DefaultRatesTab workspaceId={workspaceId} />}
      {activeTab === "client-overrides" && <ClientOverridesTab workspaceId={workspaceId} />}
      {activeTab === "formats" && <FormatCostsTab workspaceId={workspaceId} />}
      {activeTab === "adjustments" && <AdjustmentsTab workspaceId={workspaceId} />}
    </div>
  );
}

// === Status Badge ===

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

// === Snapshots Tab ===

function SnapshotsTab({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.snapshots({ page, pageSize }),
    queryFn: () => getBillingSnapshots({ workspaceId, page, pageSize }),
  });

  if (selectedId) {
    return <SnapshotDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="space-y-4">
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading snapshots…</p>
      ) : !data?.snapshots.length ? (
        <p className="text-muted-foreground text-sm">No billing snapshots yet.</p>
      ) : (
        <>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Organization</th>
                  <th className="text-left p-3 font-medium">Period</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-right p-3 font-medium">Grand Total</th>
                  <th className="text-right p-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.snapshots.map((s) => (
                  <tr
                    key={s.id}
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelectedId(s.id)}
                  >
                    <td className="p-3">{s.organizations?.name ?? s.org_id}</td>
                    <td className="p-3">{s.billing_period}</td>
                    <td className="p-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="p-3 text-right font-mono">${s.grand_total.toFixed(2)}</td>
                    <td className="p-3 text-right text-muted-foreground">
                      {formatDateUTC(s.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </>
      )}
    </div>
  );
}

// === Snapshot Detail (Rule #16 — included/excluded shipments with reasons) ===

function SnapshotDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: ["billing", "snapshot-detail", id],
    queryFn: () => getBillingSnapshotDetail(id),
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading snapshot…</p>;
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">Snapshot not found.</p>;
  }

  const { snapshot, adjustments } = data;
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
  const excluded = (sd.excluded_shipments ?? []) as Array<{
    shipment_id: string;
    tracking_number: string | null;
    reason: string;
  }>;
  const storageItems = (sd.storage_line_items ?? []) as Array<{
    sku: string;
    total_inventory: number;
    active_stock_threshold: number;
    billable_units: number;
    storage_fee: number;
  }>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <div>
          <h2 className="text-lg font-semibold">
            {snapshot.organizations?.name} — {snapshot.billing_period}
          </h2>
          <StatusBadge status={snapshot.status} />
        </div>
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

      {/* Included Shipments */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Included Shipments ({included.length})</h3>
        {included.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shipments included.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
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
        )}
      </div>

      {/* Excluded Shipments — Rule #16 debug view */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Excluded Shipments ({excluded.length})</h3>
        {excluded.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shipments excluded.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Shipment ID</th>
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {excluded.map((s) => (
                  <tr key={s.shipment_id}>
                    <td className="p-2 font-mono text-xs">{s.shipment_id.slice(0, 8)}…</td>
                    <td className="p-2 font-mono text-xs">{s.tracking_number ?? "—"}</td>
                    <td className="p-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                        {s.reason.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Storage Line Items */}
      {storageItems.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Storage Charges</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">SKU</th>
                  <th className="text-right p-2 font-medium">Inventory</th>
                  <th className="text-right p-2 font-medium">Active Stock</th>
                  <th className="text-right p-2 font-medium">Billable</th>
                  <th className="text-right p-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {storageItems.map((item) => (
                  <tr key={item.sku}>
                    <td className="p-2 font-mono text-xs">{item.sku}</td>
                    <td className="p-2 text-right">{item.total_inventory}</td>
                    <td className="p-2 text-right">{item.active_stock_threshold}</td>
                    <td className="p-2 text-right">{item.billable_units}</td>
                    <td className="p-2 text-right font-mono">${item.storage_fee.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Adjustments */}
      {adjustments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Adjustments</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Reason</th>
                  <th className="text-right p-2 font-medium">Amount</th>
                  <th className="text-right p-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {adjustments.map((a) => (
                  <tr key={a.id}>
                    <td className="p-2">{a.reason ?? "—"}</td>
                    <td className="p-2 text-right font-mono">${a.amount.toFixed(2)}</td>
                    <td className="p-2 text-right text-muted-foreground">
                      {formatDateUTC(a.created_at)}
                    </td>
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

// === Default Rates Tab (renamed from Rules) ===

function DefaultRatesTab({ workspaceId }: { workspaceId: string }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<WarehouseBillingRule>>({});
  const [showNew, setShowNew] = useState(false);
  const [newRule, setNewRule] = useState({
    rule_name: "",
    rule_type: "per_shipment" as WarehouseBillingRule["rule_type"],
    amount: 0,
    description: "",
    is_active: true,
    effective_from: new Date().toISOString().split("T")[0],
  });

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.STABLE,
    queryKey: queryKeys.billing.rules(),
    queryFn: () => getBillingRules(workspaceId),
  });

  const updateMutation = useAppMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WarehouseBillingRule> }) =>
      updateBillingRule(id, data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Omit<WarehouseBillingRule, "id" | "created_at">) => createBillingRule(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const handleSave = useCallback(
    (id: string) => {
      updateMutation.mutate({ id, data: editValues }, { onSuccess: () => setEditingId(null) });
    },
    [editValues, updateMutation],
  );

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading default rates…</p>;
  }

  const rules = data?.rules ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "Add Rate"}
        </Button>
      </div>

      {showNew && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Rule name"
              value={newRule.rule_name}
              onChange={(e) => setNewRule((r) => ({ ...r, rule_name: e.target.value }))}
            />
            <select
              className="border rounded-md px-3 py-2 text-sm"
              value={newRule.rule_type}
              onChange={(e) =>
                setNewRule((r) => ({
                  ...r,
                  rule_type: e.target.value as WarehouseBillingRule["rule_type"],
                }))
              }
            >
              <option value="per_shipment">Per Shipment</option>
              <option value="per_item">Per Item</option>
              <option value="storage">Storage</option>
              <option value="material">Material</option>
              <option value="adjustment">Adjustment</option>
            </select>
            <Input
              type="number"
              step="0.01"
              placeholder="Amount"
              value={newRule.amount || ""}
              onChange={(e) =>
                setNewRule((r) => ({ ...r, amount: Number.parseFloat(e.target.value) || 0 }))
              }
            />
            <Input
              type="date"
              value={newRule.effective_from}
              onChange={(e) => setNewRule((r) => ({ ...r, effective_from: e.target.value }))}
            />
          </div>
          <Input
            placeholder="Description"
            value={newRule.description}
            onChange={(e) => setNewRule((r) => ({ ...r, description: e.target.value }))}
          />
          <Button
            size="sm"
            onClick={() =>
              createMutation.mutate(
                { ...newRule, workspace_id: workspaceId },
                { onSuccess: () => setShowNew(false) },
              )
            }
          >
            Create Rate
          </Button>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Type</th>
              <th className="text-right p-3 font-medium">Current Rate</th>
              <th className="text-left p-3 font-medium">Effective From</th>
              <th className="text-right p-3 font-medium">Last Updated</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rules.map((rule) => {
              const isEditing = editingId === rule.id;
              return (
                <tr key={rule.id}>
                  <td className="p-3">
                    {isEditing ? (
                      <Input
                        value={editValues.rule_name ?? rule.rule_name}
                        onChange={(e) =>
                          setEditValues((v) => ({ ...v, rule_name: e.target.value }))
                        }
                      />
                    ) : (
                      rule.rule_name
                    )}
                  </td>
                  <td className="p-3 text-muted-foreground">{rule.rule_type.replace(/_/g, " ")}</td>
                  <td className="p-3 text-right font-mono">
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right"
                        value={editValues.amount ?? rule.amount}
                        onChange={(e) =>
                          setEditValues((v) => ({
                            ...v,
                            amount: Number.parseFloat(e.target.value) || 0,
                          }))
                        }
                      />
                    ) : (
                      `$${rule.amount.toFixed(2)}`
                    )}
                  </td>
                  <td className="p-3 text-muted-foreground">{rule.effective_from}</td>
                  <td className="p-3 text-right text-muted-foreground">
                    {formatDateUTC(rule.created_at)}
                  </td>
                  <td className="p-3 text-right">
                    {isEditing ? (
                      <div className="flex gap-1 justify-end">
                        <Button size="sm" onClick={() => handleSave(rule.id)}>
                          Save
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(rule.id);
                          setEditValues({
                            rule_name: rule.rule_name,
                            amount: rule.amount,
                            description: rule.description,
                          });
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// === Client Overrides Tab ===

function ClientOverridesTab({ workspaceId }: { workspaceId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    org_id: "",
    rule_id: "",
    override_amount: 0,
    effective_from: new Date().toISOString().split("T")[0],
  });

  const { data: overrides, isLoading } = useAppQuery({
    tier: CACHE_TIERS.STABLE,
    queryKey: queryKeys.billing.overrides(),
    queryFn: () => getClientOverrides(workspaceId),
  });

  const { data: rulesData } = useAppQuery({
    tier: CACHE_TIERS.STABLE,
    queryKey: queryKeys.billing.rules(),
    queryFn: () => getBillingRules(workspaceId),
  });

  const { data: clientsData } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.clients.list(),
    queryFn: () => getClients({ pageSize: 200 }),
    enabled: showForm,
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Parameters<typeof createClientOverride>[0]) => createClientOverride(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const deleteMutation = useAppMutation({
    mutationFn: (id: string) => deleteClientOverride(id),
    invalidateKeys: [queryKeys.billing.all],
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Override"}
        </Button>
      </div>

      {showForm && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <select
              className="border rounded-md px-3 py-2 text-sm"
              value={form.org_id}
              onChange={(e) => setForm((f) => ({ ...f, org_id: e.target.value }))}
            >
              <option value="">Select client…</option>
              {clientsData?.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="border rounded-md px-3 py-2 text-sm"
              value={form.rule_id}
              onChange={(e) => setForm((f) => ({ ...f, rule_id: e.target.value }))}
            >
              <option value="">Select rule type…</option>
              {rulesData?.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.rule_name} ({r.rule_type.replace(/_/g, " ")})
                </option>
              ))}
            </select>
            <Input
              type="number"
              step="0.01"
              placeholder="Override amount"
              value={form.override_amount || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  override_amount: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
            <Input
              type="date"
              value={form.effective_from}
              onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))}
            />
          </div>
          <Button
            size="sm"
            disabled={!form.org_id || !form.rule_id}
            onClick={() =>
              createMutation.mutate(
                { ...form, workspace_id: workspaceId },
                {
                  onSuccess: () => {
                    setShowForm(false);
                    setForm({
                      org_id: "",
                      rule_id: "",
                      override_amount: 0,
                      effective_from: new Date().toISOString().split("T")[0],
                    });
                  },
                },
              )
            }
          >
            Create Override
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading overrides…</p>
      ) : !overrides?.length ? (
        <p className="text-sm text-muted-foreground">
          No client overrides configured. All clients use default rates.
        </p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Client</th>
                <th className="text-left p-3 font-medium">Rule Type</th>
                <th className="text-right p-3 font-medium">Override Rate</th>
                <th className="text-left p-3 font-medium">Effective From</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {overrides.map((o) => (
                <tr key={o.id}>
                  <td className="p-3">{o.organizations.name}</td>
                  <td className="p-3 text-muted-foreground">
                    {o.warehouse_billing_rules.rule_name} (
                    {o.warehouse_billing_rules.rule_type.replace(/_/g, " ")})
                  </td>
                  <td className="p-3 text-right font-mono">${o.override_amount.toFixed(2)}</td>
                  <td className="p-3 text-muted-foreground">{o.effective_from}</td>
                  <td className="p-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => deleteMutation.mutate(o.id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// === Format Costs Tab ===

function FormatCostsTab({ workspaceId }: { workspaceId: string }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<WarehouseFormatCost>>({});
  const [showNew, setShowNew] = useState(false);
  const [newFormat, setNewFormat] = useState({
    format_name: "",
    pick_pack_cost: 0,
    material_cost: 0,
    sort_order: 0,
  });

  const { data: formatCosts, isLoading } = useAppQuery({
    tier: CACHE_TIERS.STABLE,
    queryKey: ["billing", "format-costs"],
    queryFn: () => getFormatCosts(workspaceId),
  });

  const updateMutation = useAppMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WarehouseFormatCost> }) =>
      updateFormatCost(id, data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Omit<WarehouseFormatCost, "id" | "created_at" | "updated_at">) =>
      createFormatCost(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading format costs…</p>;
  }

  const costs = formatCosts ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "Add Format Cost"}
        </Button>
      </div>

      {showNew && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Input
              placeholder="Format name (e.g. LP)"
              value={newFormat.format_name}
              onChange={(e) => setNewFormat((f) => ({ ...f, format_name: e.target.value }))}
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Pick & Pack cost"
              value={newFormat.pick_pack_cost || ""}
              onChange={(e) =>
                setNewFormat((f) => ({
                  ...f,
                  pick_pack_cost: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Material cost"
              value={newFormat.material_cost || ""}
              onChange={(e) =>
                setNewFormat((f) => ({
                  ...f,
                  material_cost: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
          </div>
          <Button
            size="sm"
            onClick={() =>
              createMutation.mutate(
                {
                  ...newFormat,
                  workspace_id: workspaceId,
                  format_key: newFormat.format_name.toLowerCase().replace(/\s+/g, "_"),
                  display_name: newFormat.format_name,
                  cost_breakdown: {
                    pick_pack: newFormat.pick_pack_cost,
                    material: newFormat.material_cost,
                  },
                },
                { onSuccess: () => setShowNew(false) },
              )
            }
          >
            Create Format Cost
          </Button>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Format Key</th>
              <th className="text-left p-3 font-medium">Display Name</th>
              <th className="text-right p-3 font-medium">Combined Cost</th>
              <th className="text-left p-3 font-medium">Cost Breakdown</th>
              <th className="text-right p-3 font-medium">Sort Order</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {costs.map((fc) => {
              const isEditing = editingId === fc.id;
              const combinedCost = fc.pick_pack_cost + fc.material_cost;
              const breakdown = fc.cost_breakdown ?? {
                pick_pack: fc.pick_pack_cost,
                material: fc.material_cost,
              };

              return (
                <tr key={fc.id}>
                  <td className="p-3 font-mono text-xs">{fc.format_key ?? "—"}</td>
                  <td className="p-3 font-medium">{fc.display_name ?? fc.format_name}</td>
                  <td className="p-3 text-right font-mono">
                    {isEditing ? (
                      <div className="space-y-1">
                        <Input
                          type="number"
                          step="0.01"
                          className="text-right"
                          placeholder="Pick & Pack"
                          value={editValues.pick_pack_cost ?? fc.pick_pack_cost}
                          onChange={(e) =>
                            setEditValues((v) => ({
                              ...v,
                              pick_pack_cost: Number.parseFloat(e.target.value) || 0,
                            }))
                          }
                        />
                        <Input
                          type="number"
                          step="0.01"
                          className="text-right"
                          placeholder="Material"
                          value={editValues.material_cost ?? fc.material_cost}
                          onChange={(e) =>
                            setEditValues((v) => ({
                              ...v,
                              material_cost: Number.parseFloat(e.target.value) || 0,
                            }))
                          }
                        />
                      </div>
                    ) : (
                      `$${combinedCost.toFixed(2)}`
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    <span className="font-mono">
                      P&P: ${(breakdown.pick_pack ?? 0).toFixed(2)}, Mat: $
                      {(breakdown.material ?? 0).toFixed(2)}
                    </span>
                  </td>
                  <td className="p-3 text-right text-muted-foreground">{fc.sort_order}</td>
                  <td className="p-3 text-right">
                    {isEditing ? (
                      <div className="flex gap-1 justify-end">
                        <Button
                          size="sm"
                          onClick={() => {
                            updateMutation.mutate(
                              { id: fc.id, data: editValues },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }}
                        >
                          Save
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingId(fc.id);
                          setEditValues({
                            pick_pack_cost: fc.pick_pack_cost,
                            material_cost: fc.material_cost,
                          });
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// === Adjustments Tab ===

function AdjustmentsTab({ workspaceId }: { workspaceId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    org_id: "",
    billing_period: "",
    amount: 0,
    reason: "",
  });

  const { isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.snapshots({ adjustments: true }),
    queryFn: () => getBillingSnapshots({ workspaceId: workspaceId, pageSize: 100 }),
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Parameters<typeof createBillingAdjustment>[0]) =>
      createBillingAdjustment(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Adjustment"}
        </Button>
      </div>

      {showForm && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Organization ID"
              value={form.org_id}
              onChange={(e) => setForm((f) => ({ ...f, org_id: e.target.value }))}
            />
            <Input
              placeholder="Billing Period (YYYY-MM)"
              value={form.billing_period}
              onChange={(e) => setForm((f) => ({ ...f, billing_period: e.target.value }))}
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Amount (negative for credit)"
              value={form.amount || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  amount: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
          </div>
          <Input
            placeholder="Reason"
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
          <Button
            size="sm"
            disabled={!form.org_id || !form.billing_period || !form.reason}
            onClick={() =>
              createMutation.mutate(
                { ...form, workspace_id: workspaceId },
                {
                  onSuccess: () => {
                    setShowForm(false);
                    setForm({ org_id: "", billing_period: "", amount: 0, reason: "" });
                  },
                },
              )
            }
          >
            Create Adjustment
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Adjustments are shown in snapshot detail views. Use the form above to create adjustments
          for a specific org and billing period.
        </p>
      )}
    </div>
  );
}
