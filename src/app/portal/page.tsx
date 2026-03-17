"use client";

import { CheckCircle, Circle, Loader2, Minus, Plus } from "lucide-react";
import { getPortalDashboard } from "@/actions/portal-dashboard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function PortalHomePage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["portal", "dashboard"],
    queryFn: () => getPortalDashboard(),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading dashboard...
      </div>
    );
  }

  const completedSteps = data.onboardingSteps.filter((s) => s.completed).length;
  const totalSteps = data.onboardingSteps.length;
  const allComplete = completedSteps === totalSteps;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {data.orgName}</h1>
        <p className="text-muted-foreground mt-1">Your warehouse dashboard</p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total SKUs" value={data.stats.totalSkus} />
        <StatCard label="Available Units" value={data.stats.totalAvailable} />
        <StatCard label="Pending Inbound" value={data.stats.pendingInbound} />
        <StatCard label="Open Support" value={data.stats.openSupport} />
      </div>

      {/* Onboarding checklist (Rule #56) */}
      {!allComplete && (
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
            <CardDescription>
              {completedSteps} of {totalSteps} steps complete
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.onboardingSteps.map((step) => (
                <div key={step.key} className="flex items-start gap-3">
                  {step.completed ? (
                    <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
                  ) : (
                    <Circle className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                  )}
                  <div>
                    <p
                      className={`text-sm ${step.completed ? "text-muted-foreground line-through" : "font-medium"}`}
                    >
                      {step.label}
                    </p>
                    {!step.completed && (
                      <p className="text-xs text-muted-foreground mt-0.5">{step.guidance}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sync health */}
      {data.connections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Store Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.connections.map((conn) => (
                <div key={conn.id} className="flex items-center justify-between text-sm">
                  <span className="capitalize">
                    {conn.platform} — {conn.store_url}
                  </span>
                  <Badge variant={conn.connection_status === "active" ? "default" : "destructive"}>
                    {conn.connection_status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentActivity.length === 0 ? (
            <p className="text-muted-foreground text-sm">No recent activity.</p>
          ) : (
            <div className="space-y-2">
              {data.recentActivity.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    {a.delta > 0 ? (
                      <Plus className="h-3 w-3 text-green-600" />
                    ) : (
                      <Minus className="h-3 w-3 text-red-600" />
                    )}
                    <span className="font-mono text-xs">{a.sku}</span>
                    <span className="text-muted-foreground">{a.source}</span>
                    <span className="font-mono">{a.delta > 0 ? `+${a.delta}` : a.delta}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}
