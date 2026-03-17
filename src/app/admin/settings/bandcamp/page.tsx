"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Music,
  RefreshCw,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { getBandcampAccounts, triggerBandcampSync } from "@/actions/bandcamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function HealthBadge({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  if (!lastSyncedAt) {
    return (
      <Badge variant="outline" className="gap-1">
        <XCircle className="h-3 w-3" /> Never synced
      </Badge>
    );
  }

  const age = Date.now() - new Date(lastSyncedAt).getTime();
  const hours = age / (1000 * 60 * 60);

  if (hours < 6) {
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Healthy
      </Badge>
    );
  }
  if (hours < 24) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Activity className="h-3 w-3" /> Delayed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
      <AlertTriangle className="h-3 w-3" /> Stale
    </Badge>
  );
}

export default function BandcampAccountsPage() {
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const { data: accounts, isLoading } = useAppQuery({
    queryKey: queryKeys.bandcamp.accounts(WORKSPACE_ID),
    queryFn: () => getBandcampAccounts(WORKSPACE_ID),
    tier: CACHE_TIERS.SESSION,
  });

  const syncMutation = useAppMutation({
    mutationFn: () => triggerBandcampSync(WORKSPACE_ID),
    invalidateKeys: [queryKeys.bandcamp.all],
    onSuccess: () => setSyncingId(null),
    onError: () => setSyncingId(null),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Bandcamp Accounts</h1>
        <Button
          variant="outline"
          disabled={syncMutation.isPending}
          onClick={() => {
            setSyncingId("global");
            syncMutation.mutate();
          }}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          Force Sync All
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (accounts ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Music className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No Bandcamp accounts connected.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Accounts
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{accounts?.length ?? 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Artists
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">
                  {accounts?.reduce((sum, a) => sum + a.memberArtistCount, 0) ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Merch Items
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">
                  {accounts?.reduce((sum, a) => sum + a.merchItemCount, 0) ?? 0}
                </p>
              </CardContent>
            </Card>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Band Name</TableHead>
                <TableHead>Band ID</TableHead>
                <TableHead className="text-right">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" /> Artists
                  </span>
                </TableHead>
                <TableHead className="text-right">Merch Items</TableHead>
                <TableHead>Last Synced</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(accounts ?? []).map((account) => (
                <TableRow key={account.id}>
                  <TableCell className="font-medium">
                    {account.band_name ?? "Unknown"}
                    {account.band_url && (
                      <a
                        href={account.band_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1 text-blue-600 text-xs hover:underline"
                      >
                        (link)
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {account.band_id}
                  </TableCell>
                  <TableCell className="text-right">{account.memberArtistCount}</TableCell>
                  <TableCell className="text-right">{account.merchItemCount}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {account.last_synced_at
                      ? new Date(account.last_synced_at).toLocaleString()
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    <HealthBadge lastSyncedAt={account.last_synced_at} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={syncMutation.isPending && syncingId === account.id}
                      onClick={() => {
                        setSyncingId(account.id);
                        syncMutation.mutate();
                      }}
                    >
                      <RefreshCw
                        className={`h-3 w-3 mr-1 ${syncMutation.isPending && syncingId === account.id ? "animate-spin" : ""}`}
                      />
                      Sync
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
