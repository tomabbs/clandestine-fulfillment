"use client";

import { Check, Loader2, Pause, RotateCcw } from "lucide-react";
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
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const SEVERITY_TABS = ["all", "critical", "high", "medium", "low"] as const;

function severityBadgeVariant(s: string) {
  if (s === "critical") return "destructive" as const;
  if (s === "high") return "default" as const;
  return "secondary" as const;
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

type QueueItem = Awaited<ReturnType<typeof getReviewQueueItems>>["items"][number];

export default function ReviewQueuePage() {
  const [tab, setTab] = useState<string>("all");
  const [filters, setFilters] = useState({
    category: "",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE as PageSize,
  });
  useListPaginationPreference("admin/review-queue", filters, setFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
    mutationFn: (userId: string) => bulkAssign(Array.from(selected), userId),
    invalidateKeys: [queryKeys.reviewQueue.all],
    onSuccess: () => setSelected(new Set()),
  });

  const bulkResolveMut = useAppMutation({
    mutationFn: () => bulkResolve(Array.from(selected), "Bulk resolved"),
    invalidateKeys: [queryKeys.reviewQueue.all],
    onSuccess: () => setSelected(new Set()),
  });

  const items = data?.items ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Review Queue</h1>
        <span className="text-muted-foreground text-sm">{data?.total ?? 0} items</span>
      </div>

      {/* Severity tabs */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {SEVERITY_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setFilters((f) => ({ ...f, page: 1 }));
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Filters + bulk actions */}
      <div className="flex flex-wrap gap-3 items-center min-w-0">
        <Input
          placeholder="Filter by category..."
          value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, page: 1 }))}
          className="w-48"
        />
        {selected.size > 0 && (
          <div className="flex gap-2 items-center ml-auto">
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            <Input
              placeholder="User ID"
              value={assignInput}
              onChange={(e) => setAssignInput(e.target.value)}
              className="w-40 h-8"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkAssignMut.mutate(assignInput)}
              disabled={!assignInput}
            >
              Assign
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulkResolveMut.mutate()}>
              Resolve All
            </Button>
          </div>
        )}
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

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
                  }
                  checked={selected.size === items.length && items.length > 0}
                />
              </TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item: QueueItem) => {
              const sla = slaIndicator(item.sla_due_at);
              return (
                <>
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedId((p) => (p === item.id ? null : item.id))}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(item.id) : next.delete(item.id);
                          setSelected(next);
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-medium max-w-xs truncate">{item.title}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{item.category}</TableCell>
                    <TableCell>
                      <Badge variant={severityBadgeVariant(item.severity)}>{item.severity}</Badge>
                    </TableCell>
                    <TableCell>
                      {sla ? <span className={`text-xs ${sla.color}`}>{sla.label}</span> : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.occurrence_count > 1 && (
                        <Badge variant="outline">{item.occurrence_count}x</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(item.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                  {expandedId === item.id && (
                    <TableRow key={`${item.id}-detail`}>
                      <TableCell colSpan={7} className="bg-muted/30 p-4">
                        <div className="space-y-3">
                          {item.description && <p className="text-sm">{item.description}</p>}
                          {item.metadata && (
                            <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-40">
                              {JSON.stringify(item.metadata, null, 2)}
                            </pre>
                          )}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => resolveMut.mutate({ id: item.id, notes: "Resolved" })}
                            >
                              <Check className="h-3 w-3 mr-1" /> Resolve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => suppressMut.mutate({ id: item.id, hours: 4 })}
                            >
                              <Pause className="h-3 w-3 mr-1" /> Snooze 4h
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => reopenMut.mutate(item.id)}
                            >
                              <RotateCcw className="h-3 w-3 mr-1" /> Re-open
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      )}

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </div>
  );
}
