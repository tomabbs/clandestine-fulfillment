"use client";

import { Loader2 } from "lucide-react";
import { getSalesData } from "@/actions/portal-sales";
import { BlockList } from "@/components/shared/block-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function SalesPage() {
  const { data, isLoading, error } = useAppQuery({
    queryKey: ["portal", "sales"],
    queryFn: () => getSalesData(),
    tier: CACHE_TIERS.SESSION,
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load sales data."}
        </p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sales...
        </div>
      </div>
    );
  }

  const maxCount = Math.max(...data.chartData.map((d) => d.count), 1);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Orders This Month</p>
            <p className="text-2xl font-semibold tabular-nums">{data.totalOrders}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Units Sold</p>
            <p className="text-2xl font-semibold tabular-nums">{data.totalUnits}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Top SKU</p>
            <p className="text-lg font-mono font-semibold">{data.topSkus[0]?.sku ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Simple bar chart */}
      <Card>
        <CardHeader>
          <CardTitle>Orders — Last 30 Days</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-0.5 h-32">
            {data.chartData.map((d) => (
              <div
                key={d.date}
                className="flex-1 flex flex-col justify-end"
                title={`${d.date}: ${d.count}`}
              >
                <div
                  className="bg-primary rounded-t-sm min-h-[2px]"
                  style={{ height: `${(d.count / maxCount) * 100}%` }}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Top SKUs */}
      {data.topSkus.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top Selling SKUs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.topSkus.map((s) => (
                <div key={s.sku} className="flex justify-between text-sm">
                  <span className="font-mono">{s.sku}</span>
                  <span className="font-semibold tabular-nums">{s.quantity} units</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent orders */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Orders</CardTitle>
        </CardHeader>
        <CardContent>
          <BlockList
            className="mt-2"
            items={data.orders}
            itemKey={(o) => o.id}
            density="ops"
            ariaLabel="Recent orders"
            renderHeader={({ row: o }) => (
              <div>
                <p className="font-mono text-xs">{o.order_number ?? "—"}</p>
                <p className="text-xs text-muted-foreground capitalize">{o.source}</p>
              </div>
            )}
            renderBody={({ row: o }) => (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-md border bg-background/60 p-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Date</p>
                  <p>{new Date(o.created_at).toISOString().slice(0, 10)}</p>
                </div>
                <div className="rounded-md border bg-background/60 p-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</p>
                  <p className="font-mono">
                    {o.total_price != null ? `$${Number(o.total_price).toFixed(2)}` : "—"}
                  </p>
                </div>
              </div>
            )}
          />
        </CardContent>
      </Card>
    </div>
  );
}
