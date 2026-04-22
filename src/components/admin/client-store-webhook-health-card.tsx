"use client";

/**
 * B-3 / HRD-14 — Client Store Webhook Health Card
 *
 * Renders on `/admin/channels` and surfaces, per Shopify client store
 * connection:
 *   - State badge (healthy / delayed / stale / unknown) driven by
 *     `last_webhook_at` (1h / 6h thresholds — see `getChannelWebhookHealth`).
 *   - Per-required-topic counters from `webhook_topic_health` JSONB.
 *   - Last error and timestamp from `last_error` / `last_error_at`.
 *   - The idempotent diff between Shopify's current subscriptions and the
 *     canonical (4 topics × 1 callback URL) target — surfaces what would
 *     change BEFORE the operator clicks "Re-register webhooks".
 *
 * Operator interactions:
 *   - "Re-register webhooks" button calls `registerShopifyWebhookSubscriptions`,
 *     which is itself idempotent (re-uses subscriptions whose (topic,
 *     callbackUrl) tuple already matches; creates only what's missing).
 *
 * Loading and error states are rendered inline — this card never gates the
 * rest of the Channels page from rendering.
 */

import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw } from "lucide-react";
import { useCallback } from "react";
import {
  type ChannelWebhookHealthReport,
  getChannelWebhookHealth,
  getStoreConnections,
  registerShopifyWebhookSubscriptions,
  SHOPIFY_REQUIRED_WEBHOOK_TOPICS_REST,
  type WebhookHealthState,
} from "@/actions/store-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function badgeVariant(state: WebhookHealthState) {
  switch (state) {
    case "healthy":
      return "default" as const;
    case "delayed":
      return "secondary" as const;
    case "stale":
      return "destructive" as const;
    case "unknown":
      return "outline" as const;
  }
}

function StateBadge({ state }: { state: WebhookHealthState }) {
  const Icon = state === "healthy" ? CheckCircle2 : state === "stale" ? AlertTriangle : Clock;
  return (
    <Badge variant={badgeVariant(state)} className="gap-1">
      <Icon className="h-3 w-3" />
      {state}
    </Badge>
  );
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "Never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function ConnectionHealthRow({ connectionId }: { connectionId: string }) {
  const { data, isLoading, refetch } = useAppQuery<ChannelWebhookHealthReport>({
    queryKey: ["webhook-health", connectionId],
    queryFn: () => getChannelWebhookHealth({ connectionId }),
    tier: CACHE_TIERS.REALTIME,
  });

  const reregister = useAppMutation({
    mutationFn: () => registerShopifyWebhookSubscriptions({ connectionId }),
    invalidateKeys: [["webhook-health", connectionId]],
  });

  const handleReregister = useCallback(() => reregister.mutate(undefined), [reregister]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading {connectionId.slice(0, 8)}…
      </div>
    );
  }

  return (
    <div className="space-y-3 border rounded-md p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium truncate">{data.storeUrl}</p>
          <p className="text-xs text-muted-foreground">
            {data.platform} · {connectionId.slice(0, 8)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StateBadge state={data.state} />
          <Button
            size="sm"
            variant="outline"
            onClick={handleReregister}
            disabled={reregister.isPending}
          >
            {reregister.isPending ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3 w-3" />
            )}
            Re-register
          </Button>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground text-xs">Last webhook</p>
          <p className="font-medium">
            {data.lastWebhookAt
              ? `${formatAge(data.ageSeconds)} (${formatDistanceToNow(new Date(data.lastWebhookAt), { addSuffix: true })})`
              : "Never"}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Last error</p>
          <p className="font-medium">
            {data.lastErrorAt
              ? formatDistanceToNow(new Date(data.lastErrorAt), { addSuffix: true })
              : "—"}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Diff</p>
          <p className="font-medium">
            {data.diff
              ? `${data.diff.toCreate.length}+ / ${data.diff.toRecreate.length}~ / ${data.diff.toDelete.length}-`
              : data.diffError
                ? "diff failed"
                : "—"}
          </p>
        </div>
      </div>

      {/* Per-topic counters (Shopify only — non-Shopify get "—") */}
      <div>
        <p className="text-muted-foreground text-xs mb-1">Per-topic counters</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {SHOPIFY_REQUIRED_WEBHOOK_TOPICS_REST.map((topic) => {
            const counter = data.topicCounters[topic];
            return (
              <div key={topic} className="border rounded px-2 py-1 text-xs">
                <p className="font-mono">{topic}</p>
                <p className="text-muted-foreground">
                  {counter
                    ? `${counter.count} · ${formatDistanceToNow(new Date(counter.last_at), { addSuffix: true })}`
                    : "no deliveries"}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {data.lastError && (
        <div className="text-xs text-destructive font-mono break-all">{data.lastError}</div>
      )}

      {data.diffError && (
        <div className="text-xs text-amber-600 font-mono break-all">
          Subscription diff fetch failed: {data.diffError}
        </div>
      )}
    </div>
  );
}

export function ClientStoreWebhookHealthCard() {
  const { data, isLoading } = useAppQuery<{
    connections: Array<{ id: string; platform: string; store_url: string }>;
  }>({
    queryKey: ["client-store-connections", "shopify"],
    queryFn: () => getStoreConnections({ platform: "shopify" }),
    tier: CACHE_TIERS.REALTIME,
  });

  const connections = data?.connections ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client Store Webhook Health</CardTitle>
        <CardDescription>
          Per-connection freshness (1h healthy · 6h delayed · &gt;6h stale) plus an idempotent diff
          against Shopify&apos;s subscription set. Re-register is safe: existing matching
          subscriptions are reused, only missing topics are created.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading connections…
          </div>
        ) : connections.length === 0 ? (
          <p className="text-muted-foreground text-sm">No Shopify client store connections.</p>
        ) : (
          <div className="space-y-3">
            {connections.map((c) => (
              <ConnectionHealthRow key={c.id} connectionId={c.id} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
