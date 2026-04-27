"use client";

import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  type AutonomousRunListRow,
  type GetAutonomousRunDetailResult,
  getAutonomousRunDetail,
  type ListAutonomousRunsResult,
  listAutonomousRuns,
} from "@/actions/sku-autonomous-runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// Phase 6 Slice 6.B — client surface for /admin/settings/sku-matching/autonomous-runs.
// Consumes the list + detail Server Actions from Slice 6.A and offers filter
// controls, client-side pagination, and a detail drawer that renders the
// associated `sku_autonomous_decisions` rows.

type StatusFilter = "all" | "running" | "completed" | "failed" | "cancelled";
type TriggerSourceFilter =
  | "all"
  | "scheduled_periodic"
  | "connection_added"
  | "manual_admin"
  | "evidence_change_trigger"
  | "stock_change_trigger";
type DryRunFilter = "all" | "live" | "dry_run";

interface Filters {
  status: StatusFilter;
  trigger: TriggerSourceFilter;
  dryRun: DryRunFilter;
  startedAfter: string;
  startedBefore: string;
}

const DEFAULT_FILTERS: Filters = {
  status: "all",
  trigger: "all",
  dryRun: "all",
  startedAfter: "",
  startedBefore: "",
};

const PAGE_SIZE = 25;

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function AutonomousRunsClient({ bootstrap }: { bootstrap: ListAutonomousRunsResult }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [offset, setOffset] = useState(0);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const queryKey = useMemo(
    () =>
      [
        "admin",
        "sku-autonomous-runs",
        "list",
        filters.status,
        filters.trigger,
        filters.dryRun,
        filters.startedAfter,
        filters.startedBefore,
        offset,
      ] as const,
    [filters, offset],
  );

  const listQuery = useAppQuery<ListAutonomousRunsResult, Error>({
    queryKey: Array.from(queryKey),
    queryFn: () =>
      listAutonomousRuns({
        status: filters.status === "all" ? undefined : filters.status,
        triggerSource: filters.trigger === "all" ? undefined : filters.trigger,
        dryRun: filters.dryRun === "all" ? undefined : filters.dryRun === "dry_run",
        startedAfter: filters.startedAfter
          ? new Date(filters.startedAfter).toISOString()
          : undefined,
        startedBefore: filters.startedBefore
          ? new Date(filters.startedBefore).toISOString()
          : undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: bootstrap,
    tier: CACHE_TIERS.REALTIME,
  });

  const detailQuery = useAppQuery<GetAutonomousRunDetailResult, Error>({
    queryKey: ["admin", "sku-autonomous-runs", "detail", openRunId ?? ""],
    queryFn: () => getAutonomousRunDetail({ runId: openRunId as string, decisionsLimit: 100 }),
    enabled: !!openRunId,
    tier: CACHE_TIERS.SESSION,
  });

  const rows = listQuery.data?.rows ?? bootstrap.rows;
  const total = listQuery.data?.total ?? bootstrap.total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  const updateFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setOffset(0);
  }, []);

  return (
    <div className="max-w-7xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Autonomous SKU matching — runs</h1>
        <p className="text-sm text-muted-foreground">
          Every autonomous match pass writes a{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">sku_autonomous_runs</code> row
          with per-variant{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">sku_autonomous_decisions</code>.
          Filter by trigger source, status, and whether the run was a dry-run shadow. Entries are
          read-only; cancellation + flag flips live in separate admin surfaces.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>
            All filters apply server-side; results refresh when any value changes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
            <FilterSelect
              label="Status"
              value={filters.status}
              onChange={(v) => updateFilter("status", v as StatusFilter)}
              options={[
                { value: "all", label: "All statuses" },
                { value: "running", label: "Running" },
                { value: "completed", label: "Completed" },
                { value: "failed", label: "Failed" },
                { value: "cancelled", label: "Cancelled" },
              ]}
            />
            <FilterSelect
              label="Trigger source"
              value={filters.trigger}
              onChange={(v) => updateFilter("trigger", v as TriggerSourceFilter)}
              options={[
                { value: "all", label: "All triggers" },
                { value: "scheduled_periodic", label: "Scheduled" },
                { value: "connection_added", label: "Connection added" },
                { value: "manual_admin", label: "Manual admin" },
                { value: "evidence_change_trigger", label: "Evidence change" },
                { value: "stock_change_trigger", label: "Stock change" },
              ]}
            />
            <FilterSelect
              label="Dry-run"
              value={filters.dryRun}
              onChange={(v) => updateFilter("dryRun", v as DryRunFilter)}
              options={[
                { value: "all", label: "All runs" },
                { value: "live", label: "Live only" },
                { value: "dry_run", label: "Dry-run only" },
              ]}
            />
            <FilterDate
              label="Started after"
              value={filters.startedAfter}
              onChange={(v) => updateFilter("startedAfter", v)}
            />
            <FilterDate
              label="Started before"
              value={filters.startedBefore}
              onChange={(v) => updateFilter("startedBefore", v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>
                {total > 0
                  ? `Showing ${pageStart}–${pageEnd} of ${total} runs.`
                  : "No runs match the current filters."}
              </CardDescription>
            </div>
            {listQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Started</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Trigger</th>
                  <th className="py-2 pr-4 font-medium">Dry-run</th>
                  <th className="py-2 pr-4 font-medium">Variants</th>
                  <th className="py-2 pr-4 font-medium">Errors</th>
                  <th className="py-2 pr-4 font-medium">Duration</th>
                  <th className="py-2 pr-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-muted-foreground">
                      No runs match the current filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">
                        {formatUtcDateTime(row.started_at)}
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-2 pr-4 text-xs">{row.trigger_source}</td>
                      <td className="py-2 pr-4 text-xs">
                        {row.dry_run ? (
                          <Badge variant="outline">Dry-run</Badge>
                        ) : (
                          <Badge variant="secondary">Live</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{row.variants_evaluated}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {row.error_count > 0 ? (
                          <span className="font-semibold text-destructive">{row.error_count}</span>
                        ) : (
                          row.error_count
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {row.total_duration_ms != null
                          ? `${(row.total_duration_ms / 1000).toFixed(1)}s`
                          : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <Button variant="ghost" size="sm" onClick={() => setOpenRunId(row.id)}>
                          View
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {total > 0 ? `Page ${Math.floor(offset / PAGE_SIZE) + 1}` : "—"}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || listQuery.isFetching}
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total || listQuery.isFetching}
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {listQuery.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load runs: {listQuery.error.message}
        </div>
      ) : null}

      <Dialog open={!!openRunId} onOpenChange={(o) => !o && setOpenRunId(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Run detail</DialogTitle>
            <DialogDescription>
              Autonomous decisions recorded for this run (capped at 100 rows — use the variant
              detail drill-down for full history).
            </DialogDescription>
          </DialogHeader>
          <RunDetailBody query={detailQuery} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: AutonomousRunListRow["status"] }) {
  if (status === "completed") {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Completed
      </Badge>
    );
  }
  if (status === "running") {
    return (
      <Badge variant="outline" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Running
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <XCircle className="h-3 w-3" /> Cancelled
    </Badge>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FilterDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function RunDetailBody({
  query,
}: {
  query: { isLoading: boolean; data?: GetAutonomousRunDetailResult; error: Error | null };
}) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading decisions...
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load run detail: {query.error.message}
      </div>
    );
  }

  if (!query.data) {
    return null;
  }

  const { run, decisions, decisionsTotal } = query.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <RunMetric label="Variants" value={run.variants_evaluated} />
        <RunMetric label="Held for evidence" value={run.candidates_held_for_evidence} />
        <RunMetric label="No match" value={run.candidates_with_no_match} />
        <RunMetric label="Disqualified" value={run.candidates_with_disqualifiers} />
      </div>

      {run.error_count > 0 ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {run.error_count} error(s) during this run. See the error_log JSON below for details.
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">
            Decisions ({decisions.length} shown / {decisionsTotal} total)
          </h3>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatUtcDateTime(run.started_at)}
          </div>
        </div>

        {decisions.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            No decisions recorded for this run.
          </div>
        ) : (
          <div className="space-y-2">
            {decisions.map((d) => (
              <div key={d.id} className="rounded-md border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {d.outcome_state}
                    </Badge>
                    {d.previous_outcome_state && d.outcome_changed ? (
                      <span className="text-xs text-muted-foreground">
                        was {d.previous_outcome_state}
                      </span>
                    ) : null}
                    {d.match_confidence ? (
                      <Badge variant="outline" className="text-[10px]">
                        {d.match_confidence}
                      </Badge>
                    ) : null}
                    {d.reason_code ? (
                      <code className="rounded bg-muted px-1 font-mono text-[10px]">
                        {d.reason_code}
                      </code>
                    ) : null}
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatUtcDateTime(d.decided_at)}
                  </span>
                </div>
                {d.variant_id ? (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    variant: {d.variant_id}
                  </p>
                ) : null}
                {d.disqualifiers.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Disqualifiers ({d.disqualifiers.length})
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted/30 p-2 text-[10px] font-mono">
                      {JSON.stringify(d.disqualifiers, null, 2)}
                    </pre>
                  </details>
                ) : null}
                {d.top_candidates.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Top candidates ({d.top_candidates.length})
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted/30 p-2 text-[10px] font-mono">
                      {JSON.stringify(d.top_candidates, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}
