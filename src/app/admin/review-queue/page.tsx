"use client";

import { Check, ChevronsUpDown, Pause, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  assignReviewItem,
  bulkAssign,
  bulkResolve,
  getReviewQueueItems,
  reopenReviewItem,
  resolveReviewItem,
  suppressReviewItem,
} from "@/actions/review-queue";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import { cn } from "@/lib/utils";

const SEVERITY_TABS = ["all", "critical", "high", "medium", "low"] as const;

function severityIntent(s: string) {
  if (s === "critical") return "danger" as const;
  if (s === "high") return "warning" as const;
  if (s === "medium") return "info" as const;
  return "neutral" as const;
}

function slaIndicator(slaDueAt: string | null) {
  if (!slaDueAt) return null;
  const now = Date.now();
  const due = new Date(slaDueAt).getTime();
  const hoursLeft = (due - now) / (1000 * 60 * 60);
  if (hoursLeft < 0) return { color: "text-red-600", label: "Overdue" };
  if (hoursLeft < 2) return { color: "text-yellow-600", label: "Approaching" };
  return { color: "text-green-600", label: "On track" };
}

export default function ReviewQueuePage() {
  const [tab, setTab] = useState<string>("all");
  const [filters, setFilters] = useState({
    category: "",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE as PageSize,
  });
  useListPaginationPreference("admin/review-queue", filters, setFilters);
  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const [assignInput, setAssignInput] = useState("");

  const queryFilters = {
    ...(tab !== "all" ? { severity: tab } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    status: "open",
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.reviewQueue.list(queryFilters),
    queryFn: () => getReviewQueueItems(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const resolveMut = useAppMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) => resolveReviewItem(id, notes),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const _assignMut = useAppMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => assignReviewItem(id, userId),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const suppressMut = useAppMutation({
    mutationFn: ({ id, hours }: { id: string; hours: number }) => suppressReviewItem(id, hours),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const reopenMut = useAppMutation({
    mutationFn: (id: string) => reopenReviewItem(id),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const bulkAssignMut = useAppMutation({
    mutationFn: (userId: string) => bulkAssign(Array.from(selectedKeys).map(String), userId),
    invalidateKeys: [queryKeys.reviewQueue.all],
    onSuccess: () => setSelectedKeys(new Set()),
  });

  const bulkResolveMut = useAppMutation({
    mutationFn: () => bulkResolve(Array.from(selectedKeys).map(String), "Bulk resolved"),
    invalidateKeys: [queryKeys.reviewQueue.all],
    onSuccess: () => setSelectedKeys(new Set()),
  });

  const items = data?.items ?? [];

  return (
    <PageShell
      title="Review Queue"
      description="Operational exceptions that require triage."
      maxWidth="full"
      toolbar={
        <PageToolbar>
          <Input
            placeholder="Filter by category..."
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, page: 1 }))}
            className="w-52"
          />
        </PageToolbar>
      }
      actions={<span className="text-muted-foreground text-sm">{data?.total ?? 0} items</span>}
    >
      <div className="flex gap-1 border-b overflow-x-auto">
        {SEVERITY_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setFilters((f) => ({ ...f, page: 1 }));
            }}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize whitespace-nowrap",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}

      <BlockList
        items={items}
        totalCount={data?.total}
        loading={isLoading}
        selectable
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
        density="ops"
        itemKey={(row) => row.id}
        ariaLabel="Review queue items"
        virtualizeThreshold={200}
        bulkActionRail={({
          selectedCount,
          clearSelection,
          allVisibleSelected,
          toggleSelectAllVisible,
        }) => (
          <div className="sticky top-0 z-10 rounded-md border bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{selectedCount} selected</span>
              <Input
                placeholder="User ID"
                value={assignInput}
                onChange={(e) => setAssignInput(e.target.value)}
                className="w-44 h-8"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulkAssignMut.mutate(assignInput)}
                disabled={!assignInput || bulkAssignMut.isPending}
              >
                Assign
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulkResolveMut.mutate()}
                disabled={bulkResolveMut.isPending}
              >
                Resolve All
              </Button>
              <Button size="sm" variant="outline" onClick={toggleSelectAllVisible}>
                {allVisibleSelected ? "Clear visible" : "Select visible"}
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Clear selection
              </Button>
            </div>
          </div>
        )}
        renderHeader={({ row, expanded, toggleExpanded }) => (
          <div className="min-w-0 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium truncate">{row.title}</p>
              <p className="text-xs text-muted-foreground">
                {row.category} · {new Date(row.created_at).toLocaleDateString()}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleExpanded();
              }}
              aria-label={expanded ? "Collapse item details" : "Expand item details"}
            >
              <ChevronsUpDown className="h-4 w-4" />
            </Button>
          </div>
        )}
        renderExceptionZone={({ row }) => {
          const sla = slaIndicator(row.sla_due_at);
          return (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge intent={severityIntent(row.severity)}>{row.severity}</StatusBadge>
              {sla && (
                <StatusBadge intent={sla.label === "Overdue" ? "danger" : "warning"}>
                  SLA: {sla.label}
                </StatusBadge>
              )}
              {row.occurrence_count > 1 && (
                <StatusBadge intent="info">{row.occurrence_count}x occurrences</StatusBadge>
              )}
            </div>
          );
        }}
        renderBody={({ row }) => (
          <div className="grid gap-2 text-sm">
            {row.description ? (
              <p className="text-muted-foreground line-clamp-2">{row.description}</p>
            ) : (
              <p className="text-muted-foreground">No description</p>
            )}
            {row.organizations?.name && (
              <p className="text-xs text-muted-foreground">Org: {row.organizations.name}</p>
            )}
          </div>
        )}
        renderExpanded={({ row, actionContext }) => (
          <div className="space-y-3 rounded-md border bg-muted/40 p-3">
            {row.metadata && (
              <pre className="text-xs bg-background p-2 rounded overflow-auto max-h-48">
                {JSON.stringify(row.metadata, null, 2)}
              </pre>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={actionContext.pendingActions.has("resolve")}
                onClick={() =>
                  actionContext.runAction("resolve", async () => {
                    await resolveMut.mutateAsync({ id: row.id, notes: "Resolved" });
                  })
                }
              >
                <Check className="h-3 w-3 mr-1" /> Resolve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionContext.pendingActions.has("snooze")}
                onClick={() =>
                  actionContext.runAction("snooze", async () => {
                    await suppressMut.mutateAsync({ id: row.id, hours: 4 });
                  })
                }
              >
                <Pause className="h-3 w-3 mr-1" /> Snooze 4h
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionContext.pendingActions.has("reopen")}
                onClick={() =>
                  actionContext.runAction("reopen", async () => {
                    await reopenMut.mutateAsync(row.id);
                  })
                }
              >
                <RotateCcw className="h-3 w-3 mr-1" /> Re-open
              </Button>
            </div>
          </div>
        )}
        emptyState={
          <EmptyState
            title="No review items"
            description="No open exceptions match the current filters."
          />
        }
      />

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </PageShell>
  );
}
