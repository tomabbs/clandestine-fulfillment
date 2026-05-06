"use client";

import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Disc3,
  Loader2,
  Package,
  PackagePlus,
  Rocket,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getDashboardStats } from "@/actions/admin-dashboard";
import {
  getBandcampProductDetectionDashboard,
  getPreorderProducts,
  manualRelease,
} from "@/actions/preorders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type PreorderVariant = Awaited<ReturnType<typeof getPreorderProducts>>["variants"][number];
type BandcampProductDetection = Awaited<ReturnType<typeof getBandcampProductDetectionDashboard>>;

export default function DashboardPage() {
  const [hydrated, setHydrated] = useState(false);
  const { data: stats } = useAppQuery({
    queryKey: ["admin", "dashboard-stats"],
    queryFn: () => getDashboardStats(),
    tier: CACHE_TIERS.REALTIME,
  });

  const s = stats?.stats;

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading dashboard...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Warehouse overview</p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard icon={Package} label="Products" value={s?.totalProducts ?? 0} />
        <StatCard icon={ShoppingCart} label="Orders (month)" value={s?.monthOrders ?? 0} />
        <StatCard icon={Truck} label="Shipments (month)" value={s?.monthShipments ?? 0} />
        <StatCard
          icon={AlertTriangle}
          label="Critical Items"
          value={s?.criticalReviewItems ?? 0}
          highlight={(s?.criticalReviewItems ?? 0) > 0}
        />
        <StatCard icon={PackagePlus} label="Pending Inbound" value={s?.pendingInbound ?? 0} />
      </div>

      {/* Sync health */}
      {stats?.sensorHealth && Object.keys(stats.sensorHealth).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Integration Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.sensorHealth).map(([name, reading]) => {
                const r = reading as { status: string; message: string };
                return (
                  <div key={name} className="flex items-center gap-2 text-sm">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        r.status === "healthy"
                          ? "bg-green-500"
                          : r.status === "warning"
                            ? "bg-yellow-500"
                            : "bg-red-500"
                      }`}
                    />
                    <span className="font-mono text-xs">{name}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <UpcomingReleasesCard />
        <BandcampProductDetectionCard />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!stats?.recentActivity || stats.recentActivity.length === 0 ? (
              <p className="text-muted-foreground text-sm">No recent activity.</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-auto">
                {stats.recentActivity.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm">
                    <span className="truncate flex-1">
                      <Badge
                        variant={a.type === "sync" ? "secondary" : "outline"}
                        className="mr-2 text-xs"
                      >
                        {a.type}
                      </Badge>
                      {a.message}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                      {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BandcampProductDetectionCard() {
  const { data, isLoading } = useAppQuery<BandcampProductDetection>({
    queryKey: queryKeys.bandcamp.mappings("product-detection-dashboard-format-v3"),
    queryFn: () => getBandcampProductDetectionDashboard({ newProductDays: 30, limit: 12 }),
    tier: CACHE_TIERS.SESSION,
  });

  const summary = data?.summary;
  const newProducts = data?.newProducts ?? [];
  const dashboardMisses = data?.preorderSignals.filter((item) => item.dashboardMiss) ?? [];
  const staleSignals =
    data?.preorderSignals.filter((item) => item.signalKind === "stale_historical") ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <PackagePlus className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Bandcamp Product Detection</CardTitle>
            <CardDescription>Exceptions and recent Bandcamp listing signals</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : !data ? (
          <p className="text-muted-foreground text-sm text-center py-4">
            Product detection data unavailable.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <MiniMetric label="Recent BC" value={summary?.newProductsInWindow ?? 0} />
              <MiniMetric
                label="Missing releases"
                value={summary?.dashboardMisses ?? 0}
                highlight={(summary?.dashboardMisses ?? 0) > 0}
              />
              <MiniMetric
                label="Stale signals"
                value={summary?.staleHistorical ?? 0}
                highlight={(summary?.staleHistorical ?? 0) > 0}
              />
            </div>

            {dashboardMisses.length > 0 && (
              <DetectionSection
                title={`Needs dashboard review (${dashboardMisses.length})`}
                tone="destructive"
                items={dashboardMisses.map((item) => ({
                  id: item.id,
                  title: item.title,
                  meta: [
                    item.sku,
                    formatFormatName(item.formatName),
                    item.bandcampSubdomain,
                    item.bandcampReleaseDate?.slice(0, 10),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  href: item.bandcampUrl,
                }))}
              />
            )}

            <DetectionSection
              title={`Recently listed/released Bandcamp products (${newProducts.length})`}
              items={newProducts.slice(0, 6).map((item) => ({
                id: item.id,
                title: item.title,
                meta: [
                  item.sku,
                  formatFormatName(item.formatName),
                  item.bandcampSubdomain,
                  formatLabeledBandcampDate(
                    item.bandcampProductDate,
                    item.bandcampProductDateSource,
                  ),
                ]
                  .filter(Boolean)
                  .join(" · "),
                href: item.bandcampUrl,
              }))}
              emptyText="No recent Bandcamp listing/release dates in the last 30 days."
            />

            {staleSignals.length > 0 && (
              <DetectionSection
                title={`Historical preorder signals (${staleSignals.length})`}
                items={staleSignals.slice(0, 4).map((item) => ({
                  id: item.id,
                  title: item.title,
                  meta: [
                    item.sku,
                    formatFormatName(item.formatName),
                    item.bandcampSubdomain,
                    item.bandcampReleaseDate?.slice(0, 10),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  href: item.bandcampUrl,
                }))}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MiniMetric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${highlight ? "text-destructive" : ""}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function DetectionSection({
  title,
  items,
  emptyText,
  tone,
}: {
  title: string;
  items: Array<{ id: string; title: string; meta: string; href: string | null }>;
  emptyText?: string;
  tone?: "destructive";
}) {
  return (
    <div>
      <h3
        className={`text-xs font-medium mb-1 ${
          tone === "destructive" ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText ?? "No rows."}</p>
      ) : (
        <div className="space-y-1 max-h-44 overflow-auto">
          {items.map((item) => (
            <div key={item.id} className="text-sm">
              {item.href ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium hover:underline"
                >
                  {item.title}
                </a>
              ) : (
                <span className="font-medium">{item.title}</span>
              )}
              <p className="text-xs text-muted-foreground truncate">{item.meta || "No metadata"}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return null;
  return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString();
}

function formatLabeledBandcampDate(
  value: string | null | undefined,
  source: "release" | "listed" | null | undefined,
) {
  const date = formatShortDate(value);
  if (!date) return null;
  return `${source === "release" ? "release" : "listed"} ${date}`;
}

function formatFormatName(value: string | null | undefined) {
  return value?.trim() || null;
}

function StatCard({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: typeof Package;
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={`h-5 w-5 ${highlight ? "text-red-600" : "text-muted-foreground"}`} />
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-xl font-semibold tabular-nums ${highlight ? "text-red-600" : ""}`}>
            {value.toLocaleString()}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function UpcomingReleasesCard() {
  const { data, isLoading } = useAppQuery<Awaited<ReturnType<typeof getPreorderProducts>>>({
    queryKey: queryKeys.products.list({ preorders: true, horizonDays: 90, version: 3 }),
    queryFn: () => getPreorderProducts({ pageSize: 100 }),
    tier: CACHE_TIERS.SESSION,
  });

  const releaseMutation = useAppMutation({
    mutationFn: (variantId: string) => manualRelease(variantId),
    invalidateKeys: [queryKeys.products.all, queryKeys.orders.all],
  });

  const handleRelease = useCallback(
    (variantId: string) => releaseMutation.mutate(variantId),
    [releaseMutation],
  );

  const variants = data?.variants ?? [];
  const today = new Date();
  const ninetyDaysOut = new Date();
  ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90);

  const upcoming = variants.filter(
    (v) =>
      v.streetDate && new Date(v.streetDate) >= today && new Date(v.streetDate) <= ninetyDaysOut,
  );
  const overdue = variants.filter((v) => v.streetDate && new Date(v.streetDate) < today);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Disc3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Upcoming Releases</CardTitle>
            <CardDescription>Pre-orders in the next 90 days</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : upcoming.length === 0 && overdue.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">No upcoming releases.</p>
        ) : (
          <div className="space-y-3">
            {overdue.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-destructive mb-1">
                  Overdue ({overdue.length})
                </h3>
                <PreorderList
                  variants={overdue}
                  onRelease={handleRelease}
                  isPending={releaseMutation.isPending}
                />
              </div>
            )}
            {upcoming.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground mb-1">
                  Upcoming ({upcoming.length})
                </h3>
                <PreorderList
                  variants={upcoming}
                  onRelease={handleRelease}
                  isPending={releaseMutation.isPending}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PreorderList({
  variants,
  onRelease,
  isPending,
}: {
  variants: PreorderVariant[];
  onRelease: (id: string) => void;
  isPending: boolean;
}) {
  return (
    <div className="space-y-1">
      {variants.map((v) => (
        <div key={v.id} className="flex items-center justify-between text-sm">
          <div className="min-w-0 flex-1">
            {v.bandcampUrl ? (
              <a
                href={v.bandcampUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium truncate block hover:underline"
              >
                {v.productTitle}
              </a>
            ) : (
              <span className="font-medium truncate block">{v.productTitle}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {[v.sku, formatFormatName(v.formatName), formatShortDate(v.streetDate)]
                .filter(Boolean)
                .join(" · ")}{" "}
              &middot;{" "}
              {formatPendingDemand({
                localOrderCount: v.pendingOrderCount,
                localUnitCount: v.pendingUnits,
                liveOrderCount: v.liveBandcampOrderCount ?? 0,
                liveUnitCount: v.liveBandcampUnitCount ?? 0,
                liveOrderNumbers: v.liveBandcampOrderNumbers ?? [],
              })}{" "}
              &middot; {v.availableStock} avail
              {v.isShortRisk && <span className="text-destructive ml-1">SHORT</span>}
            </span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onRelease(v.id)} disabled={isPending}>
            <Rocket className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function formatPendingDemand({
  localOrderCount,
  localUnitCount,
  liveOrderCount,
  liveUnitCount,
  liveOrderNumbers,
}: {
  localOrderCount: number;
  localUnitCount: number;
  liveOrderCount: number;
  liveUnitCount: number;
  liveOrderNumbers?: string[];
}) {
  const orderCount = liveOrderCount || localOrderCount;
  const unitCount = liveOrderCount ? liveUnitCount : localUnitCount;
  const source = liveOrderCount ? "live BC" : "synced";
  const orderLabel = orderCount === 1 ? "order" : "orders";
  const unitLabel = unitCount === 1 ? "unit" : "units";
  const orderNumbers = liveOrderNumbers ?? [];
  const sample = orderNumbers.slice(0, 3).join(", ");
  const more = orderNumbers.length > 3 ? `, +${orderNumbers.length - 3} more` : "";
  const numbers = sample ? ` (${sample}${more})` : "";
  return `${orderCount} pending ${orderLabel} / ${unitCount} ${unitLabel} ${source}${numbers}`;
}
