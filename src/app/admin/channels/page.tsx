"use client";

import { formatDistanceToNow } from "date-fns";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback } from "react";
import { triggerTagCleanup } from "@/actions/admin-settings";
import { getBandcampSyncStatus, triggerBandcampSync } from "@/actions/bandcamp";
import { getShopifySyncStatus, triggerFullBackfill, triggerShopifySync } from "@/actions/shopify";
import { BlockList } from "@/components/shared/block-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

interface SyncState {
  last_sync_cursor: string | null;
  last_sync_wall_clock: string | null;
  last_full_sync_at: string | null;
}

interface SyncLog {
  id: string;
  sync_type: string | null;
  status: string;
  items_processed: number;
  items_failed: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

function statusBadgeVariant(status: string) {
  switch (status) {
    case "completed":
      return "default" as const;
    case "started":
      return "secondary" as const;
    case "failed":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function syncTypeLabel(syncType: string | null): string {
  switch (syncType) {
    case "merch_sync":
      return "Merch Sync";
    case "sale_poll":
      return "Sale Poll";
    case "inventory_push":
      return "Inventory Push";
    default:
      return syncType ?? "unknown";
  }
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return `${Math.round(ms / 1000)}s`;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
}

// === Sync History Table (reused for both channels) ===

function SyncHistoryTable({
  logs,
  showSyncType = false,
}: {
  logs: SyncLog[];
  showSyncType?: boolean;
}) {
  if (logs.length === 0) {
    return <p className="text-muted-foreground text-sm">No sync history yet.</p>;
  }

  return (
    <BlockList
      className="mt-2"
      items={logs}
      itemKey={(log) => log.id}
      density="ops"
      virtualizeThreshold={200}
      ariaLabel="Channel sync history"
      renderHeader={({ row }) => (
        <div className="min-w-0">
          <p className="font-mono text-xs">
            {showSyncType ? syncTypeLabel(row.sync_type) : (row.sync_type ?? "unknown")}
          </p>
          <p className="text-xs text-muted-foreground">{formatRelativeTime(row.started_at)}</p>
        </div>
      )}
      renderExceptionZone={({ row }) => (
        <div className="flex items-center gap-2">
          <Badge variant={statusBadgeVariant(row.status)}>{row.status}</Badge>
          {row.items_failed > 0 && (
            <span className="text-destructive text-xs">{row.items_failed} failed</span>
          )}
        </div>
      )}
      renderBody={({ row }) => (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <SyncMetric label="Items" value={String(row.items_processed)} />
          <SyncMetric label="Duration" value={formatDuration(row.started_at, row.completed_at)} />
          <SyncMetric label="Started" value={formatRelativeTime(row.started_at)} />
          <SyncMetric label="Error" value={row.error_message ?? "—"} error={!!row.error_message} />
        </div>
      )}
    />
  );
}

// === Main Page ===

export default function ChannelsPage() {
  // --- Shopify ---
  const {
    data: shopifyData,
    isLoading: shopifyLoading,
    refetch: refetchShopify,
  } = useAppQuery<{
    syncState: SyncState | null;
    recentLogs: SyncLog[];
  }>({
    queryKey: queryKeys.channels.syncStatus("shopify"),
    queryFn: () => getShopifySyncStatus(),
    tier: CACHE_TIERS.REALTIME,
  });

  const shopifySyncMutation = useAppMutation({
    mutationFn: triggerShopifySync,
    invalidateKeys: [queryKeys.channels.all],
  });

  const shopifyBackfillMutation = useAppMutation({
    mutationFn: triggerFullBackfill,
    invalidateKeys: [queryKeys.channels.all],
  });

  // --- Bandcamp ---
  const {
    data: bandcampData,
    isLoading: bandcampLoading,
    refetch: refetchBandcamp,
  } = useAppQuery<{
    lastMerchSync: string | null;
    lastSalePoll: string | null;
    lastInventoryPush: string | null;
    recentLogs: SyncLog[];
  }>({
    queryKey: queryKeys.channels.syncStatus("bandcamp"),
    queryFn: () => getBandcampSyncStatus(),
    tier: CACHE_TIERS.REALTIME,
  });

  const bandcampSyncMutation = useAppMutation({
    mutationFn: () => triggerBandcampSync(),
    invalidateKeys: [queryKeys.channels.all],
  });

  // --- Handlers ---
  const handleShopifySync = useCallback(
    () => shopifySyncMutation.mutate(undefined),
    [shopifySyncMutation],
  );
  const handleShopifyBackfill = useCallback(
    () => shopifyBackfillMutation.mutate(undefined),
    [shopifyBackfillMutation],
  );
  const handleBandcampSync = useCallback(
    () => bandcampSyncMutation.mutate(undefined),
    [bandcampSyncMutation],
  );
  const handleRefreshAll = useCallback(() => {
    refetchShopify();
    refetchBandcamp();
  }, [refetchShopify, refetchBandcamp]);

  const shopifySyncState = shopifyData?.syncState;
  const shopifyLogs = shopifyData?.recentLogs ?? [];
  const bandcampLogs = bandcampData?.recentLogs ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
          <p className="text-muted-foreground mt-1">Manage integrations and sync status.</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefreshAll}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* ── Shopify ────────────────────────────────────────────────────────── */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Shopify</CardTitle>
              <CardDescription>Product catalog and inventory sync</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleShopifySync}
                disabled={shopifySyncMutation.isPending}
              >
                {shopifySyncMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Force Sync
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleShopifyBackfill}
                disabled={shopifyBackfillMutation.isPending}
              >
                {shopifyBackfillMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-2 h-4 w-4" />
                )}
                Full Backfill
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {shopifyLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sync status...
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Last Sync</p>
                <p className="font-medium">
                  {formatRelativeTime(shopifySyncState?.last_sync_wall_clock ?? null)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Full Backfill</p>
                <p className="font-medium">
                  {formatRelativeTime(shopifySyncState?.last_full_sync_at ?? null)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Sync Cursor</p>
                <p className="font-medium font-mono text-xs">
                  {shopifySyncState?.last_sync_cursor
                    ? new Date(shopifySyncState.last_sync_cursor).toLocaleString()
                    : "—"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shopify Sync History</CardTitle>
          <CardDescription>Recent sync runs</CardDescription>
        </CardHeader>
        <CardContent>
          <SyncHistoryTable logs={shopifyLogs} />
        </CardContent>
      </Card>

      {/* ── Bandcamp ───────────────────────────────────────────────────────── */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Bandcamp</CardTitle>
              <CardDescription>
                Merch catalog sync, sale polling, and inventory push
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleBandcampSync}
                disabled={bandcampSyncMutation.isPending}
              >
                {bandcampSyncMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Force Sync
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {bandcampLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sync status...
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Last Merch Sync</p>
                <p className="font-medium">
                  {formatRelativeTime(bandcampData?.lastMerchSync ?? null)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Sale Poll</p>
                <p className="font-medium">
                  {formatRelativeTime(bandcampData?.lastSalePoll ?? null)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Inventory Push</p>
                <p className="font-medium">
                  {formatRelativeTime(bandcampData?.lastInventoryPush ?? null)}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bandcamp Sync History</CardTitle>
          <CardDescription>
            Recent runs across merch sync, sale poll, and inventory push
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SyncHistoryTable logs={bandcampLogs} showSyncType />
        </CardContent>
      </Card>

      {/* Admin Tools */}
      <Card>
        <CardHeader>
          <CardTitle>Admin Tools</CardTitle>
          <CardDescription>One-time operations and maintenance tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <TagCleanupButton />
        </CardContent>
      </Card>
    </div>
  );
}

function SyncMetric({
  label,
  value,
  error = false,
}: {
  label: string;
  value: string;
  error?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={error ? "text-sm text-destructive truncate" : "text-sm truncate"}>{value}</p>
    </div>
  );
}

function TagCleanupButton() {
  const tagMut = useAppMutation({
    mutationFn: () => triggerTagCleanup(),
    invalidateKeys: [],
  });

  return (
    <div className="flex items-center gap-4">
      <Button variant="outline" disabled={tagMut.isPending} onClick={() => tagMut.mutate()}>
        {tagMut.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        Sync All Tags
      </Button>
      <p className="text-sm text-muted-foreground">
        Scans all products and fixes Pre-Order / New Releases tags based on street dates
      </p>
      {tagMut.isSuccess && <span className="text-sm text-green-600">Triggered successfully</span>}
    </div>
  );
}
