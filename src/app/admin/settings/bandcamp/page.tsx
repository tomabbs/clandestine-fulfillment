"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  CheckCircle2,
  Download,
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
import React, { useMemo, useState } from "react";
import { getUserContext } from "@/actions/auth";
import {
  createBandcampConnection,
  deleteBandcampConnection,
  getBandcampAccounts,
  getBandcampBackfillAudit,
  getBandcampSalesOverview,
  getBandcampScraperHealth,
  getBandcampTrending,
  getOrganizationsForWorkspace,
  triggerBandcampSync,
} from "@/actions/bandcamp";
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { BC_GENRES } from "@/lib/shared/genre-taxonomy";
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
  if (status === "healthy")
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Healthy
      </Badge>
    );
  if (status === "warning")
    return (
      <Badge variant="secondary" className="gap-1 text-amber-600">
        <AlertTriangle className="h-3 w-3" /> Warning
      </Badge>
    );
  return (
    <Badge variant="destructive" className="gap-1">
      <ShieldAlert className="h-3 w-3" /> Critical
    </Badge>
  );
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
        <Badge
          variant={pct >= 90 ? "default" : pct >= 50 ? "secondary" : "outline"}
          className="tabular-nums"
        >
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

// ─── Bandcamp Health Tab ─────────────────────────────────────────────────────

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

  const t = data.total ?? 0;
  const api = data.apiCoverage ?? {
    subdomain: 0,
    albumTitle: 0,
    price: 0,
    releaseDate: 0,
    image: 0,
    originQuantities: 0,
    rawApiData: 0,
    options: 0,
  };
  const scraper = data.scraperCoverage ?? { artUrl: 0, about: 0, credits: 0, tracks: 0 };
  const sales = data.salesCoverage ?? { catalogNumber: 0, upc: 0 };
  const albumFmt = data.albumFormatCoverage ?? {
    total: 0,
    about: 0,
    credits: 0,
    tracks: 0,
    art: 0,
    tags: 0,
    byType: { vinyl: 0, cd: 0, cassette: 0 },
  };
  const nonAlbumItems = data.nonAlbumCoverage ?? {
    total: 0,
    art: 0,
    byCategory: { apparel: 0, merch: 0, bundle: 0, other: 0 },
  };
  const urls = data.urlSources ?? { scraper_verified: 0, constructed: 0, orders_api: 0, none: 0 };
  const totalWithUrl = data.totalWithUrl ?? 0;
  const scrapeStats = data.scrapeStats ?? { total: 0, success: 0, failed: 0, blocked: 0 };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Sync activity is <strong>near-real-time</strong> from logs. Data coverage is computed
          live.
        </p>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Row 1: Key numbers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Mapped Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{t}</p>
            <p className="text-xs text-muted-foreground">
              {api.rawApiData} matched by SKU ({t > 0 ? Math.round((api.rawApiData / t) * 100) : 0}
              %)
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              URLs Resolved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {totalWithUrl}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({t > 0 ? Math.round((totalWithUrl / t) * 100) : 0}%)
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {urls.scraper_verified} scraped · {urls.orders_api} from API · {urls.constructed}{" "}
              constructed
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Sales Loaded
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {(data.totalSales ?? 0).toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">
              {(data.uniqueBuyers ?? 0).toLocaleString()} unique buyers
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pre-orders</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{(data.preorders ?? []).length}</p>
            <p className="text-xs text-muted-foreground">
              {(data.preorders ?? []).length === 0 ? "No active pre-orders" : "active releases"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Sensor readings */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {data.sensorReadings.length > 0 ? (
          data.sensorReadings
            .filter((r, i, arr) => arr.findIndex((x) => x.sensor_name === r.sensor_name) === i)
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
              Sensors run every 5 minutes.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Row 3: Sync Pipeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" /> Sync Pipeline
          </CardTitle>
          <CardDescription>Every Bandcamp Trigger task and its last run</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Processed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead>Last Run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.syncPipeline ?? []).map((s) => (
                <TableRow key={s.syncType}>
                  <TableCell className="font-mono text-xs">{s.syncType}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === "completed"
                          ? "default"
                          : s.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.itemsProcessed}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.itemsFailed}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {timeAgo(s.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-mono text-xs">scrape_page (1h)</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {scrapeStats.success} ok / {scrapeStats.failed} fail
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{scrapeStats.success}</TableCell>
                <TableCell className="text-right tabular-nums">{scrapeStats.failed}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {scrapeStats.total} in last hour
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Row 4: Pre-orders */}
      {(data.preorders ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Active Pre-orders ({(data.preorders ?? []).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Release Date</TableHead>
                  <TableHead className="text-right">Days Until</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data.preorders ?? []).map((p) => {
                  const daysUntil = p.streetDate
                    ? Math.max(
                        0,
                        Math.ceil((new Date(p.streetDate).getTime() - Date.now()) / 86400000),
                      )
                    : null;
                  return (
                    <TableRow key={p.variantId}>
                      <TableCell className="font-medium">
                        <a
                          href={`/admin/catalog/${p.productId}`}
                          className="text-blue-600 hover:underline"
                        >
                          {p.title?.slice(0, 50)}
                        </a>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                      <TableCell className="text-sm">
                        {p.streetDate ? new Date(p.streetDate).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {daysUntil != null ? `${daysUntil}d` : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Row 5: Data Coverage — API vs Scraper side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">API Data Coverage</CardTitle>
            <CardDescription>
              From Bandcamp Merch API (get_merch_details). Only SKU-matched items receive this data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead className="text-right">Have</TableHead>
                  <TableHead className="text-right">Coverage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <CompletenessRow label="Subdomain" have={api.subdomain} total={t} />
                <CompletenessRow label="Album Title" have={api.albumTitle} total={t} />
                <CompletenessRow label="Price" have={api.price} total={t} />
                <CompletenessRow label="Release Date" have={api.releaseDate} total={t} />
                <CompletenessRow label="Image" have={api.image} total={t} />
                <CompletenessRow label="Stock by Origin" have={api.originQuantities} total={t} />
                <CompletenessRow label="Full API Snapshot" have={api.rawApiData} total={t} />
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Album Format Enrichment</CardTitle>
            <CardDescription>
              {albumFmt.total} album products (Vinyl {albumFmt.byType.vinyl}, CD{" "}
              {albumFmt.byType.cd}, Cassette {albumFmt.byType.cassette})
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead className="text-right">Have</TableHead>
                  <TableHead className="text-right">Coverage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <CompletenessRow
                  label="About / Description"
                  have={albumFmt.about}
                  total={albumFmt.total}
                />
                <CompletenessRow label="Credits" have={albumFmt.credits} total={albumFmt.total} />
                <CompletenessRow label="Track List" have={albumFmt.tracks} total={albumFmt.total} />
                <CompletenessRow label="Album Cover" have={albumFmt.art} total={albumFmt.total} />
                <CompletenessRow label="Genre Tags" have={albumFmt.tags} total={albumFmt.total} />
              </TableBody>
            </Table>
            <div className="mt-3 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">
                From Sales Report API
              </p>
              <Table>
                <TableBody>
                  <CompletenessRow label="Catalog Number" have={sales.catalogNumber} total={t} />
                  <CompletenessRow label="UPC" have={sales.upc} total={t} />
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Merch & Apparel</CardTitle>
            <CardDescription>{nonAlbumItems.total} non-album items</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Apparel</span>
                <span className="font-medium">{nonAlbumItems.byCategory.apparel}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Merch</span>
                <span className="font-medium">{nonAlbumItems.byCategory.merch}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bundles</span>
                <span className="font-medium">{nonAlbumItems.byCategory.bundle}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Other</span>
                <span className="font-medium">{nonAlbumItems.byCategory.other}</span>
              </div>
            </div>
            <div className="mt-3 border-t pt-3">
              <Table>
                <TableBody>
                  <CompletenessRow
                    label="Product Art"
                    have={nonAlbumItems.art}
                    total={nonAlbumItems.total}
                  />
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Album-specific fields (about, credits, tracks, tags) are N/A for merch items.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Row 6: URL Source Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">URL Sources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
            <div>
              <p className="text-lg font-semibold tabular-nums">{urls.scraper_verified}</p>
              <p className="text-xs text-muted-foreground">Scraper verified</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums">{urls.constructed}</p>
              <p className="text-xs text-muted-foreground">Constructed</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums">{urls.orders_api}</p>
              <p className="text-xs text-muted-foreground">Sales / Orders API</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums text-green-600">{totalWithUrl}</p>
              <p className="text-xs text-muted-foreground">Total with URL</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums text-red-500">{urls.none}</p>
              <p className="text-xs text-muted-foreground">No URL</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Row 7: Open Issues */}
      {data.reviewItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Open Issues ({data.reviewCount})
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
                  const mappingId = (item.metadata as Record<string, unknown>)?.mappingId as
                    | string
                    | undefined;
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm max-w-[300px] truncate">{item.title}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.severity === "critical"
                              ? "destructive"
                              : item.severity === "medium"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {item.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(item.created_at)}
                      </TableCell>
                      <TableCell>
                        {mappingId && (
                          <a
                            href={`/admin/catalog/${mappingId}`}
                            className="text-blue-600 hover:underline"
                          >
                            <ExternalLink className="h-3 w-3 inline mr-1" />
                            View
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

// ─── Backfill Audit Card ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function statusBadgeVariant(status: string) {
  if (status === "completed") return "default" as const;
  if (status === "partial") return "secondary" as const;
  if (status === "running") return "outline" as const;
  if (status === "failed") return "destructive" as const;
  return "outline" as const;
}

function BackfillAuditCard({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.bandcamp.backfillAudit(workspaceId),
    queryFn: () => getBandcampBackfillAudit(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sales Data Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  const { overall, accounts } = data;
  const totalExpected = accounts.reduce(
    (s: number, a: (typeof accounts)[0]) => s + a.monthGrid.length,
    0,
  );
  const totalCovered = accounts.reduce(
    (s: number, a: (typeof accounts)[0]) =>
      s +
      a.monthGrid.filter(
        (c: (typeof a.monthGrid)[0]) => c.chunkStatus === "success" || c.chunkStatus === "skipped",
      ).length,
    0,
  );
  const overallPct = totalExpected > 0 ? Math.round((totalCovered / totalExpected) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Sales Data Coverage: {overallPct}%
        </CardTitle>
        <CardDescription>
          {overall.totalConnections} accounts | {overall.completedCount} completed |{" "}
          {overall.partialCount} partial | {overall.runningCount} running
          {overall.failedChunkCount > 0 && (
            <span className="text-destructive ml-1">
              | {overall.failedChunkCount} failed chunks
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 h-2 w-full rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-green-500 transition-all" style={{ width: `${overallPct}%` }} />
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">Account</TableHead>
              <TableHead className="w-[90px]">Status</TableHead>
              <TableHead className="w-[80px] text-right">Sales</TableHead>
              <TableHead className="w-[80px] text-right">Coverage</TableHead>
              <TableHead className="w-[60px] text-right">Failed</TableHead>
              <TableHead className="w-[60px] text-right">Missing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((acct: (typeof accounts)[0]) => {
              const isOpen = expandedId === acct.connectionId;
              return (
                <React.Fragment key={acct.connectionId}>
                  <TableRow
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedId(isOpen ? null : acct.connectionId)}
                  >
                    <TableCell className="font-medium text-sm">{acct.bandName}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(acct.status)} className="text-xs">
                        {acct.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {acct.totalSales.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {acct.coveragePercent}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {acct.failedChunks > 0 ? (
                        <span className="text-destructive">{acct.failedChunks}</span>
                      ) : (
                        "0"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {(acct.missingChunks ?? 0) > 0 ? (
                        <span className="text-muted-foreground">{acct.missingChunks}</span>
                      ) : (
                        "0"
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <MonthHeatmap monthGrid={acct.monthGrid} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MonthHeatmap({
  monthGrid,
}: {
  monthGrid: Array<{
    year: number;
    month: number;
    chunkStatus: string;
    salesCount: number;
    error: string | null;
  }>;
}) {
  const years = Array.from(new Set(monthGrid.map((c) => c.year))).sort();
  if (years.length === 0) return <div className="p-3 text-xs text-muted-foreground">No data</div>;

  const byYearMonth = new Map<string, (typeof monthGrid)[0]>();
  for (const cell of monthGrid) byYearMonth.set(`${cell.year}-${cell.month}`, cell);

  return (
    <div className="p-3 overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr>
            <th className="text-left font-medium text-muted-foreground w-[50px]">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="text-center font-medium text-muted-foreground w-[52px]">
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year}>
              <td className="text-muted-foreground font-medium">{year}</td>
              {Array.from({ length: 12 }, (_, i) => {
                const cell = byYearMonth.get(`${year}-${i + 1}`);
                if (!cell)
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: month index in heatmap grid
                    <td key={i} className="text-center">
                      -
                    </td>
                  );

                let bg = "bg-muted/30";
                let text = "-";
                if (cell.chunkStatus === "success" && cell.salesCount > 0) {
                  bg = "bg-green-100 dark:bg-green-900/30";
                  text = String(cell.salesCount);
                } else if (cell.chunkStatus === "success" || cell.chunkStatus === "skipped") {
                  bg = "bg-green-50 dark:bg-green-950/20";
                  text = "0";
                } else if (cell.chunkStatus === "failed") {
                  bg = "bg-red-100 dark:bg-red-900/30";
                  text = "!";
                }

                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: month index in heatmap grid
                    key={i}
                    className={`text-center rounded px-1 py-0.5 ${bg}`}
                    title={cell.error ?? undefined}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {monthGrid.some((c) => c.chunkStatus === "failed") && (
        <div className="mt-2 space-y-1">
          <p className="text-xs font-medium text-destructive">Failed Chunks:</p>
          {monthGrid
            .filter((c) => c.chunkStatus === "failed")
            .map((c) => (
              <p key={`${c.year}-${c.month}`} className="text-xs text-muted-foreground pl-2">
                {c.year}-{String(c.month).padStart(2, "0")}: {c.error ?? "Unknown error"}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Sales History Tab ────────────────────────────────────────────────────────

type SalesSortField =
  | "itemName"
  | "artist"
  | "bandName"
  | "bcGenre"
  | "itemType"
  | "package"
  | "totalUnits"
  | "totalRevenue"
  | "sku";
type SortDir = "asc" | "desc";

function SalesHistoryTab({ workspaceId }: { workspaceId: string }) {
  const [connFilter, setConnFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [bcGenreFilter, setBcGenreFilter] = useState<string>("all");
  const [dspGenreFilter, setDspGenreFilter] = useState<string>("all");
  const [subGenreFilter, setSubGenreFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SalesSortField>("totalUnits");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

  const { data, isLoading, refetch, isFetching } = useAppQuery({
    queryKey: queryKeys.bandcamp.salesOverview(workspaceId),
    queryFn: () => getBandcampSalesOverview(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });

  function toggleSort(field: SalesSortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(
        field === "itemName" || field === "artist" || field === "bandName" || field === "bcGenre"
          ? "asc"
          : "desc",
      );
    }
    setPage(1);
  }

  function SortIcon({ field }: { field: SalesSortField }) {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3 w-3 inline opacity-40" />;
    return sortDir === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 inline" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 inline" />
    );
  }

  const sortedFiltered = useMemo(() => {
    const items = (data?.items ?? []).filter((item) => {
      if (connFilter !== "all" && item.connectionId !== connFilter) return false;
      if (typeFilter !== "all" && item.itemType !== typeFilter) return false;
      if (bcGenreFilter === "untagged") {
        if (item.bcGenre) return false;
      } else if (bcGenreFilter !== "all" && item.bcGenre !== bcGenreFilter) return false;
      if (dspGenreFilter !== "all" && item.dspGenre !== dspGenreFilter) return false;
      if (subGenreFilter !== "all" && item.subGenre !== subGenreFilter) return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return items.sort((a, b) => {
      switch (sortField) {
        case "itemName":
          return dir * (a.itemName ?? "").localeCompare(b.itemName ?? "");
        case "artist":
          return dir * (a.artist ?? "").localeCompare(b.artist ?? "");
        case "bandName":
          return dir * (a.bandName ?? "").localeCompare(b.bandName ?? "");
        case "bcGenre":
          return dir * (a.bcGenre ?? "zzz").localeCompare(b.bcGenre ?? "zzz");
        case "itemType":
          return dir * (a.itemType ?? "").localeCompare(b.itemType ?? "");
        case "package":
          return dir * (a.package ?? "").localeCompare(b.package ?? "");
        case "totalUnits":
          return dir * (a.totalUnits - b.totalUnits);
        case "totalRevenue":
          return dir * (a.totalRevenue - b.totalRevenue);
        case "sku":
          return dir * (a.sku ?? "").localeCompare(b.sku ?? "");
        default:
          return 0;
      }
    });
  }, [
    data?.items,
    connFilter,
    typeFilter,
    bcGenreFilter,
    dspGenreFilter,
    subGenreFilter,
    sortField,
    sortDir,
  ]);

  const allBcGenres = useMemo(() => {
    const set = new Set<string>();
    for (const item of data?.items ?? []) {
      if (item.bcGenre) set.add(item.bcGenre);
    }
    return Array.from(set).sort();
  }, [data?.items]);

  const allDspGenres = useMemo(() => {
    const set = new Set<string>();
    for (const item of data?.items ?? []) {
      if (item.dspGenre) set.add(item.dspGenre);
    }
    return Array.from(set).sort();
  }, [data?.items]);

  const allSubGenres = useMemo(() => {
    const set = new Set<string>();
    for (const item of data?.items ?? []) {
      if (item.subGenre) set.add(item.subGenre);
    }
    return Array.from(set).sort();
  }, [data?.items]);

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const totalRevenue = sortedFiltered.reduce((s, i) => s + i.totalRevenue, 0);
  const totalUnits = sortedFiltered.reduce((s, i) => s + i.totalUnits, 0);
  const allItemsRevenue = (data.items ?? []).reduce((s, i) => s + i.totalRevenue, 0);
  const allItemsUnits = (data.items ?? []).reduce((s, i) => s + i.totalUnits, 0);
  const isFiltered =
    connFilter !== "all" ||
    typeFilter !== "all" ||
    bcGenreFilter !== "all" ||
    dspGenreFilter !== "all" ||
    subGenreFilter !== "all";
  const pctRevenue = allItemsRevenue > 0 ? Math.round((totalRevenue / allItemsRevenue) * 100) : 100;
  const pctUnits = allItemsUnits > 0 ? Math.round((totalUnits / allItemsUnits) * 100) : 100;
  const pageItems = sortedFiltered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {data.grandTotalSales.toLocaleString()} transactions loaded. {(data.items ?? []).length}{" "}
          unique items.
        </p>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <BackfillAuditCard workspaceId={workspaceId} />

      {/* Filters + summary */}
      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={connFilter}
          onChange={(e) => {
            setConnFilter(e.target.value);
            setPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="all">All Connections</option>
          {data.connections.map((c) => (
            <option key={c.connectionId} value={c.connectionId}>
              {c.bandName}
            </option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="all">All Types</option>
          <option value="album">Digital Albums</option>
          <option value="track">Tracks</option>
          <option value="package">Physical Merch</option>
          <option value="bundle">Bundles</option>
        </select>
        <select
          value={bcGenreFilter}
          onChange={(e) => {
            setBcGenreFilter(e.target.value);
            setPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="all">BC Genres</option>
          <option value="untagged">Untagged ({data.untaggedCount ?? 0})</option>
          {allBcGenres.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={dspGenreFilter}
          onChange={(e) => {
            setDspGenreFilter(e.target.value);
            setPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="all">DSP Genres</option>
          {allDspGenres.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={subGenreFilter}
          onChange={(e) => {
            setSubGenreFilter(e.target.value);
            setPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="all">Sub Genres</option>
          {allSubGenres.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-muted-foreground tabular-nums">
            {sortedFiltered.length} items{isFiltered ? ` (${pctUnits}%)` : ""} ·{" "}
            {totalUnits.toLocaleString()} units · $
            {totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            {isFiltered ? ` (${pctRevenue}% of revenue)` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const header = [
                "Artist",
                "Title",
                "Account",
                "BC Genre",
                "DSP Genre",
                "Sub Genre",
                "Tags",
                "Type",
                "Format",
                "Units",
                "Revenue",
                "Currency",
                "SKU",
                "Catalog #",
                "URL",
              ];
              const rows = sortedFiltered.map((item) => [
                `"${(item.artist ?? "").replace(/"/g, '""')}"`,
                `"${(item.itemName ?? "").replace(/"/g, '""')}"`,
                `"${(item.bandName ?? "").replace(/"/g, '""')}"`,
                item.bcGenre ?? "",
                item.dspGenre ?? "",
                item.subGenre ?? "",
                `"${(item.tags ?? []).join(", ").replace(/"/g, '""')}"`,
                item.itemType ?? "",
                `"${(item.package ?? "").replace(/"/g, '""')}"`,
                item.totalUnits,
                item.totalRevenue.toFixed(2),
                item.currency ?? "USD",
                item.sku ?? "",
                item.catalogNumber ?? "",
                item.itemUrl ?? "",
              ]);
              const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `bandcamp-sales-${new Date().toISOString().slice(0, 10)}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download className="h-3.5 w-3.5 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Items table with sortable headers */}
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={sortedFiltered.length}
        onPageChange={setPage}
        onPageSizeChange={(s: PageSize) => {
          setPageSize(s);
          setPage(1);
        }}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("artist")}>
              Artist <SortIcon field="artist" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort("itemName")}
            >
              Title <SortIcon field="itemName" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort("bandName")}
            >
              Account <SortIcon field="bandName" />
            </TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("bcGenre")}>
              Genre <SortIcon field="bcGenre" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort("itemType")}
            >
              Type <SortIcon field="itemType" />
            </TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("package")}>
              Format <SortIcon field="package" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none text-right"
              onClick={() => toggleSort("totalUnits")}
            >
              Units <SortIcon field="totalUnits" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none text-right"
              onClick={() => toggleSort("totalRevenue")}
            >
              Revenue <SortIcon field="totalRevenue" />
            </TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("sku")}>
              SKU <SortIcon field="sku" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageItems.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sales items may share connectionId+name+type
            <TableRow key={`${item.connectionId}-${item.itemName}-${item.itemType}-${i}`}>
              <TableCell className="text-sm max-w-[150px] truncate">{item.artist}</TableCell>
              <TableCell className="font-medium max-w-[250px] truncate">
                {item.itemUrl ? (
                  <a
                    href={item.itemUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {item.itemName}
                  </a>
                ) : (
                  item.itemName
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs max-w-[130px] truncate">
                {item.bandName}
              </TableCell>
              <TableCell className="text-xs max-w-[100px] truncate">
                {item.bcGenre ? (
                  <Badge variant="outline" className="text-xs">
                    {item.bcGenre}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    item.itemType === "album"
                      ? "default"
                      : item.itemType === "package"
                        ? "secondary"
                        : "outline"
                  }
                  className="text-xs"
                >
                  {item.itemType}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">
                {item.package ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {item.totalUnits.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                ${item.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {item.sku ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={sortedFiltered.length}
        onPageChange={setPage}
        onPageSizeChange={(s: PageSize) => {
          setPageSize(s);
          setPage(1);
        }}
      />

      {sortedFiltered.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No sales data{" "}
            {connFilter !== "all" || typeFilter !== "all"
              ? "for this filter"
              : "yet — backfill is running"}
            .
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Trending Tab ─────────────────────────────────────────────────────────────

function TrendingTab({ workspaceId }: { workspaceId: string }) {
  const [genre, setGenre] = useState("jazz");
  const [sort, setSort] = useState<"pop" | "new" | "rec" | "surprise" | "top">("pop");
  const [format, setFormat] = useState<"all" | "digital" | "vinyl" | "cd" | "cassette">("all");
  const [trendingPage, setTrendingPage] = useState(1);

  type TrendingResult = {
    items: Array<{
      title: string;
      artist: string;
      genre: string;
      url: string;
      bandUrl: string;
      artUrl: string;
      artUrlSmall: string;
      featuredTrack: string | null;
      isPreorder: boolean;
      comments: number;
      isClientArtist: boolean;
      clientBandName: string | null;
      packages: Array<{ typeStr: string; isVinyl: boolean; price: number; currency: string }>;
    }>;
    moreAvailable: boolean;
    formatSummary: { vinyl: number; cd: number; cassette: number; digital: number };
    tagName?: string;
  };

  const { data, isLoading, isFetching } = useAppQuery({
    queryKey: ["bandcamp-trending", genre, sort, format, trendingPage],
    queryFn: () =>
      getBandcampTrending(workspaceId, {
        tags: [genre],
        sort,
        format,
        page: trendingPage,
      }) as Promise<TrendingResult>,
    tier: CACHE_TIERS.SESSION,
  });

  const items = data?.items ?? [];
  const fmt = data?.formatSummary ?? { vinyl: 0, cd: 0, cassette: 0, digital: 0 };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Browse what is trending on Bandcamp. Your connected artists are highlighted.
        </p>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={genre}
          onChange={(e) => {
            setGenre(e.target.value);
            setTrendingPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          {BC_GENRES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as typeof sort);
            setTrendingPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="pop">Popular</option>
          <option value="new">New</option>
          <option value="top">Top Selling</option>
          <option value="rec">Recommended</option>
          <option value="surprise">Surprise</option>
        </select>
        <select
          value={format}
          onChange={(e) => {
            setFormat(e.target.value as typeof format);
            setTrendingPage(1);
          }}
          className="border-input bg-background h-8 rounded-md border px-3 text-sm"
        >
          <option value="all">All Formats</option>
          <option value="digital">Digital</option>
          <option value="vinyl">Vinyl</option>
          <option value="cd">CD</option>
          <option value="cassette">Cassette</option>
        </select>
        {(isLoading || isFetching) && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {items.length > 0 &&
            `${fmt.vinyl} vinyl · ${fmt.cd} CD · ${fmt.cassette} cassette · ${fmt.digital} digital-only`}
        </div>
      </div>

      {data?.tagName && <h2 className="text-lg font-semibold">Trending in {data.tagName}</h2>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {items.map((item, i) => (
          <Card
            // biome-ignore lint/suspicious/noArrayIndexKey: trending API results have no stable ID
            key={`${item.url}-${i}`}
            className={item.isClientArtist ? "border-2 border-blue-500" : ""}
          >
            <div className="aspect-square relative overflow-hidden rounded-t-lg">
              {/* biome-ignore lint/performance/noImgElement: external Bandcamp discover URLs */}
              <img
                src={item.artUrl}
                alt={`${item.artist} - ${item.title}`}
                className="object-cover w-full h-full"
                loading="lazy"
              />
              {item.isClientArtist && (
                <div className="absolute top-2 right-2">
                  <Badge variant="default" className="bg-blue-600 text-white text-xs">
                    Your Artist
                  </Badge>
                </div>
              )}
              {item.isPreorder && (
                <div className="absolute top-2 left-2">
                  <Badge variant="secondary" className="text-xs">
                    Pre-order
                  </Badge>
                </div>
              )}
            </div>
            <CardContent className="p-3 space-y-1">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-sm hover:underline line-clamp-1"
              >
                {item.title}
              </a>
              <a
                href={item.bandUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:underline line-clamp-1"
              >
                {item.artist}
              </a>
              {item.isClientArtist && item.clientBandName && (
                <p className="text-xs text-blue-600 font-medium">{item.clientBandName}</p>
              )}
              <div className="flex gap-1 flex-wrap pt-1">
                <Badge variant="outline" className="text-xs">
                  {item.genre}
                </Badge>
                {item.packages.map((p, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: package list has no stable ID
                  <Badge key={j} variant="secondary" className="text-xs">
                    {p.typeStr} ${p.price}
                  </Badge>
                ))}
              </div>
              {item.featuredTrack && (
                <p className="text-xs text-muted-foreground truncate pt-1">
                  <Music className="h-3 w-3 inline mr-1" />
                  {item.featuredTrack}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {items.length === 0 && !isLoading && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No trending items found for this genre.
          </CardContent>
        </Card>
      )}

      {data?.moreAvailable && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => setTrendingPage((p) => p + 1)}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Load More
          </Button>
        </div>
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
          <TabsTrigger value="health">Bandcamp Health</TabsTrigger>
          <TabsTrigger value="sales">Sales History</TabsTrigger>
          <TabsTrigger value="trending">Trending</TabsTrigger>
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

        <TabsContent value="sales" className="mt-4">
          {workspaceId ? (
            <SalesHistoryTab workspaceId={workspaceId} />
          ) : (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </TabsContent>

        <TabsContent value="trending" className="mt-4">
          {workspaceId ? (
            <TrendingTab workspaceId={workspaceId} />
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
