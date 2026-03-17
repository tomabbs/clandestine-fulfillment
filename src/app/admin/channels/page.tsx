"use client";

import { formatDistanceToNow } from "date-fns";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback } from "react";
import { getShopifySyncStatus, triggerFullBackfill, triggerShopifySync } from "@/actions/shopify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

export default function ChannelsPage() {
  const { data, isLoading, refetch } = useAppQuery<{
    syncState: SyncState | null;
    recentLogs: SyncLog[];
  }>({
    queryKey: queryKeys.channels.syncStatus(),
    queryFn: () => getShopifySyncStatus(),
    tier: CACHE_TIERS.REALTIME,
  });

  const syncMutation = useAppMutation({
    mutationFn: triggerShopifySync,
    invalidateKeys: [queryKeys.channels.all],
  });

  const backfillMutation = useAppMutation({
    mutationFn: triggerFullBackfill,
    invalidateKeys: [queryKeys.channels.all],
  });

  const handleSync = useCallback(() => syncMutation.mutate(undefined), [syncMutation]);
  const handleBackfill = useCallback(() => backfillMutation.mutate(undefined), [backfillMutation]);

  const syncState = data?.syncState;
  const recentLogs = data?.recentLogs ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
          <p className="text-muted-foreground mt-1">Manage integrations and sync status.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Shopify sync status card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Shopify</CardTitle>
              <CardDescription>Product catalog and inventory sync</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSync} disabled={syncMutation.isPending}>
                {syncMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Force Sync
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleBackfill}
                disabled={backfillMutation.isPending}
              >
                {backfillMutation.isPending ? (
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
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sync status...
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Last Sync</p>
                <p className="font-medium">
                  {syncState?.last_sync_wall_clock
                    ? formatDistanceToNow(new Date(syncState.last_sync_wall_clock), {
                        addSuffix: true,
                      })
                    : "Never"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Full Backfill</p>
                <p className="font-medium">
                  {syncState?.last_full_sync_at
                    ? formatDistanceToNow(new Date(syncState.last_full_sync_at), {
                        addSuffix: true,
                      })
                    : "Never"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Sync Cursor</p>
                <p className="font-medium font-mono text-xs">
                  {syncState?.last_sync_cursor
                    ? new Date(syncState.last_sync_cursor).toLocaleString()
                    : "—"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sync history */}
      <Card>
        <CardHeader>
          <CardTitle>Sync History</CardTitle>
          <CardDescription>Recent sync runs for Shopify</CardDescription>
        </CardHeader>
        <CardContent>
          {recentLogs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No sync history yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-mono text-xs">
                      {log.sync_type ?? "unknown"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(log.status)}>{log.status}</Badge>
                    </TableCell>
                    <TableCell>{log.items_processed}</TableCell>
                    <TableCell className="text-xs">
                      {log.started_at
                        ? formatDistanceToNow(new Date(log.started_at), { addSuffix: true })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {log.started_at && log.completed_at
                        ? `${Math.round((new Date(log.completed_at).getTime() - new Date(log.started_at).getTime()) / 1000)}s`
                        : "—"}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-destructive">
                      {log.error_message ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
