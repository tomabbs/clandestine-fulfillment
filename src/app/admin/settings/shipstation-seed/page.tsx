"use client";

import { Loader2, PackageCheck, PackageX, PlayCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  listShipStationSeedRuns,
  type PreviewSeedResult,
  previewShipStationSeed,
  triggerShipStationSeed,
} from "@/actions/shipstation-seed";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

/**
 * Phase 3 — admin ShipStation v2 seed page.
 *
 * Operator workflow:
 *   1. Enter the workspace UUID + ShipStation v2 inventory_warehouse_id
 *      + inventory_location_id (currently typed manually — auto-discovery
 *      via `/v2/inventory_warehouses` is captured as a follow-up).
 *   2. Click "Preview" to run the seed task in dryRun mode and see the
 *      gate-cascade counts: candidates, bundle_excluded, blocked_*, seeded.
 *   3. If the counts look right, click "Run seed" to commit.
 *   4. Watch the "Recent runs" panel for status (the task writes to
 *      `channel_sync_log` with channel = 'shipstation_v2', sync_type =
 *      'seed_inventory').
 *
 * Idempotency: re-running the seed against the same workspace is safe —
 * the `external_sync_events` ledger uses `correlation_id =
 * "seed:{workspaceId}:{runId}"` and the v2 client uses `transaction_type:
 * "increment"`, so a second SAME-RUN_ID retry skips already-seeded SKUs.
 * A new run with a fresh run_id will INCREMENT all qualifying SKUs again
 * — operator must understand this before clicking "Run seed" twice.
 */

interface SeedFormState {
  workspaceId: string;
  inventoryWarehouseId: string;
  inventoryLocationId: string;
}

export default function ShipStationSeedPage() {
  const [form, setForm] = useState<SeedFormState>({
    workspaceId: "",
    inventoryWarehouseId: "",
    inventoryLocationId: "",
  });
  const [previewResult, setPreviewResult] = useState<PreviewSeedResult | null>(null);

  const previewMut = useAppMutation({
    mutationFn: previewShipStationSeed,
    onSuccess: (data) => setPreviewResult(data),
  });

  const triggerMut = useAppMutation({
    mutationFn: triggerShipStationSeed,
  });

  const formReady =
    form.workspaceId.trim().length > 0 &&
    form.inventoryWarehouseId.trim().length > 0 &&
    form.inventoryLocationId.trim().length > 0;

  const recentRunsQuery = useAppQuery({
    queryKey: ["admin", "shipstation-seed-runs", form.workspaceId],
    queryFn: () => listShipStationSeedRuns({ workspaceId: form.workspaceId }),
    enabled: form.workspaceId.length === 36,
    tier: CACHE_TIERS.SESSION,
  });

  const previewOutput = previewResult?.output;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">ShipStation v2 inventory seed</h1>
        <p className="text-sm text-muted-foreground">
          Phase 3: enable inventory tracking and write initial quantities for every
          fulfillment-client SKU that passes the seed gate. Bundles, distro items, and blocked
          Bandcamp mappings are excluded automatically. Run the preview first, then commit.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run scope</CardTitle>
          <CardDescription>
            One workspace at a time. Warehouse / location IDs come from your ShipStation v2 account
            (visit <code>/v2/inventory_warehouses</code> in the admin API to enumerate).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="workspaceId">Workspace UUID</Label>
              <Input
                id="workspaceId"
                value={form.workspaceId}
                onChange={(e) => setForm((f) => ({ ...f, workspaceId: e.target.value }))}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inventoryWarehouseId">Inventory warehouse ID</Label>
              <Input
                id="inventoryWarehouseId"
                value={form.inventoryWarehouseId}
                onChange={(e) => setForm((f) => ({ ...f, inventoryWarehouseId: e.target.value }))}
                placeholder="se-214575"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inventoryLocationId">Inventory location ID</Label>
              <Input
                id="inventoryLocationId"
                value={form.inventoryLocationId}
                onChange={(e) => setForm((f) => ({ ...f, inventoryLocationId: e.target.value }))}
                placeholder="se-3213662"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              disabled={!formReady || previewMut.isPending}
              onClick={() => previewMut.mutate(form)}
            >
              {previewMut.isPending ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Previewing...
                </>
              ) : (
                <>
                  <PlayCircle className="h-3 w-3 mr-1" /> Preview (dry run)
                </>
              )}
            </Button>

            <Button
              disabled={!formReady || triggerMut.isPending}
              onClick={() => triggerMut.mutate(form)}
            >
              {triggerMut.isPending ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Enqueuing...
                </>
              ) : (
                <>
                  <PackageCheck className="h-3 w-3 mr-1" /> Run seed
                </>
              )}
            </Button>
          </div>

          {previewMut.error && (
            <p className="text-sm text-destructive">
              Preview error:{" "}
              {previewMut.error instanceof Error ? previewMut.error.message : "unknown"}
            </p>
          )}
          {triggerMut.error && (
            <p className="text-sm text-destructive">
              Trigger error:{" "}
              {triggerMut.error instanceof Error ? triggerMut.error.message : "unknown"}
            </p>
          )}
          {triggerMut.data && (
            <p className="text-sm text-muted-foreground">
              Run enqueued — task run id <code>{triggerMut.data.taskRunId}</code>. Watch the "Recent
              runs" panel below.
            </p>
          )}
        </CardContent>
      </Card>

      {previewResult && (
        <Card>
          <CardHeader>
            <CardTitle>Preview result</CardTitle>
            <CardDescription>
              {previewResult.status === "completed"
                ? "Dry-run complete — counts below would be applied if you clicked Run."
                : `Dry-run still running (task ${previewResult.taskRunId}); refresh in a moment.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {previewOutput ? (
              <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <Stat label="Candidates" value={previewOutput.candidates} />
                <Stat label="Would seed" value={previewOutput.seeded} accent="positive" />
                <Stat label="Bundles excluded" value={previewOutput.bundle_excluded} />
                <Stat label="Blocked by push_mode" value={previewOutput.blocked_by_push_mode} />
                <Stat
                  label="Blocked: zero origin sum"
                  value={previewOutput.blocked_zero_origin_sum}
                />
                <Stat
                  label="Blocked: zero warehouse stock"
                  value={previewOutput.blocked_zero_warehouse_stock}
                />
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Pending — task run id {previewResult.taskRunId}.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            Pulled from <code>channel_sync_log</code> filtered to{" "}
            <code>channel = 'shipstation_v2'</code> + <code>sync_type = 'seed_inventory'</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BlockList
            className="mt-3"
            items={recentRunsQuery.data ?? []}
            itemKey={(row) => row.id}
            loading={recentRunsQuery.isLoading}
            density="ops"
            ariaLabel="Recent ShipStation seed runs"
            renderHeader={({ row }) => (
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {row.started_at ? new Date(row.started_at).toLocaleString() : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Run ID: {(row.metadata?.run_id as string | undefined) ?? "—"}
                </p>
              </div>
            )}
            renderExceptionZone={({ row }) => <RunStatusBadge status={row.status} />}
            renderBody={({ row }) => (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <SeedRunMetric label="Seeded" value={row.items_processed ?? 0} />
                <SeedRunMetric
                  label="Errors"
                  value={row.items_failed ?? 0}
                  danger={(row.items_failed ?? 0) > 0}
                />
              </div>
            )}
            emptyState={
              <EmptyState
                title="No previous runs"
                description="Select a workspace and run preview or seed to populate this list."
              />
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SeedRunMetric({
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
      <p className={`text-sm font-mono ${danger ? "text-destructive font-semibold" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "positive" | "negative";
}) {
  const tone =
    accent === "positive"
      ? "text-green-600"
      : accent === "negative"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="border rounded-md p-3 space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <Badge variant="secondary" className="gap-1">
        <PackageCheck className="h-3 w-3" /> {status}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="gap-1 text-destructive">
        <PackageX className="h-3 w-3" /> {status}
      </Badge>
    );
  }
  if (status === "partial") {
    return (
      <Badge variant="outline" className="gap-1">
        <ShieldAlert className="h-3 w-3" /> {status}
      </Badge>
    );
  }
  return <Badge variant="secondary">{status}</Badge>;
}
