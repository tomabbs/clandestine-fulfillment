"use client";

import { CheckCircle, Circle, Loader2 } from "lucide-react";
import { getPortalDashboard } from "@/actions/portal-dashboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function PortalHomePage() {
  const { data, isLoading, error } = useAppQuery({
    queryKey: ["portal", "dashboard"],
    queryFn: () => getPortalDashboard(),
    tier: CACHE_TIERS.SESSION,
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

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

      {/*
        Phase 0.8 — Store Connections / Connected Stores cards removed from
        the client home. Inventory now flows through ShipStation Inventory
        Sync, configured by Clandestine staff. Operators reactivate dormant
        connectors per-row at /admin/settings/client-store-reconnect when
        ShipStation is insufficient for an edge case.
      */}
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
