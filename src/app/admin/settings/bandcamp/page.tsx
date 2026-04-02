"use client";

import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Music,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { getUserContext } from "@/actions/auth";
import {
  createBandcampConnection,
  deleteBandcampConnection,
  getBandcampAccounts,
  getBandcampScraperHealth,
  getOrganizationsForWorkspace,
  triggerBandcampSync,
} from "@/actions/bandcamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function SensorBadge({ status }: { status: string }) {
  if (status === "healthy") return <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Healthy</Badge>;
  if (status === "warning") return <Badge variant="secondary" className="gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" /> Warning</Badge>;
  return <Badge variant="destructive" className="gap-1"><ShieldAlert className="h-3 w-3" /> Critical</Badge>;
}

function CompletenessRow({ label, have, total }: { label: string; have: number; total: number }) {
  const missing = total - have;
  const pct = total > 0 ? Math.round((have / total) * 100) : 0;
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{have}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{missing}</TableCell>
      <TableCell className="text-right">
        <Badge variant={pct >= 90 ? "default" : pct >= 50 ? "secondary" : "outline"} className="tabular-nums">
          {pct}%
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ─── Scraper & Catalog Health Tab ────────────────────────────────────────────

function ScraperHealthTab({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, refetch, isFetching } = useAppQuery({
    queryKey: queryKeys.bandcamp.scraperHealth(workspaceId),
    queryFn: () => getBandcampScraperHealth(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Scraper activity is <strong>near-real-time</strong> from logs. Catalog completeness numbers are{" "}
          {data.catalogStats?.computed_at ? (
            <>from snapshot <span className="font-mono text-xs">{timeAgo(data.catalogStats.computed_at)}</span></>
          ) : (
            <>computed live (no snapshot yet)</>
          )}.
        </p>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Sensor readings */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {data.sensorReadings.length > 0 ? (
          data.sensorReadings
            .filter((r, i, arr) => arr.findIndex(x => x.sensor_name === r.sensor_name) === i)
            .map((r) => (
              <Card key={r.sensor_name}>
                <CardHeader className="pb-1 pt-3 px-4">
                  <CardDescription className="text-xs truncate">{r.sensor_name}</CardDescription>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="flex items-center justify-between">
                    <SensorBadge status={r.status} />
                    <span className="text-xs text-muted-foreground">{timeAgo(r.created_at)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 truncate">{r.message}</p>
                </CardContent>
              </Card>
            ))
        ) : (
          <Card className="col-span-full">
            <CardContent className="py-4 text-center text-sm text-muted-foreground">
              No sensor readings yet. Sensors run every 5 minutes.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Block rate + scrape stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-muted-foreground">Block Rate (1h)</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {data.blockRate.rate}%
            </p>
            <p className="text-xs text-muted-foreground">{data.blockRate.blocked}/{data.blockRate.total} blocked</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-muted-foreground">Open Issues</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{data.reviewCount}</p>
            <p className="text-xs text-muted-foreground">in review queue</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-muted-foreground">Mapped Items</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{data.completeness.total}</p>
            <p className="text-xs text-muted-foreground">{data.completeness.hasUrl} with URL</p>
          </CardContent>
        </Card>
      </div>

      {/* Catalog completeness (have vs missing) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> Catalog Completeness
          </CardTitle>
          <CardDescription>
            Bandcamp-mapped products only. Secondary image counts are derived heuristics.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead className="text-right">Have</TableHead>
                <TableHead className="text-right">Missing</TableHead>
                <TableHead className="text-right">Coverage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <CompletenessRow label="Album Cover" have={data.completeness.hasAlbumCover} total={data.completeness.total} />
              <CompletenessRow label="About / Description" have={data.completeness.hasAbout} total={data.completeness.total} />
              <CompletenessRow label="Credits" have={data.completeness.hasCredits} total={data.completeness.total} />
              <CompletenessRow label="Track List" have={data.completeness.hasTracks} total={data.completeness.total} />
              <CompletenessRow label="Bandcamp URL" have={data.completeness.hasUrl} total={data.completeness.total} />
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Recent activity log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" /> Recent Sync Activity
          </CardTitle>
          <CardDescription>Latest channel_sync_log entries (near-real-time)</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No recent activity.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Processed</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentLogs.map((log, i) => (
                  <TableRow key={`${log.created_at}-${i}`}>
                    <TableCell className="font-mono text-xs">{log.sync_type}</TableCell>
                    <TableCell>
                      <Badge variant={log.status === "completed" ? "default" : log.status === "failed" ? "destructive" : "secondary"}>
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{log.items_processed}</TableCell>
                    <TableCell className="text-right tabular-nums">{log.items_failed}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{timeAgo(log.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Open review queue items with catalog links */}
      {data.reviewItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Open Scraper Issues ({data.reviewCount})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.reviewItems.map((item) => {
                  const mappingId = (item.metadata as Record<string, unknown>)?.mappingId as string | undefined;
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm max-w-[300px] truncate">{item.title}</TableCell>
                      <TableCell>
                        <Badge variant={item.severity === "critical" ? "destructive" : item.severity === "medium" ? "secondary" : "outline"}>
                          {item.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{timeAgo(item.created_at)}</TableCell>
                      <TableCell>
                        {mappingId && (
                          <a href={`/admin/catalog/${mappingId}`} className="text-blue-600 hover:underline">
                            <ExternalLink className="h-3 w-3 inline mr-1" />View
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BandcampSettingsPage() {
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newConn, setNewConn] = useState({ orgId: "", bandId: "", bandName: "", bandUrl: "" });

  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";

  const {
    data: accounts,
    isLoading: accountsLoading,
    isFetching: accountsFetching,
  } = useAppQuery({
    queryKey: queryKeys.bandcamp.accounts(workspaceId),
    queryFn: () => getBandcampAccounts(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });
  const isLoading = !workspaceId || accountsLoading || accountsFetching;

  const { data: orgs } = useAppQuery({
    queryKey: ["organizations", workspaceId],
    queryFn: () => getOrganizationsForWorkspace(workspaceId),
    tier: CACHE_TIERS.STABLE,
    enabled: !!workspaceId,
  });

  const syncMutation = useAppMutation({
    mutationFn: () => triggerBandcampSync(workspaceId),
    invalidateKeys: [queryKeys.bandcamp.all],
    onSuccess: () => setSyncingId(null),
    onError: () => setSyncingId(null),
  });

  const createMutation = useAppMutation({
    mutationFn: () =>
      createBandcampConnection({
        workspaceId: workspaceId,
        orgId: newConn.orgId,
        bandId: Number(newConn.bandId),
        bandName: newConn.bandName,
        bandUrl: newConn.bandUrl || null,
      }),
    invalidateKeys: [queryKeys.bandcamp.all],
    onSuccess: () => {
      setShowAddDialog(false);
      setNewConn({ orgId: "", bandId: "", bandName: "", bandUrl: "" });
    },
  });

  const deleteMutation = useAppMutation({
    mutationFn: (connectionId: string) => deleteBandcampConnection({ connectionId }),
    invalidateKeys: [queryKeys.bandcamp.all],
  });

  const canCreate =
    newConn.orgId && newConn.bandId && Number(newConn.bandId) > 0 && newConn.bandName;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Bandcamp</h1>
        <div className="flex gap-2">
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Account
          </Button>
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
      </div>

      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="health">Scraper &amp; Catalog Health</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="mt-4">
          {isLoading ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (accounts ?? []).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <Music className="h-8 w-8 mx-auto mb-2 opacity-50" />
                No Bandcamp accounts connected. Click &ldquo;Add Account&rdquo; to get started.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Accounts</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-semibold">{accounts?.length ?? 0}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Artists</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-semibold">
                      {accounts?.reduce((sum, a) => sum + a.memberArtistCount, 0) ?? 0}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Merch Items</CardTitle>
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
                    <TableHead className="w-36" />
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
                        <div className="flex gap-1">
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
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate(account.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </TabsContent>

        <TabsContent value="health" className="mt-4">
          {workspaceId ? (
            <ScraperHealthTab workspaceId={workspaceId} />
          ) : (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Add Account Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Bandcamp Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <label htmlFor="bc-org" className="text-sm font-medium">
                Organization (Label)
              </label>
              <select
                id="bc-org"
                value={newConn.orgId}
                onChange={(e) => setNewConn((c) => ({ ...c, orgId: e.target.value }))}
                className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm mt-1"
              >
                <option value="">Select an organization...</option>
                {(orgs ?? []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="bc-band-id" className="text-sm font-medium">
                Band ID
              </label>
              <Input
                id="bc-band-id"
                type="number"
                placeholder="e.g. 1430196613"
                value={newConn.bandId}
                onChange={(e) => setNewConn((c) => ({ ...c, bandId: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="bc-band-name" className="text-sm font-medium">
                Band Name
              </label>
              <Input
                id="bc-band-name"
                placeholder="e.g. Across the Horizon"
                value={newConn.bandName}
                onChange={(e) => setNewConn((c) => ({ ...c, bandName: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="bc-band-url" className="text-sm font-medium">
                Band URL (optional)
              </label>
              <Input
                id="bc-band-url"
                type="url"
                placeholder="https://bandname.bandcamp.com"
                value={newConn.bandUrl}
                onChange={(e) => setNewConn((c) => ({ ...c, bandUrl: e.target.value }))}
              />
            </div>
            <Button
              className="w-full"
              disabled={!canCreate || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "Creating..." : "Add Account"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
