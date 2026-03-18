"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { submitClientStoreCredentials } from "@/actions/client-store-credentials";
import { getPortalSettings, updateNotificationPreferences } from "@/actions/portal-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type Connection = Awaited<ReturnType<typeof getPortalSettings>>["connections"][number];

export default function PortalSettingsPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["portal", "settings"],
    queryFn: () => getPortalSettings(),
    tier: CACHE_TIERS.SESSION,
  });

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

      {/* Store connections */}
      <Card>
        <CardHeader>
          <CardTitle>Store Connections</CardTitle>
          <CardDescription>Manage your connected stores</CardDescription>
        </CardHeader>
        <CardContent>
          {data.connections.length === 0 ? (
            <p className="text-muted-foreground text-sm">No store connections yet.</p>
          ) : (
            <div className="space-y-4">
              {data.connections.map((conn) => (
                <ConnectionCard key={conn.id} connection={conn} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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

function ConnectionCard({ connection }: { connection: Connection }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  const submitMut = useAppMutation({
    mutationFn: () =>
      submitClientStoreCredentials(connection.id, {
        apiKey,
        ...(apiSecret ? { apiSecret } : {}),
      }),
    invalidateKeys: [queryKeys.storeConnections.all],
    onSuccess: () => {
      setApiKey("");
      setApiSecret("");
    },
  });

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium capitalize">{connection.platform}</span>
          <span className="text-muted-foreground text-sm ml-2">{connection.store_url}</span>
        </div>
        <Badge variant={connection.connection_status === "active" ? "default" : "secondary"}>
          {connection.connection_status}
        </Badge>
      </div>

      {connection.connection_status === "pending" && (
        <div className="space-y-2">
          <Input placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <Input
            placeholder="API Secret (optional)"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!apiKey || submitMut.isPending}
            onClick={() => submitMut.mutate()}
          >
            {submitMut.isPending ? "Submitting..." : "Submit Credentials"}
          </Button>
        </div>
      )}
    </div>
  );
}
