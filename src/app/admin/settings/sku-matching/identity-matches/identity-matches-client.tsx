"use client";

import { ArrowRight, Clock, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  type GetIdentityMatchDetailResult,
  getIdentityMatchDetail,
  type IdentityMatchListRow,
  type ListIdentityMatchesResult,
  listIdentityMatches,
} from "@/actions/sku-identity-matches";
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

// Phase 6 Slice 6.E — client surface for
// /admin/settings/sku-matching/identity-matches. Consumes the list +
// detail Server Actions from Slice 6.E and offers filter controls,
// client-side pagination, a summary of outcome-state counts, and a
// detail drawer that renders the associated `sku_outcome_transitions`
// history as a reverse-chronological timeline.

type OutcomeStateFilter =
  | "all"
  | "auto_database_identity_match"
  | "auto_shadow_identity_match"
  | "auto_holdout_for_evidence"
  | "auto_reject_non_match"
  | "auto_skip_non_operational"
  | "fetch_incomplete_holdout"
  | "client_stock_exception";

type ResolutionStateFilter =
  | "all"
  | "resolved_to_variant"
  | "remote_only_unresolved"
  | "non_operational"
  | "rejected_non_match"
  | "unresolved";

type ListingStateFilter =
  | "all"
  | "sellable_product"
  | "remote_only"
  | "non_operational"
  | "placeholder_sku"
  | "fetch_incomplete"
  | "duplicate_remote"
  | "archived_remote";

type PlatformFilter = "all" | "shopify" | "woocommerce" | "squarespace";
type ActiveFilter = "all" | "active" | "inactive";

interface Filters {
  outcomeState: OutcomeStateFilter;
  resolutionState: ResolutionStateFilter;
  listingState: ListingStateFilter;
  platform: PlatformFilter;
  active: ActiveFilter;
  evaluatedAfter: string;
  evaluatedBefore: string;
}

const DEFAULT_FILTERS: Filters = {
  outcomeState: "all",
  resolutionState: "all",
  listingState: "all",
  platform: "all",
  active: "active",
  evaluatedAfter: "",
  evaluatedBefore: "",
};

const PAGE_SIZE = 50;

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function IdentityMatchesClient({ bootstrap }: { bootstrap: ListIdentityMatchesResult }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [offset, setOffset] = useState(0);
  const [openMatchId, setOpenMatchId] = useState<string | null>(null);

  const queryKey = useMemo(
    () =>
      [
        "admin",
        "sku-identity-matches",
        "list",
        filters.outcomeState,
        filters.resolutionState,
        filters.listingState,
        filters.platform,
        filters.active,
        filters.evaluatedAfter,
        filters.evaluatedBefore,
        offset,
      ] as const,
    [filters, offset],
  );

  const listQuery = useAppQuery<ListIdentityMatchesResult, Error>({
    queryKey: Array.from(queryKey),
    queryFn: () =>
      listIdentityMatches({
        outcomeState: filters.outcomeState === "all" ? undefined : filters.outcomeState,
        canonicalResolutionState:
          filters.resolutionState === "all" ? undefined : filters.resolutionState,
        remoteListingState: filters.listingState === "all" ? undefined : filters.listingState,
        platform: filters.platform === "all" ? undefined : filters.platform,
        isActive: filters.active === "all" ? undefined : filters.active === "active",
        evaluatedAfter: filters.evaluatedAfter
          ? new Date(filters.evaluatedAfter).toISOString()
          : undefined,
        evaluatedBefore: filters.evaluatedBefore
          ? new Date(filters.evaluatedBefore).toISOString()
          : undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: bootstrap,
    tier: CACHE_TIERS.SESSION,
  });

  const detailQuery = useAppQuery<GetIdentityMatchDetailResult, Error>({
    queryKey: ["admin", "sku-identity-matches", "detail", openMatchId ?? ""],
    queryFn: () =>
      getIdentityMatchDetail({ identityMatchId: openMatchId as string, transitionsLimit: 100 }),
    enabled: !!openMatchId,
    tier: CACHE_TIERS.SESSION,
  });

  const rows = listQuery.data?.rows ?? bootstrap.rows;
  const total = listQuery.data?.total ?? bootstrap.total;
  const grouped = listQuery.data?.groupedByOutcomeState ?? bootstrap.groupedByOutcomeState;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  const updateFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setOffset(0);
  }, []);

  return (
    <div className="max-w-7xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Autonomous SKU matching — identity matches
        </h1>
        <p className="text-sm text-muted-foreground">
          <code className="rounded bg-muted px-1 font-mono text-xs">
            client_store_product_identity_matches
          </code>{" "}
          captures every identity decision the autonomous matcher makes against a remote listing.
          Rows here NEVER participate in inventory fan-out; promotion to a live alias goes through{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">
            promote_identity_match_to_alias
          </code>
          . Use the transition history drawer to replay why a row landed in its current state.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>
            All filters apply server-side. The row counts on the right reflect the current page —
            workspace-wide totals are shown in <em>Total</em>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <FilterSelect
              label="Outcome state"
              value={filters.outcomeState}
              onChange={(v) => updateFilter("outcomeState", v as OutcomeStateFilter)}
              options={[
                { value: "all", label: "All outcomes" },
                { value: "auto_database_identity_match", label: "Database identity" },
                { value: "auto_shadow_identity_match", label: "Shadow identity" },
                { value: "auto_holdout_for_evidence", label: "Holdout (evidence)" },
                { value: "auto_reject_non_match", label: "Rejected — non-match" },
                { value: "auto_skip_non_operational", label: "Skip — non-operational" },
                { value: "fetch_incomplete_holdout", label: "Fetch-incomplete holdout" },
                { value: "client_stock_exception", label: "Client stock exception" },
              ]}
            />
            <FilterSelect
              label="Canonical resolution"
              value={filters.resolutionState}
              onChange={(v) => updateFilter("resolutionState", v as ResolutionStateFilter)}
              options={[
                { value: "all", label: "All" },
                { value: "resolved_to_variant", label: "Resolved to variant" },
                { value: "remote_only_unresolved", label: "Remote-only (unresolved)" },
                { value: "non_operational", label: "Non-operational" },
                { value: "rejected_non_match", label: "Rejected (non-match)" },
                { value: "unresolved", label: "Unresolved" },
              ]}
            />
            <FilterSelect
              label="Remote listing state"
              value={filters.listingState}
              onChange={(v) => updateFilter("listingState", v as ListingStateFilter)}
              options={[
                { value: "all", label: "All" },
                { value: "sellable_product", label: "Sellable" },
                { value: "remote_only", label: "Remote-only" },
                { value: "non_operational", label: "Non-operational" },
                { value: "placeholder_sku", label: "Placeholder SKU" },
                { value: "fetch_incomplete", label: "Fetch-incomplete" },
                { value: "duplicate_remote", label: "Duplicate remote" },
                { value: "archived_remote", label: "Archived remote" },
              ]}
            />
            <FilterSelect
              label="Platform"
              value={filters.platform}
              onChange={(v) => updateFilter("platform", v as PlatformFilter)}
              options={[
                { value: "all", label: "All platforms" },
                { value: "shopify", label: "Shopify" },
                { value: "woocommerce", label: "WooCommerce" },
                { value: "squarespace", label: "Squarespace" },
              ]}
            />
            <FilterSelect
              label="Active state"
              value={filters.active}
              onChange={(v) => updateFilter("active", v as ActiveFilter)}
              options={[
                { value: "active", label: "Active only" },
                { value: "inactive", label: "Inactive only" },
                { value: "all", label: "All" },
              ]}
            />
            <FilterDate
              label="Evaluated after"
              value={filters.evaluatedAfter}
              onChange={(v) => updateFilter("evaluatedAfter", v)}
            />
            <FilterDate
              label="Evaluated before"
              value={filters.evaluatedBefore}
              onChange={(v) => updateFilter("evaluatedBefore", v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Identity matches</CardTitle>
              <CardDescription>
                {total > 0
                  ? `Showing ${pageStart}–${pageEnd} of ${total} rows.`
                  : "No rows match the current filters."}
              </CardDescription>
            </div>
            {listQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          {Object.keys(grouped).length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {Object.entries(grouped).map(([state, count]) => (
                <Badge key={state} variant="outline" className="font-mono text-[10px]">
                  {state}: {count}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Last evaluated</th>
                  <th className="py-2 pr-4 font-medium">Platform</th>
                  <th className="py-2 pr-4 font-medium">Outcome</th>
                  <th className="py-2 pr-4 font-medium">Canonical</th>
                  <th className="py-2 pr-4 font-medium">Variant</th>
                  <th className="py-2 pr-4 font-medium">Remote SKU</th>
                  <th className="py-2 pr-4 font-medium">Evaluations</th>
                  <th className="py-2 pr-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-muted-foreground">
                      No rows match the current filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => <IdentityRow key={row.id} row={row} onView={setOpenMatchId} />)
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
          Failed to load identity matches: {listQuery.error.message}
        </div>
      ) : null}

      <Dialog open={!!openMatchId} onOpenChange={(o) => !o && setOpenMatchId(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Identity match detail</DialogTitle>
            <DialogDescription>
              Full row snapshot plus the {`\u2264\xA0`}100 most recent transitions from{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">
                sku_outcome_transitions
              </code>
              .
            </DialogDescription>
          </DialogHeader>
          <MatchDetailBody query={detailQuery} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IdentityRow({ row, onView }: { row: IdentityMatchListRow; onView: (id: string) => void }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="py-2 pr-4 font-mono text-xs">{formatUtcDateTime(row.last_evaluated_at)}</td>
      <td className="py-2 pr-4 text-xs">{row.platform}</td>
      <td className="py-2 pr-4">
        <Badge variant="secondary" className="font-mono text-[10px]">
          {row.outcome_state}
        </Badge>
      </td>
      <td className="py-2 pr-4 text-xs">{row.canonical_resolution_state}</td>
      <td className="py-2 pr-4 font-mono text-[11px]">
        {row.variant_id ? (
          row.variant_id.slice(0, 8)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2 pr-4 font-mono text-[11px]">
        {row.remote_sku ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2 pr-4 font-mono text-xs">{row.evaluation_count}</td>
      <td className="py-2 pr-4">
        <Button variant="ghost" size="sm" onClick={() => onView(row.id)}>
          View
        </Button>
      </td>
    </tr>
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

function MatchDetailBody({
  query,
}: {
  query: { isLoading: boolean; data?: GetIdentityMatchDetailResult; error: Error | null };
}) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading identity match...
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load match detail: {query.error.message}
      </div>
    );
  }

  if (!query.data) return null;

  const { match, transitions, transitionsTotal } = query.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <DetailMetric label="State version" value={match.state_version.toString()} />
        <DetailMetric label="Evaluations" value={match.evaluation_count.toString()} />
        <DetailMetric
          label="Warehouse stock"
          value={match.warehouse_stock_at_match?.toString() ?? "—"}
        />
        <DetailMetric label="Remote stock" value={match.remote_stock_at_match?.toString() ?? "—"} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DetailField label="Outcome state" value={match.outcome_state} mono />
        <DetailField label="Canonical resolution" value={match.canonical_resolution_state} mono />
        <DetailField label="Remote listing state" value={match.remote_listing_state ?? "—"} mono />
        <DetailField label="Match method" value={match.match_method} mono />
        <DetailField label="Match confidence" value={match.match_confidence} mono />
        <DetailField label="Active" value={match.is_active ? "active" : "inactive"} mono />
        <DetailField label="Variant ID" value={match.variant_id ?? "—"} mono />
        <DetailField label="Connection ID" value={match.connection_id} mono />
        <DetailField label="Remote product" value={match.remote_product_id ?? "—"} mono />
        <DetailField label="Remote variant" value={match.remote_variant_id ?? "—"} mono />
        <DetailField label="Remote SKU" value={match.remote_sku ?? "—"} mono />
        <DetailField label="Evidence hash" value={match.evidence_hash} mono />
      </div>

      <details className="rounded-md border bg-muted/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Evidence snapshot
        </summary>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-[10px] font-mono">
          {JSON.stringify(match.evidence_snapshot, null, 2)}
        </pre>
      </details>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">
            Transition history ({transitions.length} shown / {transitionsTotal} total)
          </h3>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> newest first
          </div>
        </div>
        {transitions.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            No transitions recorded for this identity row yet.
          </div>
        ) : (
          <ol className="relative space-y-3 border-l pl-4">
            {transitions.map((t) => (
              <li key={t.id} className="relative">
                <span className="absolute -left-[21px] top-2 h-3 w-3 rounded-full border-2 border-background bg-primary" />
                <div className="rounded-md border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {t.from_state ?? "initial"}
                    </Badge>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {t.to_state}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {t.trigger}
                    </Badge>
                    <code className="rounded bg-muted px-1 font-mono text-[10px]">
                      {t.reason_code}
                    </code>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {formatUtcDateTime(t.triggered_at)}
                    </span>
                  </div>
                  {t.triggered_by ? (
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      triggered by: {t.triggered_by}
                    </p>
                  ) : null}
                  {t.alias_id ? (
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      alias: {t.alias_id}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "break-all font-mono text-xs" : "text-sm"}>{value}</p>
    </div>
  );
}
