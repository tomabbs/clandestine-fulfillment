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
import { useCallback } from "react";
import { getDashboardStats } from "@/actions/admin-dashboard";
import { getPreorderProducts, manualRelease } from "@/actions/preorders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type PreorderVariant = Awaited<ReturnType<typeof getPreorderProducts>>["variants"][number];

export default function DashboardPage() {
  const { data: stats } = useAppQuery({
    queryKey: ["admin", "dashboard-stats"],
    queryFn: () => getDashboardStats(),
    tier: CACHE_TIERS.REALTIME,
  });

  const s = stats?.stats;

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
    queryKey: queryKeys.products.list({ preorders: true }),
    queryFn: () => getPreorderProducts({ pageSize: 30 }),
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
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const upcoming = variants.filter(
    (v) =>
      v.streetDate && new Date(v.streetDate) >= today && new Date(v.streetDate) <= thirtyDaysOut,
  );
  const overdue = variants.filter((v) => v.streetDate && new Date(v.streetDate) < today);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Disc3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Upcoming Releases</CardTitle>
            <CardDescription>Pre-orders in the next 30 days</CardDescription>
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
            <span className="font-medium truncate block">{v.productTitle}</span>
            <span className="text-xs text-muted-foreground">
              {v.streetDate ? new Date(v.streetDate).toLocaleDateString() : "—"} &middot;{" "}
              {v.orderCount} orders &middot; {v.availableStock} avail
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
