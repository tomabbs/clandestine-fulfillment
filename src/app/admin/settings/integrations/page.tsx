"use client";

import { Loader2, Pause, Play, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getIntegrationStatus,
  getInventorySyncPauseStatus,
  type InventorySyncPauseStatus,
  resumeAndPushNow,
  setInventorySyncPaused,
} from "@/actions/admin-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const INTEGRATIONS = [
  { key: "shopify", name: "Shopify", desc: "Product catalog + inventory sync" },
  { key: "shipstation", name: "ShipStation", desc: "Shipment tracking" },
  { key: "bandcamp", name: "Bandcamp", desc: "Sales + inventory push" },
  { key: "aftership", name: "AfterShip", desc: "Tracking updates" },
  { key: "billing", name: "Stripe", desc: "Billing + invoicing" },
  { key: "resend", name: "Resend", desc: "Email + inbound support" },
];

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "unknown time";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function InventorySyncCard() {
  const [status, setStatus] = useState<InventorySyncPauseStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    getInventorySyncPauseStatus().then(setStatus).catch(console.error);
  }, []);

  function showToast(type: "success" | "error", message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 6000);
  }

  async function handlePause() {
    setLoading(true);
    try {
      await setInventorySyncPaused(true);
      // Optimistic update — re-fetch in background for full state
      setStatus({ paused: true, pausedAt: new Date().toISOString(), pausedByUserId: null });
      getInventorySyncPauseStatus()
        .then(setStatus)
        .catch(() => {
          /* keep optimistic state */
        });
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to pause sync");
    } finally {
      setLoading(false);
    }
  }

  async function handleResume() {
    setLoading(true);
    try {
      await setInventorySyncPaused(false);
      setStatus({ paused: false, pausedAt: null, pausedByUserId: null });
      getInventorySyncPauseStatus()
        .then(setStatus)
        .catch(() => {
          /* keep optimistic state */
        });
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to resume sync");
    } finally {
      setLoading(false);
    }
  }

  async function handleResumeAndPush() {
    setLoading(true);
    try {
      const result = await resumeAndPushNow();
      setStatus({ paused: false, pausedAt: null, pausedByUserId: null });
      getInventorySyncPauseStatus()
        .then(setStatus)
        .catch(() => {
          /* keep optimistic state */
        });
      if (result.partialFailure) {
        showToast("error", `Push partially failed: ${result.partialFailure}`);
      } else {
        const bcId = result.bandcampRunId?.slice(0, 8) ?? "—";
        const storeId = result.storeRunId?.slice(0, 8) ?? "—";
        showToast("success", `Push triggered — Bandcamp: ${bcId}, Stores: ${storeId}`);
      }
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Push failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="md:col-span-2">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base">Inventory Sync</CardTitle>
          {status === null ? (
            <Badge variant="outline">Loading…</Badge>
          ) : status.paused ? (
            <Badge variant="outline" className="border-amber-500 text-amber-600">
              Sync Paused
            </Badge>
          ) : (
            <Badge className="bg-green-600 text-white hover:bg-green-600">Sync Active</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Controls outbound quantity pushes to Shopify, Bandcamp, and client stores. Pausing halts
          automatic updates without affecting orders, scraping, or inbound check-ins.
        </p>

        {status?.paused && status.pausedAt && (
          <p className="text-xs text-amber-600">
            Paused {formatRelativeTime(status.pausedAt)} — inventory counts continue recording but
            are not pushed to storefronts until resumed.
          </p>
        )}

        {toast && (
          <p
            className={`text-xs rounded px-2 py-1 ${
              toast.type === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-green-50 text-green-700"
            }`}
          >
            {toast.message}
          </p>
        )}

        <div className="flex gap-2 flex-wrap">
          {status === null || !status.paused ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handlePause}
              disabled={loading || status === null}
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Pause className="h-3 w-3 mr-1" />
              )}
              Pause Sync
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleResume} disabled={loading}>
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                Resume
              </Button>
              <Button size="sm" onClick={handleResumeAndPush} disabled={loading}>
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Zap className="h-3 w-3 mr-1" />
                )}
                Resume + Push Now
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function IntegrationsPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["admin", "settings", "integrations"],
    queryFn: () => getIntegrationStatus(),
    tier: CACHE_TIERS.SESSION,
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
      <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InventorySyncCard />

        {INTEGRATIONS.map((integration) => {
          const activity = data.lastActivity[integration.key] as
            | { status: string; completed_at: string }
            | undefined;
          return (
            <Card key={integration.key}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{integration.name}</CardTitle>
                  <Badge
                    variant={
                      activity?.status === "completed"
                        ? "default"
                        : activity
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {activity?.status ?? "no data"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{integration.desc}</p>
                {activity?.completed_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last: {new Date(activity.completed_at).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
