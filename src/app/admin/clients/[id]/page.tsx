"use client";

import { ArrowLeft, CheckCircle, Circle, Loader2, Package, Search, Ship } from "lucide-react";
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
  updateOnboardingStep,
} from "@/actions/clients";
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
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.settings(orgId),
    queryFn: () => getClientSettings(orgId),
    tier: CACHE_TIERS.SESSION,
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

  return (
    <div className="space-y-6 pt-4">
      {/* Org fields */}
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <SettingsField
              label="Service Type"
              value={SERVICE_TYPE_LABELS[serviceType] ?? serviceType}
            />
            <SettingsField
              label="Shopify Vendor Name"
              value={org.shopify_vendor_name as string | null}
            />
            <SettingsField label="Pirate Ship Name" value={org.pirate_ship_name as string | null} />
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
        </CardContent>
      </Card>

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
