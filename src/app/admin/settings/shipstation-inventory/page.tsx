"use client";

/**
 * Phase 5 — admin ShipStation v2 ↔ DB reconcile monitoring page.
 *
 * Read-only operational dashboard for the tiered reconcile sensor
 * (`shipstation-bandcamp-reconcile-{hot,warm,cold}`). Surfaces:
 *
 *   1. Open inventory_drift review queue rows grouped by severity
 *      (low / medium / high / critical). Bundle drift items (Phase 2.5(c))
 *      and reconcile drift items both write to category='inventory_drift',
 *      so this card is a unified backlog indicator.
 *   2. Latest run per tier (hot / warm / cold) from `channel_sync_log`,
 *      with last-success time and drift count. Drives the "is reconcile
 *      actually running?" question.
 *   3. A "Rerun now" control per tier — staff escalation when something
 *      looks stale. Fires `shipstation-bandcamp-reconcile` scoped to
 *      this workspace (no global re-runs from this page).
 *   4. Per-SKU spot-lookup against the `sku_sync_status` view (Phase 5
 *      §7.1.13 migration). Used for client-support drill-downs ("our
 *      Shopify shows 5 but Bandcamp shows 7 — what's going on?").
 *   5. Recent runs table (last 20) with optional tier filter.
 *
 * Operator workflow:
 *   - Glance at top cards → expect green per-tier "last run" timestamps
 *     well within the cron interval (5m hot / 30m warm / 6h cold).
 *   - If the open-drift count is non-zero, follow the link to the
 *     review queue for triage.
 *   - For a specific client complaint, paste the SKU into the lookup
 *     card and read off the per-system push timestamps + last error.
 *
 * Rule #41: every action is bounded — heavy work runs in Trigger.
 * Rule #58: actions live in `src/actions/shipstation-inventory-monitor.ts`.
 */

import { Loader2, PlayCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  type DriftSummaryResult,
  getReconcileDriftSummary,
  getSkuSyncStatus,
  listReconcileRuns,
  type ReconcileRunRow,
  type SkuSyncStatusRow,
  triggerReconcileRun,
} from "@/actions/shipstation-inventory-monitor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ReconcileTier = "hot" | "warm" | "cold";

const TIER_LABEL: Record<ReconcileTier, string> = {
  hot: "Hot (5 min)",
  warm: "Warm (30 min)",
  cold: "Cold (6 h)",
};

export default function ShipStationInventoryPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [skuLookup, setSkuLookup] = useState("");
  const [skuResult, setSkuResult] = useState<SkuSyncStatusRow | null>(null);

  const enabled = workspaceId.length === 36;

  const summaryQuery = useAppQuery<DriftSummaryResult>({
    queryKey: ["admin", "ssv2-reconcile-summary", workspaceId],
    queryFn: () => getReconcileDriftSummary({ workspaceId }),
    enabled,
    tier: CACHE_TIERS.SESSION,
  });

  const runsQuery = useAppQuery<ReconcileRunRow[]>({
    queryKey: ["admin", "ssv2-reconcile-runs", workspaceId],
    queryFn: () => listReconcileRuns({ workspaceId, limit: 20 }),
    enabled,
    tier: CACHE_TIERS.SESSION,
  });

  const triggerMut = useAppMutation({
    mutationFn: triggerReconcileRun,
    onSuccess: () => {
      summaryQuery.refetch();
      runsQuery.refetch();
    },
  });

  const skuMut = useAppMutation({
    mutationFn: getSkuSyncStatus,
    onSuccess: (data) => setSkuResult(data),
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          ShipStation v2 inventory monitoring
        </h1>
        <p className="text-sm text-muted-foreground">
          Phase 5: tiered reconcile sensor compares ShipStation v2's stored available against our DB
          and absorbs drift into our DB via <code>recordInventoryChange()</code>. Bundle drift
          (Phase 2.5(c)) shares the same review-queue category but a different sensor.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspace scope</CardTitle>
          <CardDescription>
            Single-workspace view. Cross-workspace ops are intentionally blocked at the action
            layer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-w-md">
            <Label htmlFor="workspaceId">Workspace UUID</Label>
            <Input
              id="workspaceId"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </div>
        </CardContent>
      </Card>

      {enabled && (
        <>
          {/* Drift summary + per-tier latest run */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4" /> Open drift items
                </CardTitle>
                <CardDescription>
                  <code>warehouse_review_queue</code> WHERE{" "}
                  <code>category = 'inventory_drift'</code> AND <code>status = 'open'</code>.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summaryQuery.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : summaryQuery.data ? (
                  <div className="space-y-2">
                    <p className="text-2xl font-semibold">{summaryQuery.data.totalOpen}</p>
                    <div className="flex flex-wrap gap-2">
                      {summaryQuery.data.bySeverity.map((row) => (
                        <Badge
                          key={row.severity}
                          variant={
                            row.severity === "critical" || row.severity === "high"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {row.severity}: {row.open_count}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No data.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tier health</CardTitle>
                <CardDescription>
                  Latest <code>channel_sync_log</code> row per tier (
                  <code>sync_type = 'reconcile_{"{tier}"}'</code>).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summaryQuery.data ? (
                  <ul className="space-y-3 text-sm">
                    {summaryQuery.data.byTier.map((tier) => (
                      <li key={tier.tier} className="flex items-center justify-between gap-3">
                        <div className="space-y-0.5">
                          <p className="font-medium">{TIER_LABEL[tier.tier]}</p>
                          <p className="text-xs text-muted-foreground">
                            {tier.last_run_at
                              ? `Last run ${new Date(tier.last_run_at).toLocaleString()} (${tier.last_status ?? "?"}, drift=${tier.last_drift_count ?? 0})`
                              : "No runs recorded yet."}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={triggerMut.isPending}
                          onClick={() => triggerMut.mutate({ workspaceId, tier: tier.tier })}
                        >
                          {triggerMut.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <PlayCircle className="h-3 w-3 mr-1" /> Rerun
                            </>
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Per-SKU spot lookup */}
          <Card>
            <CardHeader>
              <CardTitle>Per-SKU sync status</CardTitle>
              <CardDescription>
                Reads the canonical <code>sku_sync_status</code> view (Phase 5 §7.1.13). Useful for
                support drill-downs.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col md:flex-row gap-3 items-end">
                <div className="space-y-2 flex-1">
                  <Label htmlFor="sku">SKU</Label>
                  <Input
                    id="sku"
                    value={skuLookup}
                    onChange={(e) => setSkuLookup(e.target.value)}
                    placeholder="LILA-AV1"
                  />
                </div>
                <Button
                  disabled={!skuLookup || skuMut.isPending}
                  onClick={() => skuMut.mutate({ workspaceId, sku: skuLookup })}
                >
                  {skuMut.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  Lookup
                </Button>
              </div>

              {skuMut.error && (
                <p className="text-sm text-destructive">
                  {skuMut.error instanceof Error ? skuMut.error.message : "Lookup failed."}
                </p>
              )}

              {skuMut.isSuccess && skuResult === null && (
                <p className="text-sm text-muted-foreground">
                  No variant found for <code>{skuLookup}</code> in this workspace.
                </p>
              )}

              {skuResult && (
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  <Stat label="Available" value={skuResult.available ?? 0} />
                  <Stat
                    label="Last internal write"
                    value={
                      skuResult.last_internal_write_at
                        ? new Date(skuResult.last_internal_write_at).toLocaleString()
                        : "—"
                    }
                  />
                  <Stat
                    label="Last v2 push"
                    value={
                      skuResult.last_shipstation_push_at
                        ? new Date(skuResult.last_shipstation_push_at).toLocaleString()
                        : "—"
                    }
                  />
                  <Stat
                    label="Last Bandcamp push"
                    value={
                      skuResult.last_bandcamp_push_at
                        ? new Date(skuResult.last_bandcamp_push_at).toLocaleString()
                        : "—"
                    }
                  />
                  <Stat label="Push mode" value={skuResult.bandcamp_push_mode} />
                  <Stat
                    label="Push blocked?"
                    value={skuResult.bandcamp_push_blocked ? "yes" : "no"}
                  />
                  <Stat label="Distro?" value={skuResult.is_distro ? "yes" : "no"} />
                  <Stat
                    label="Bandcamp mapping?"
                    value={skuResult.has_bandcamp_mapping ? "yes" : "no"}
                  />
                  <Stat label="Open conflict?" value={skuResult.sku_conflict_open ? "yes" : "no"} />
                  <Stat
                    label="Baseline anomaly?"
                    value={skuResult.baseline_anomaly_open ? "yes" : "no"}
                  />
                  {skuResult.last_external_error && (
                    <div className="col-span-full">
                      <Label className="text-xs">Last external error</Label>
                      <p className="text-sm text-destructive">{skuResult.last_external_error}</p>
                    </div>
                  )}
                </dl>
              )}
            </CardContent>
          </Card>

          {/* Recent runs */}
          <Card>
            <CardHeader>
              <CardTitle>Recent reconcile runs</CardTitle>
              <CardDescription>
                Last 20 entries from <code>channel_sync_log</code> (
                <code>channel = 'shipstation_v2'</code>, <code>sync_type LIKE 'reconcile_%'</code>).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {runsQuery.isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : runsQuery.data && runsQuery.data.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Evaluated</TableHead>
                      <TableHead className="text-right">Drift</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runsQuery.data.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          {row.started_at ? new Date(row.started_at).toLocaleString() : "—"}
                        </TableCell>
                        <TableCell>{row.sync_type.replace("reconcile_", "")}</TableCell>
                        <TableCell>
                          <Badge variant={row.status === "completed" ? "secondary" : "destructive"}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{row.items_processed ?? 0}</TableCell>
                        <TableCell className="text-right">{row.items_failed ?? 0}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No reconcile runs yet.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
