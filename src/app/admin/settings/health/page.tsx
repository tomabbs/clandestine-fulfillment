"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback } from "react";
import { getHealthData, getShippingBillingHealth, triggerSensorCheck } from "@/actions/admin-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function statusBadgeVariant(status: string) {
  if (status === "healthy") return "default" as const;
  if (status === "warning") return "secondary" as const;
  return "destructive" as const;
}

export default function HealthPage() {
  const { data, isLoading, refetch } = useAppQuery({
    queryKey: ["admin", "settings", "health"],
    queryFn: () => getHealthData(),
    tier: CACHE_TIERS.REALTIME,
  });

  const runMut = useAppMutation({
    mutationFn: () => triggerSensorCheck(),
    onSuccess: () => setTimeout(() => refetch(), 5000),
  });

  const handleRun = useCallback(() => runMut.mutate(), [runMut]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">System Health</h1>
        <Button size="sm" variant="outline" onClick={handleRun} disabled={runMut.isPending}>
          {runMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1" />
          )}
          Run Check Now
        </Button>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading sensor data...</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(data?.latest ?? []).map((sensor) => (
            <Card key={sensor.name}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-mono">{sensor.name}</CardTitle>
                  <Badge variant={statusBadgeVariant(sensor.status)}>{sensor.status}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{sensor.message}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(sensor.timestamp).toLocaleString()}
                </p>
                {data?.history[sensor.name] && (
                  <div className="flex gap-0.5 mt-2">
                    {(data.history[sensor.name] as Array<{ status: string; timestamp: string }>)
                      .slice(-48)
                      .map((h) => (
                        <div
                          key={`${sensor.name}-${h.timestamp}`}
                          className={`w-1.5 h-3 rounded-sm ${
                            h.status === "healthy"
                              ? "bg-green-500"
                              : h.status === "warning"
                                ? "bg-yellow-500"
                                : "bg-red-500"
                          }`}
                        />
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          {(data?.latest ?? []).length === 0 && (
            <p className="text-muted-foreground text-sm col-span-2">
              No sensor data yet. Run a check to start monitoring.
            </p>
          )}
        </div>
      )}

      <PipelineHealth />
    </div>
  );
}

function PipelineHealth() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["admin", "settings", "pipeline-health"],
    queryFn: () => getShippingBillingHealth(),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading pipeline health...</p>;
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">Pipeline Health</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Shipping Ingest */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Shipping Ingest (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{data.totalShipments30d}</p>
            <div className="mt-2 space-y-1 text-sm">
              {Object.entries(data.shipmentsBySource).map(([src, count]) => (
                <div key={src} className="flex justify-between">
                  <span className="text-muted-foreground">{src}</span>
                  <span className="font-mono">{count as number}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Pirate Ship Imports */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Pirate Ship Imports</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {data.psImports.length === 0 ? (
                <p className="text-muted-foreground">No recent imports</p>
              ) : (
                data.psImports.slice(0, 5).map((imp) => (
                  <div key={imp.id} className="flex items-center justify-between">
                    <div>
                      <Badge variant={imp.status === "completed" ? "default" : "destructive"}>
                        {imp.status}
                      </Badge>
                      <span className="ml-2 text-muted-foreground text-xs">
                        {imp.processedCount ?? 0} processed
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(imp.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Data Integrity */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Data Integrity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Orphaned shipments</span>
                <span className={`font-mono ${data.orphanedShipmentCount > 0 ? "text-red-600 font-semibold" : ""}`}>
                  {data.orphanedShipmentCount}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Open review items</span>
                <span className={`font-mono ${data.reviewQueueTotal > 10 ? "text-yellow-600 font-semibold" : ""}`}>
                  {data.reviewQueueTotal}
                </span>
              </div>
              {Object.entries(data.reviewByCategory).map(([cat, count]) => (
                <div key={cat} className="flex justify-between pl-3">
                  <span className="text-muted-foreground text-xs">{cat}</span>
                  <span className="font-mono text-xs">{count as number}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Billing Pipeline */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Billing Pipeline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {data.snapshotWarnings.length > 0 ? (
                data.snapshotWarnings.map((sw) => (
                  <div key={sw.id} className="border-l-2 border-yellow-400 pl-2">
                    <p className="font-medium text-xs">{sw.billingPeriod}</p>
                    {sw.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-yellow-700">{w}</p>
                    ))}
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">No billing warnings</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Task Health */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Task Sensors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {Object.entries(data.taskHealth).length === 0 ? (
                <p className="text-muted-foreground">No task sensor data</p>
              ) : (
                Object.entries(data.taskHealth).map(([name, info]) => {
                  const t = info as { status: string; message: string | null; at: string };
                  return (
                    <div key={name} className="flex items-center justify-between">
                      <span className="font-mono text-xs">{name}</span>
                      <Badge variant={statusBadgeVariant(t.status)}>{t.status}</Badge>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
