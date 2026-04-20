"use client";

/**
 * Phase 6 closeout — automated mega-plan verification dashboard.
 *
 * Operator-facing UI for the megaplan-spot-check Trigger task. Lists recent
 * runs with drift counts, lets staff trigger an on-demand run, and renders
 * the per-run markdown artifact in a dialog.
 *
 * The signed verification artifact at docs/MEGA_PLAN_VERIFICATION_2026-04-13.md
 * is linked at the top so reviewers can jump from "are spot-checks healthy
 * lately?" to "what was the formal closeout sign-off?"
 *
 * Plan reference: §C.9.
 */

import { Loader2, PlayCircle } from "lucide-react";
import { useState } from "react";
import {
  getSpotCheckArtifact,
  listSpotCheckRuns,
  type SpotCheckArtifact,
  type SpotCheckRunSummary,
  triggerSpotCheck,
} from "@/actions/megaplan-spot-check";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function MegaplanVerificationPage() {
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const runsQuery = useAppQuery<SpotCheckRunSummary[]>({
    queryKey: ["admin", "megaplan-spot-check-runs"],
    queryFn: () => listSpotCheckRuns(50),
    tier: CACHE_TIERS.SESSION,
  });

  const artifactQuery = useAppQuery<SpotCheckArtifact>({
    queryKey: ["admin", "megaplan-spot-check-artifact", openRunId ?? ""],
    queryFn: () => getSpotCheckArtifact(openRunId as string),
    enabled: !!openRunId,
    tier: CACHE_TIERS.STABLE,
  });

  const triggerMut = useAppMutation({
    mutationFn: triggerSpotCheck,
    onSuccess: () => runsQuery.refetch(),
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Mega-plan verification</h1>
        <p className="text-sm text-muted-foreground">
          Phase 6 closeout: hourly cross-system inventory spot-checks across DB, Redis, ShipStation
          v2, and Bandcamp. Drift_major must persist across two consecutive runs before a review
          queue item is created (review pass v4 §5.3).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Signed verification artifact</CardTitle>
          <CardDescription>
            One-time point-in-time attestation for the mega-plan closeout. Review sections A through
            E.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href="/docs/MEGA_PLAN_VERIFICATION_2026-04-13.md"
            className="text-blue-600 underline text-sm"
            target="_blank"
            rel="noreferrer"
          >
            View MEGA_PLAN_VERIFICATION_2026-04-13.md
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent spot-check runs</CardTitle>
              <CardDescription>
                Sampled SKUs per run: 15 during ramp (any workspace at fanout_rollout_percent &lt;
                100), 5 daily otherwise. Persistence rule prevents single-run drift_major from
                paging staff.
              </CardDescription>
            </div>
            <Button onClick={() => triggerMut.mutate()} disabled={triggerMut.isPending} size="sm">
              {triggerMut.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Triggering...
                </>
              ) : (
                <>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Run spot-check now
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <BlockList
            className="mt-3"
            items={runsQuery.data ?? []}
            itemKey={(row) => row.id}
            loading={runsQuery.isLoading}
            density="ops"
            ariaLabel="Recent spot-check runs"
            renderHeader={({ row }) => (
              <div className="min-w-0">
                <p className="text-sm font-medium">{new Date(row.started_at).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">
                  Finished: {row.finished_at ? new Date(row.finished_at).toLocaleString() : "—"}
                </p>
              </div>
            )}
            renderExceptionZone={({ row }) =>
              row.drift_major_count > 0 ? (
                <p className="text-xs font-medium text-red-600">
                  Major drift detected: {row.drift_major_count}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">No major drift detected.</p>
              )
            }
            renderBody={({ row }) => (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                <RunCountMetric label="SKUs" value={row.sampled_sku_count} />
                <RunCountMetric label="Agreed" value={row.drift_agreed_count} />
                <RunCountMetric label="Delayed" value={row.delayed_propagation_count} />
                <RunCountMetric label="Minor" value={row.drift_minor_count} />
                <RunCountMetric
                  label="Major"
                  value={row.drift_major_count}
                  danger={row.drift_major_count > 0}
                />
              </div>
            )}
            renderActions={({ row }) => (
              <Button variant="ghost" size="sm" onClick={() => setOpenRunId(row.id)}>
                View
              </Button>
            )}
            emptyState={
              <EmptyState
                title="No spot-check runs yet"
                description="Trigger one above or wait for the hourly cron."
              />
            }
          />
        </CardContent>
      </Card>

      <Dialog open={!!openRunId} onOpenChange={(o) => !o && setOpenRunId(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Spot-check artifact</DialogTitle>
            <DialogDescription>
              Markdown rendered from the run's per-SKU comparison table.
            </DialogDescription>
          </DialogHeader>
          {artifactQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading artifact...</p>
          ) : (
            <pre className="text-xs whitespace-pre-wrap font-mono">
              {artifactQuery.data?.artifact_md ?? "No artifact recorded for this run."}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunCountMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-mono ${danger ? "text-red-600 font-semibold" : ""}`}>{value}</p>
    </div>
  );
}
