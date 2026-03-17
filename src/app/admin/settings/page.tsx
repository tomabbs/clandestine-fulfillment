"use client";

import { Loader2 } from "lucide-react";
import { getGeneralSettings } from "@/actions/admin-settings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function GeneralSettingsPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["admin", "settings", "general"],
    queryFn: () => getGeneralSettings(),
    tier: CACHE_TIERS.STABLE,
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">General Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{data.workspace?.name ?? "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Slug</span>
            <span className="font-mono text-xs">{data.workspace?.slug ?? "—"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Organizations</span>
            <span className="font-semibold">{data.orgCount}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Products</span>
            <span className="font-semibold">{data.productCount}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active Billing Rules</CardTitle>
        </CardHeader>
        <CardContent>
          {data.billingRules.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active billing rules.</p>
          ) : (
            <div className="space-y-1">
              {data.billingRules.map((r) => (
                <div key={r.rule_name} className="flex justify-between text-sm">
                  <span>
                    {r.rule_name} <span className="text-muted-foreground">({r.rule_type})</span>
                  </span>
                  <span className="font-mono">${r.amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
