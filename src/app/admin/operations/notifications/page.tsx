"use client";

/**
 * Slice 4 — Notifications operations cockpit.
 *
 * Operator-facing surface for the post-Slice-1/2/3 notification pipeline.
 * Three lenses on a single page:
 *   1. Top rollup cards   — pending, stuck >1h, failed/bounced/complained
 *      24h, signature failures by platform 24h.
 *   2. Stuck pending      — table of notification_sends rows in `pending`
 *      for over an hour. Each row gets Retry + Cancel actions wired
 *      through applyOperatorNotificationAction (state machine + audit).
 *   3. Recent failures    — last 50 provider_failed/bounced/complained
 *      with deep links to the public /track/[token] page so an operator
 *      can see exactly what the customer saw.
 *   4. Signature failures — last 50 webhook_events with status =
 *      signature_failed/invalid (per-platform). Surfaces secret-rotation
 *      drift before the sensor's auto-escalation fires.
 *
 * Page intentionally lives at /admin/operations/notifications (a NEW
 * route segment) rather than under /admin/settings/* — settings is for
 * configuration; this is for active incident response.
 */

import { Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import {
  cancelStuckNotification,
  getNotificationOpsOverview,
  getRecentNotificationFailures,
  getRecentSignatureFailures,
  getStuckPendingNotifications,
  retryStuckNotification,
  type RecentFailureRow,
  type SignatureFailureRow,
  type StuckPendingRow,
  triggerNotificationFailureSensor,
} from "@/actions/notification-operations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "soon";
  const h = Math.floor(ms / (60 * 60 * 1000));
  const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (h >= 24) return `${Math.floor(h / 24)}d ago`;
  if (h >= 1) return `${h}h ${m}m ago`;
  return `${m}m ago`;
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "delivered" || status === "sent") return "default";
  if (status === "pending" || status === "delivery_delayed" || status === "shadow")
    return "secondary";
  if (status === "cancelled" || status === "skipped" || status === "suppressed") return "outline";
  return "destructive";
}

export default function NotificationOperationsPage() {
  const overview = useAppQuery({
    queryKey: ["admin", "ops", "notifications", "overview"],
    queryFn: () => getNotificationOpsOverview(),
    tier: CACHE_TIERS.REALTIME,
  });

  const stuck = useAppQuery({
    queryKey: ["admin", "ops", "notifications", "stuck"],
    queryFn: () => getStuckPendingNotifications(50),
    tier: CACHE_TIERS.REALTIME,
  });

  const failures = useAppQuery({
    queryKey: ["admin", "ops", "notifications", "failures"],
    queryFn: () => getRecentNotificationFailures(50),
    tier: CACHE_TIERS.REALTIME,
  });

  const sigFailures = useAppQuery({
    queryKey: ["admin", "ops", "notifications", "signature-failures"],
    queryFn: () => getRecentSignatureFailures(50),
    tier: CACHE_TIERS.REALTIME,
  });

  const refetchAll = useCallback(() => {
    overview.refetch();
    stuck.refetch();
    failures.refetch();
    sigFailures.refetch();
  }, [overview, stuck, failures, sigFailures]);

  const sensorMut = useAppMutation({
    mutationFn: () => triggerNotificationFailureSensor(),
    onSuccess: () => setTimeout(refetchAll, 5000),
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Notifications operations</h1>
          <p className="text-sm text-muted-foreground">
            Live incident-response surface for the customer-facing tracking-email pipeline. Stuck
            sends, provider failures, and webhook signature health.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => sensorMut.mutate()}
            disabled={sensorMut.isPending}
          >
            {sensorMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Run sensor now
          </Button>
        </div>
      </div>

      {/* Rollup cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <RollupCard
          title="Pending"
          value={overview.data?.pendingTotal ?? 0}
          tone={
            (overview.data?.stuckPending1h ?? 0) > 0 ? "warning" : "neutral"
          }
          subline={
            (overview.data?.stuckPending1h ?? 0) > 0
              ? `${overview.data?.stuckPending1h} stuck >1h`
              : "all under 1h"
          }
        />
        <RollupCard
          title="Failed (24h)"
          value={overview.data?.failedLast24h ?? 0}
          tone={(overview.data?.failedLast24h ?? 0) > 0 ? "danger" : "neutral"}
          subline="provider_failed + failed"
        />
        <RollupCard
          title="Bounced (24h)"
          value={overview.data?.bouncedLast24h ?? 0}
          tone={(overview.data?.bouncedLast24h ?? 0) > 0 ? "warning" : "neutral"}
          subline={`${overview.data?.complainedLast24h ?? 0} complained`}
        />
        <RollupCard
          title="Sig failures (24h)"
          value={overview.data?.signatureFailures24h ?? 0}
          tone={(overview.data?.signatureFailures24h ?? 0) > 0 ? "danger" : "neutral"}
          subline={
            Object.keys(overview.data?.signatureFailuresByPlatform ?? {}).length > 0
              ? Object.entries(overview.data?.signatureFailuresByPlatform ?? {})
                  .map(([k, v]) => `${k}:${v}`)
                  .join(" · ")
              : "no platforms affected"
          }
        />
      </div>

      {/* Stuck pending table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Stuck pending (&gt;1h)</CardTitle>
        </CardHeader>
        <CardContent>
          {stuck.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (stuck.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No stuck sends — pipeline is healthy.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3">Trigger</th>
                    <th className="py-2 pr-3">Recipient</th>
                    <th className="py-2 pr-3">Tracking</th>
                    <th className="py-2 pr-3">Pending for</th>
                    <th className="py-2 pr-3">Attempts</th>
                    <th className="py-2 pr-3">Last error</th>
                    <th className="py-2 pr-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(stuck.data ?? []).map((row) => (
                    <StuckPendingTableRow key={row.id} row={row} onResolved={refetchAll} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent failures */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent failures (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          {failures.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (failures.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No failed/bounced/complained sends in the last 24h.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Trigger</th>
                    <th className="py-2 pr-3">Recipient</th>
                    <th className="py-2 pr-3">Error</th>
                    <th className="py-2 pr-3 text-right">Customer view</th>
                  </tr>
                </thead>
                <tbody>
                  {(failures.data ?? []).map((row) => (
                    <FailureTableRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook signature failures */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Webhook signature failures (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          {sigFailures.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (sigFailures.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No signature failures — secrets are aligned across providers.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Platform</th>
                    <th className="py-2 pr-3">Reason</th>
                    <th className="py-2 pr-3">Dedup id</th>
                  </tr>
                </thead>
                <tbody>
                  {(sigFailures.data ?? []).map((row) => (
                    <SignatureFailureTableRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RollupCard({
  title,
  value,
  tone,
  subline,
}: {
  title: string;
  value: number;
  tone: "neutral" | "warning" | "danger";
  subline: string;
}) {
  const valueClass =
    tone === "danger"
      ? "text-red-600"
      : tone === "warning"
        ? "text-amber-600"
        : "text-foreground";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-3xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{subline}</p>
      </CardContent>
    </Card>
  );
}

function StuckPendingTableRow({
  row,
  onResolved,
}: {
  row: StuckPendingRow;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await retryStuckNotification(row.id);
      onResolved();
    } finally {
      setBusy(false);
    }
  };
  const handleCancel = async () => {
    if (busy) return;
    const reason = window.prompt("Cancellation reason (audit log):");
    if (!reason) return;
    setBusy(true);
    try {
      await cancelStuckNotification(row.id, reason);
      onResolved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-3">
        <Badge variant="secondary">{row.trigger_status}</Badge>
      </td>
      <td className="py-2 pr-3 font-mono text-xs">{row.recipient}</td>
      <td className="py-2 pr-3 font-mono text-xs">
        {row.shipment_tracking_number ? (
          <>
            {row.shipment_carrier?.toUpperCase() ?? ""} {row.shipment_tracking_number}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2 pr-3">{formatRelative(row.pending_at)}</td>
      <td className="py-2 pr-3 tabular-nums">{row.attempt_count}</td>
      <td className="py-2 pr-3 max-w-xs truncate text-xs text-muted-foreground" title={row.error ?? ""}>
        {row.error ?? "—"}
      </td>
      <td className="py-2 pr-3 text-right space-x-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={handleRetry}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Retry"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={handleCancel}>
          Cancel
        </Button>
      </td>
    </tr>
  );
}

function FailureTableRow({ row }: { row: RecentFailureRow }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-3">{formatRelative(row.created_at)}</td>
      <td className="py-2 pr-3">
        <Badge variant={statusBadgeVariant(row.status)}>{row.status}</Badge>
      </td>
      <td className="py-2 pr-3">
        <Badge variant="secondary">{row.trigger_status}</Badge>
      </td>
      <td className="py-2 pr-3 font-mono text-xs">{row.recipient}</td>
      <td className="py-2 pr-3 max-w-xs truncate text-xs text-muted-foreground" title={row.error ?? ""}>
        {row.error ?? "—"}
      </td>
      <td className="py-2 pr-3 text-right">
        {row.shipment_public_track_token ? (
          <Link
            href={`/track/${row.shipment_public_track_token}`}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline text-xs"
          >
            View as customer
          </Link>
        ) : (
          <span className="text-muted-foreground text-xs">no token</span>
        )}
      </td>
    </tr>
  );
}

function SignatureFailureTableRow({ row }: { row: SignatureFailureRow }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-3">{formatRelative(row.created_at)}</td>
      <td className="py-2 pr-3">
        <Badge variant="destructive">{row.platform}</Badge>
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">{row.reason ?? "—"}</td>
      <td className="py-2 pr-3 font-mono text-xs">{row.external_webhook_id ?? "—"}</td>
    </tr>
  );
}
