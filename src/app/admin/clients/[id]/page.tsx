"use client";

import {
  ArrowLeft,
  CheckCircle,
  Circle,
  Loader2,
  Package,
  Plus,
  Search,
  Ship,
  Trash2,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import type { MonthlySales } from "@/actions/clients";
import {
  getClientBilling,
  getClientDetail,
  getClientProducts,
  getClientSales,
  getClientSettings,
  getClientShipments,
  getClientStores,
  getClientUsers,
  updateClient,
  updateOnboardingStep,
} from "@/actions/clients";
import { inviteUser, removeClientUser } from "@/actions/users";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SERVICE_TYPE_LABELS: Record<string, string> = {
  full_service: "Full Service",
  storage_only: "Storage Only",
  drop_ship: "Drop Ship",
};

function statusBadgeVariant(status: string) {
  switch (status) {
    case "active":
    case "paid":
    case "delivered":
    case "shipped":
      return "default" as const;
    case "draft":
    case "pending":
    case "in_transit":
      return "secondary" as const;
    case "overdue":
    case "void":
    case "archived":
    case "returned":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function formatCurrency(value: number | null | undefined) {
  if (value == null) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orgId = params.id;

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.detail(orgId),
    queryFn: () => getClientDetail(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  const stepMut = useAppMutation({
    mutationFn: ({ step, completed }: { step: string; completed: boolean }) =>
      updateOnboardingStep(orgId, step, completed),
    invalidateKeys: [queryKeys.clients.detail(orgId)],
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  const { org, onboardingSteps, productCount, variantCount, shipmentCount } = data;
  const serviceType = (org.service_type as string) ?? "full_service";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => router.push("/admin/clients")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
              <Badge variant="outline">{org.slug}</Badge>
              <Badge variant="secondary">{SERVICE_TYPE_LABELS[serviceType] ?? serviceType}</Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Package className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Products / Variants</p>
              <p className="text-xl font-semibold">
                {productCount} / {variantCount}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Ship className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Shipments</p>
              <p className="text-xl font-semibold">{shipmentCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Onboarding</p>
            <div className="flex flex-wrap gap-1">
              {onboardingSteps.map((step) => (
                <button
                  key={step.key}
                  type="button"
                  title={step.label}
                  onClick={() => stepMut.mutate({ step: step.key, completed: !step.completed })}
                >
                  {step.completed ? (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                  )}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="products">
        <TabsList variant="line">
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="shipments">Shipments</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="stores">Stores</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          <ProductsTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="shipments">
          <ShipmentsTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="sales">
          <SalesTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="billing">
          <BillingTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="stores">
          <StoresTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab orgId={orgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Tab 1: Products ─────────────────────────────────────────────────────────

function ProductsTab({ orgId }: { orgId: string }) {
  const [search, setSearch] = useState("");

  const { data: products, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.products(orgId, { search }),
    queryFn: () => getClientProducts(orgId, { search: search || undefined }),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8"
          />
        </div>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading products...
        </div>
      ) : !products || products.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8">No products found.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-center">Variants</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.title}</TableCell>
                <TableCell>{p.vendor ?? "-"}</TableCell>
                <TableCell>{p.product_type ?? "-"}</TableCell>
                <TableCell className="text-center">{p.variant_count}</TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(p.status)}>{p.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ─── Tab 2: Shipments ────────────────────────────────────────────────────────

function ShipmentsTab({ orgId }: { orgId: string }) {
  const [statusFilter, setStatusFilter] = useState<string>("");

  const { data: shipments, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.shipments(orgId, { status: statusFilter }),
    queryFn: () => getClientShipments(orgId, { status: statusFilter || undefined }),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "")}>
          <SelectTrigger size="sm">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All statuses</SelectItem>
            <SelectItem value="shipped">Shipped</SelectItem>
            <SelectItem value="in_transit">In Transit</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="returned">Returned</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading shipments...
        </div>
      ) : !shipments || shipments.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8">No shipments found.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order #</TableHead>
              <TableHead>Ship Date</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Tracking</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shipments.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.order_number ?? "-"}</TableCell>
                <TableCell>{formatDate(s.ship_date)}</TableCell>
                <TableCell>{s.carrier ?? "-"}</TableCell>
                <TableCell>
                  {s.tracking_number ? (
                    <a
                      href={trackingUrl(s.carrier, s.tracking_number)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline text-xs font-mono"
                    >
                      {s.tracking_number}
                    </a>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(s.status)}>{s.status}</Badge>
                </TableCell>
                <TableCell className="text-right">{formatCurrency(s.shipping_cost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function trackingUrl(carrier: string | null, trackingNumber: string): string {
  const c = (carrier ?? "").toLowerCase();
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
  return `https://parcelsapp.com/en/tracking/${trackingNumber}`;
}

// ─── Tab 3: Sales ────────────────────────────────────────────────────────────

function SalesTab({ orgId }: { orgId: string }) {
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.sales(orgId),
    queryFn: () => getClientSales(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading sales data...
      </div>
    );
  }

  const { months = [], totalUnits = 0, totalRevenue = 0 } = data ?? {};

  return (
    <div className="space-y-4 pt-4">
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Units Sold</p>
            <p className="text-2xl font-semibold">{totalUnits.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Revenue</p>
            <p className="text-2xl font-semibold">{formatCurrency(totalRevenue)}</p>
          </CardContent>
        </Card>
      </div>

      {months.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No sales data available.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Margin %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((m: MonthlySales) => (
              <TableRow key={m.month}>
                <TableCell className="font-medium">{formatMonth(m.month)}</TableCell>
                <TableCell className="text-right">{m.units.toLocaleString()}</TableCell>
                <TableCell className="text-right">{formatCurrency(m.revenue)}</TableCell>
                <TableCell className="text-right">{formatCurrency(m.cost)}</TableCell>
                <TableCell className="text-right">{m.margin_pct.toFixed(1)}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function formatMonth(ym: string) {
  const [year, month] = ym.split("-");
  const date = new Date(Number(year), Number(month) - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ─── Tab 4: Billing ──────────────────────────────────────────────────────────

function BillingTab({ orgId }: { orgId: string }) {
  const { data: snapshots, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.billing(orgId),
    queryFn: () => getClientBilling(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading billing...
      </div>
    );
  }

  if (!snapshots || snapshots.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 pt-4">No billing snapshots.</p>;
  }

  return (
    <div className="pt-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshots.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.billing_period}</TableCell>
              <TableCell>
                <Badge variant={statusBadgeVariant(s.status)}>{s.status}</Badge>
              </TableCell>
              <TableCell className="text-right">{formatCurrency(s.grand_total)}</TableCell>
              <TableCell>{formatDate(s.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Tab 5: Stores ───────────────────────────────────────────────────────────

function StoresTab({ orgId }: { orgId: string }) {
  const { data: stores, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.stores(orgId),
    queryFn: () => getClientStores(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading stores...
      </div>
    );
  }

  if (!stores || stores.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 pt-4">No ShipStation stores found.</p>;
  }

  return (
    <div className="pt-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Store Name</TableHead>
            <TableHead>Marketplace</TableHead>
            <TableHead>Store ID</TableHead>
            <TableHead>Last Seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stores.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.store_name ?? "-"}</TableCell>
              <TableCell>{s.marketplace_name ?? "-"}</TableCell>
              <TableCell className="font-mono text-xs">{s.store_id}</TableCell>
              <TableCell>{formatDate(s.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Tab 6: Settings ─────────────────────────────────────────────────────────

function SettingsTab({ orgId }: { orgId: string }) {
  const { data, isLoading, refetch } = useAppQuery({
    queryKey: queryKeys.clients.settings(orgId),
    queryFn: () => getClientSettings(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    billing_email: "",
    pirate_ship_name: "",
    shopify_vendor_name: "",
    stripe_customer_id: "",
    service_type: "full_service",
    storage_fee_waived: false,
  });

  const saveMut = useAppMutation({
    mutationFn: () =>
      updateClient(orgId, {
        billing_email: form.billing_email || null,
        pirate_ship_name: form.pirate_ship_name || null,
        shopify_vendor_name: form.shopify_vendor_name || null,
        stripe_customer_id: form.stripe_customer_id || null,
        service_type: form.service_type || null,
        storage_fee_waived: form.storage_fee_waived,
      }),
    invalidateKeys: [queryKeys.clients.settings(orgId), queryKeys.clients.detail(orgId)],
    onSuccess: () => {
      setEditing(false);
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings...
      </div>
    );
  }

  if (!data?.org) {
    return <p className="text-sm text-muted-foreground py-8 pt-4">Settings not available.</p>;
  }

  const { org, portalSettings, billingRules } = data;
  const serviceType = (org.service_type as string) ?? "full_service";

  const startEdit = () => {
    setForm({
      billing_email: (org.billing_email as string) ?? "",
      pirate_ship_name: (org.pirate_ship_name as string) ?? "",
      shopify_vendor_name: (org.shopify_vendor_name as string) ?? "",
      stripe_customer_id: (org.stripe_customer_id as string) ?? "",
      service_type: serviceType,
      storage_fee_waived: !!org.storage_fee_waived,
    });
    setEditing(true);
  };

  return (
    <div className="space-y-6 pt-4">
      {/* Org fields */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Organization</CardTitle>
            {!editing && (
              <Button variant="outline" size="sm" onClick={startEdit}>
                Edit Settings
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="set-svc" className="text-sm font-medium mb-1 block">
                  Service Type
                </label>
                <select
                  id="set-svc"
                  value={form.service_type}
                  onChange={(e) => setForm((f) => ({ ...f, service_type: e.target.value }))}
                  className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm"
                >
                  <option value="full_service">Full Service</option>
                  <option value="storage_only">Storage Only</option>
                  <option value="drop_ship">Drop Ship</option>
                </select>
              </div>
              <div>
                <label htmlFor="set-vendor" className="text-sm font-medium mb-1 block">
                  Shopify Vendor Name
                </label>
                <Input
                  id="set-vendor"
                  value={form.shopify_vendor_name}
                  onChange={(e) => setForm((f) => ({ ...f, shopify_vendor_name: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="set-ps" className="text-sm font-medium mb-1 block">
                  Pirate Ship Name
                </label>
                <Input
                  id="set-ps"
                  value={form.pirate_ship_name}
                  onChange={(e) => setForm((f) => ({ ...f, pirate_ship_name: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="set-stripe" className="text-sm font-medium mb-1 block">
                  Stripe Customer ID
                </label>
                <Input
                  id="set-stripe"
                  value={form.stripe_customer_id}
                  onChange={(e) => setForm((f) => ({ ...f, stripe_customer_id: e.target.value }))}
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <label htmlFor="set-email" className="text-sm font-medium mb-1 block">
                  Billing Email
                </label>
                <Input
                  id="set-email"
                  type="email"
                  value={form.billing_email}
                  onChange={(e) => setForm((f) => ({ ...f, billing_email: e.target.value }))}
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input
                  id="set-waived"
                  type="checkbox"
                  checked={form.storage_fee_waived}
                  onChange={(e) => setForm((f) => ({ ...f, storage_fee_waived: e.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                <label htmlFor="set-waived" className="text-sm font-medium">
                  Storage Fee Waived
                </label>
              </div>
              <div className="col-span-2 flex gap-2 pt-2">
                <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                  {saveMut.isPending ? "Saving..." : "Save Settings"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <SettingsField
                label="Service Type"
                value={SERVICE_TYPE_LABELS[serviceType] ?? serviceType}
              />
              <SettingsField
                label="Shopify Vendor Name"
                value={org.shopify_vendor_name as string | null}
              />
              <SettingsField
                label="Pirate Ship Name"
                value={org.pirate_ship_name as string | null}
              />
              <SettingsField
                label="Stripe Customer ID"
                value={org.stripe_customer_id as string | null}
                mono
              />
              <SettingsField
                label="Storage Fee Waived"
                value={org.storage_fee_waived ? "Yes" : "No"}
              />
              <SettingsField label="Billing Email" value={org.billing_email as string | null} />
            </dl>
          )}
        </CardContent>
      </Card>

      {/* Client Users */}
      <ClientUsersCard orgId={orgId} />

      {/* Portal toggles */}
      <Card>
        <CardHeader>
          <CardTitle>Portal Settings</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(portalSettings).length === 0 ? (
            <p className="text-sm text-muted-foreground">Default portal configuration.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              {Object.entries(portalSettings).map(([key, value]) => (
                <SettingsField key={key} label={key.replace(/_/g, " ")} value={String(value)} />
              ))}
            </dl>
          )}
        </CardContent>
      </Card>

      {/* Billing rates */}
      <Card>
        <CardHeader>
          <CardTitle>Effective Billing Rates</CardTitle>
        </CardHeader>
        <CardContent>
          {billingRules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active billing rules.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {billingRules.map((r) => (
                  <TableRow key={r.rule_name}>
                    <TableCell className="font-medium">{r.rule_name}</TableCell>
                    <TableCell>{r.rule_type.replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-right">{formatCurrency(r.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium ${mono ? "font-mono text-xs" : ""}`}>
        {value ?? <span className="text-muted-foreground italic">Not set</span>}
      </dd>
    </div>
  );
}

function ClientUsersCard({ orgId }: { orgId: string }) {
  const {
    data: users,
    isLoading,
    refetch,
  } = useAppQuery({
    queryKey: ["client-users", orgId],
    queryFn: () => getClientUsers(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  const [showInvite, setShowInvite] = useState(false);
  const [invEmail, setInvEmail] = useState("");
  const [invName, setInvName] = useState("");
  const [invRole, setInvRole] = useState<"client" | "client_admin">("client");
  const [invError, setInvError] = useState<string | null>(null);

  const inviteMut = useAppMutation({
    mutationFn: () =>
      inviteUser({
        email: invEmail,
        name: invName || invEmail.split("@")[0],
        role: invRole,
        orgId,
      }),
    invalidateKeys: [["client-users", orgId]],
    onSuccess: () => {
      setShowInvite(false);
      setInvEmail("");
      setInvName("");
      setInvRole("client");
      setInvError(null);
      refetch();
    },
    onError: (err) => setInvError((err as Error).message),
  });

  const removeMut = useAppMutation({
    mutationFn: (userId: string) => removeClientUser(userId),
    invalidateKeys: [["client-users", orgId]],
    onSuccess: () => refetch(),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Client Portal Users</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setShowInvite(true)}>
            <Plus className="h-4 w-4 mr-1" /> Invite User
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showInvite && (
          <div className="border rounded-lg p-4 mb-4 space-y-3">
            <p className="text-sm font-medium">Invite a client user via magic link email</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="inv-email" className="text-sm font-medium mb-1 block">
                  Email <span className="text-destructive">*</span>
                </label>
                <Input
                  id="inv-email"
                  type="email"
                  value={invEmail}
                  onChange={(e) => setInvEmail(e.target.value)}
                  placeholder="user@label.com"
                />
              </div>
              <div>
                <label htmlFor="inv-name" className="text-sm font-medium mb-1 block">
                  Name
                </label>
                <Input
                  id="inv-name"
                  value={invName}
                  onChange={(e) => setInvName(e.target.value)}
                  placeholder="Full name (optional)"
                />
              </div>
            </div>
            <div>
              <label htmlFor="inv-role" className="text-sm font-medium mb-1 block">
                Role
              </label>
              <select
                id="inv-role"
                value={invRole}
                onChange={(e) => setInvRole(e.target.value as "client" | "client_admin")}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm w-48"
              >
                <option value="client">Client (view only)</option>
                <option value="client_admin">Client Admin (can manage)</option>
              </select>
            </div>
            {invError && <p className="text-sm text-destructive">{invError}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => inviteMut.mutate()}
                disabled={!invEmail || inviteMut.isPending}
              >
                {inviteMut.isPending ? "Sending..." : "Send Invite"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setShowInvite(false);
                  setInvError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading users...
          </div>
        ) : (users ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No portal users yet. Click &ldquo;Invite User&rdquo; to send a magic link.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users ?? []).map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-mono text-xs">{user.email ?? "—"}</TableCell>
                  <TableCell>{user.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={user.role === "client_admin" ? "default" : "secondary"}>
                      {user.role === "client_admin" ? "Admin" : "Client"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(user.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeMut.mutate(user.id)}
                      disabled={removeMut.isPending}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
