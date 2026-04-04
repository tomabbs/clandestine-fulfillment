"use client";

import { Loader2 } from "lucide-react";
import { getSalesData } from "@/actions/portal-sales";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function SalesPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["portal", "sales"],
    queryFn: () => getSalesData(),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading sales...
      </div>
    );
  }

  const maxCount = Math.max(...data.chartData.map((d) => d.count), 1);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>

      <div className="grid grid-cols-3 gap-4">
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
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Date</th>
                  <th className="text-left p-2 font-medium">Source</th>
                  <th className="text-left p-2 font-medium">Order</th>
                  <th className="text-right p-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="p-2 text-muted-foreground">
                      {new Date(o.created_at).toISOString().slice(0, 10)}
                    </td>
                    <td className="p-2 capitalize">{o.source}</td>
                    <td className="p-2 font-mono text-xs">{o.order_number ?? "—"}</td>
                    <td className="p-2 text-right font-mono">
                      {o.total_price != null ? `$${Number(o.total_price).toFixed(2)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
