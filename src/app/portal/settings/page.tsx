"use client";

import { Loader2 } from "lucide-react";
import { getPortalSettings, updateNotificationPreferences } from "@/actions/portal-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function PortalSettingsPage() {
  const { data, isLoading, error } = useAppQuery({
    queryKey: ["portal", "settings"],
    queryFn: () => getPortalSettings(),
    tier: CACHE_TIERS.SESSION,
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Org profile */}
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="text-sm text-muted-foreground">Name</p>
            <p className="font-medium">{data.org?.name ?? "—"}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Billing Email</p>
            <p className="font-medium">{data.org?.billing_email ?? "—"}</p>
          </div>
        </CardContent>
      </Card>

      {/*
        Phase 0.8 — Store Connections card removed from client settings.
        Inventory now syncs to client storefronts via ShipStation Inventory
        Sync, configured by Clandestine staff. Per-row reactivation lives
        at /admin/settings/client-store-reconnect for staff use only.
      */}

      {/* Notification preferences */}
      <NotificationPreferences emailEnabled={data.notificationPreferences.email_enabled} />
    </div>
  );
}

function NotificationPreferences({ emailEnabled }: { emailEnabled: boolean }) {
  const toggleMut = useAppMutation({
    mutationFn: (enabled: boolean) => updateNotificationPreferences({ email_enabled: enabled }),
    invalidateKeys: [["portal", "settings"]],
  });

  const isEnabled = toggleMut.variables !== undefined ? toggleMut.variables : emailEnabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Manage your email notification preferences</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Email Notifications</p>
            <p className="text-sm text-muted-foreground">
              Receive email updates about shipments, billing, and inventory
            </p>
          </div>
          <button
            type="button"
            disabled={toggleMut.isPending}
            onClick={() => toggleMut.mutate(!isEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              isEnabled ? "bg-primary" : "bg-input"
            }`}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                isEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// Phase 0.8 — ConnectionCard removed. Per-connection credential submission
// from the client portal is no longer available; staff manage connections
// at /admin/settings/store-connections and reactivate dormant rows at
// /admin/settings/client-store-reconnect when ShipStation Inventory Sync
// is insufficient for an edge case.
