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
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useCallback } from "react";
import {
  auditShopifyPolicy,
  type GetConnectionPolicyHealthResult,
  getConnectionPolicyHealth,
} from "@/actions/shopify-policy";
import {
  type ChannelWebhookHealthReport,
  getChannelWebhookHealth,
  getStoreConnections,
  registerShopifyWebhookSubscriptions,
  type WebhookHealthState,
} from "@/actions/store-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { SHOPIFY_REQUIRED_WEBHOOK_TOPICS_REST } from "@/lib/shared/shopify-webhook-topics";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { IntegrationHealthState } from "@/lib/shared/types";

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

// ─── Phase 0 follow-up — policy_drift badge wiring ───────────────────────────
//
// `policy_drift` is the second per-connection health signal alongside webhook
// freshness. The two signals are independent: a connection can have fresh
// webhooks AND policy drift simultaneously (Shopify is delivering events
// promptly while CONTINUE-policy variants quietly oversell), or vice versa.
// Surfacing both as separate badges is the honest representation; collapsing
// to "worst wins" would hide the actionability split (re-register webhooks
// vs. fix drift are different operator workflows).
//
// Maps policy state -> badge variant. Unmapped IntegrationHealthState values
// (`partial`, `manual_review`) collapse to `outline`/`Clock` as a safe
// fallback — the policy loader only emits 4 of the 6 union values today
// (`healthy` / `delayed` / `policy_drift` / `disconnected`), so the fallback
// is a future-proof guard, not a current code path.
function policyBadgeVariant(state: IntegrationHealthState) {
  switch (state) {
    case "healthy":
      return "default" as const;
    case "policy_drift":
      return "destructive" as const;
    case "disconnected":
      return "destructive" as const;
    case "delayed":
    case "partial":
    case "manual_review":
      return "secondary" as const;
  }
}

function policyBadgeIcon(state: IntegrationHealthState) {
  switch (state) {
    case "healthy":
      return ShieldCheck;
    case "policy_drift":
    case "disconnected":
      return ShieldAlert;
    case "delayed":
    case "partial":
    case "manual_review":
      return Clock;
  }
}

function policyBadgeLabel(state: IntegrationHealthState): string {
  // Operator-facing label: keep it short. `policy_drift` collapses to "drift"
  // and the count is rendered as an adjacent superscript so the badge stays
  // glanceable; full reason text lives in the row footer.
  switch (state) {
    case "healthy":
      return "policy ok";
    case "policy_drift":
      return "policy drift";
    case "delayed":
      return "policy stale";
    case "disconnected":
      return "disconnected";
    case "partial":
    case "manual_review":
      return state.replace("_", " ");
  }
}

function PolicyHealthBadge({ result }: { result: GetConnectionPolicyHealthResult }) {
  const Icon = policyBadgeIcon(result.state);
  // Title surfaces drift count + last audit + sample SKUs as the
  // approachable-once-you-care detail layer (no tooltip primitive available
  // in this card; native title is fine for a power-user surface).
  const titleLines: string[] = [result.reason];
  if (result.lastAuditAt) {
    titleLines.push(
      `Last audit: ${formatDistanceToNow(new Date(result.lastAuditAt), { addSuffix: true })}`,
    );
  }
  if (result.driftSkusSampled.length > 0) {
    titleLines.push(`Sample SKUs: ${result.driftSkusSampled.join(", ")}`);
  }
  return (
    <Badge
      variant={policyBadgeVariant(result.state)}
      className="gap-1"
      title={titleLines.join("\n")}
    >
      <Icon className="h-3 w-3" />
      {policyBadgeLabel(result.state)}
      {result.state === "policy_drift" && result.driftCount > 0 && (
        <span className="font-mono text-[10px] ml-0.5">·{result.driftCount}</span>
      )}
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

  // Phase 0 follow-up — second independent query for policy health. Kept
  // separate (not joined into getChannelWebhookHealth) because the two
  // signals come from different cron tasks with different cadences:
  //   - webhook health: delivery freshness, every-10-min sensor
  //   - policy health: 24h audit cron, persists per-mapping snapshots
  // Joining them would force one cache invalidation policy on both;
  // separate queries let each invalidate on its own write.
  const policy = useAppQuery<GetConnectionPolicyHealthResult>({
    queryKey: ["policy-health", connectionId],
    queryFn: () => getConnectionPolicyHealth({ connectionId }),
    tier: CACHE_TIERS.REALTIME,
  });

  const reregister = useAppMutation({
    mutationFn: () => registerShopifyWebhookSubscriptions({ connectionId }),
    invalidateKeys: [["webhook-health", connectionId]],
  });

  // Fix-drift mutation enqueues a Trigger.dev task (Rule #48 — never call
  // Shopify mutations from a Server Action). After enqueue we invalidate
  // the policy-health query so the next refetch reflects the fix once the
  // task lands. The task itself re-runs the audit before fixing, so the
  // operator can re-click "Fix drift" safely if the first attempt 404s.
  const fixDrift = useAppMutation({
    mutationFn: () => auditShopifyPolicy({ connectionId, fixMode: "fix_drift" }),
    invalidateKeys: [["policy-health", connectionId]],
  });

  const handleReregister = useCallback(() => reregister.mutate(undefined), [reregister]);
  const handleFixDrift = useCallback(() => fixDrift.mutate(undefined), [fixDrift]);

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
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <StateBadge state={data.state} />
          {policy.data && <PolicyHealthBadge result={policy.data} />}
          {policy.data?.state === "policy_drift" && policy.data.driftCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleFixDrift}
              disabled={fixDrift.isPending}
              title={`Flip ${policy.data.driftCount} CONTINUE variant(s) back to DENY via productVariantsBulkUpdate.`}
            >
              {fixDrift.isPending ? (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              ) : (
                <Wrench className="mr-2 h-3 w-3" />
              )}
              Fix drift
            </Button>
          )}
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

      {/* Policy reason — surfaced in the row body for non-healthy states so
          the "why" doesn't hide inside a hover tooltip. Includes the audit
          freshness so an operator can tell drift-now from drift-from-yesterday. */}
      {policy.data && policy.data.state !== "healthy" && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Policy:</span> {policy.data.reason}
          {policy.data.lastAuditAt && (
            <>
              {" · audit "}
              {formatDistanceToNow(new Date(policy.data.lastAuditAt), { addSuffix: true })}
            </>
          )}
          {fixDrift.data?.mode === "fix_drift" && fixDrift.data.enqueuedRunId && (
            <>
              {" · fix enqueued: "}
              <span className="font-mono">{fixDrift.data.enqueuedRunId.slice(0, 12)}</span>
            </>
          )}
          {fixDrift.error && (
            <span className="text-destructive"> · fix failed: {String(fixDrift.error)}</span>
          )}
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
        <CardTitle>Client Store Connection Health</CardTitle>
        <CardDescription>
          Two independent per-connection signals — webhook freshness (1h healthy · 6h delayed ·
          &gt;6h stale) and Shopify variant policy drift (CONTINUE outside the preorder whitelist).
          Re-register is safe: existing matching subscriptions are reused. Fix drift enqueues a
          Trigger task that flips drifted variants back to DENY via productVariantsBulkUpdate.
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
