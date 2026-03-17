"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback } from "react";
import { getHealthData, triggerSensorCheck } from "@/actions/admin-settings";
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
    </div>
  );
}
