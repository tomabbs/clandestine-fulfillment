"use client";

import { Package, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getInboundShipments,
  type InboundFilters,
  type InboundShipmentWithOrg,
} from "@/actions/inbound";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import { ScrollableTabs, ScrollableTabsList } from "@/components/shared/scrollable-tabs";
import { StatusBadge, type StatusIntent } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TabsTrigger } from "@/components/ui/tabs";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreferenceSplit } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const STATUS_TABS = ["all", "expected", "arrived", "checking_in", "checked_in", "issue"] as const;

const STATUS_LABELS: Record<string, string> = {
  all: "All",
  expected: "Expected",
  arrived: "Arrived",
  checking_in: "Checking In",
  checked_in: "Checked In",
  issue: "Issue",
};

// Map status → semantic intent. Replaces the old monochrome bg-*-100 colors.
const STATUS_INTENT: Record<string, StatusIntent> = {
  expected: "info",
  arrived: "warning",
  checking_in: "warning",
  checked_in: "success",
  issue: "danger",
};

export default function AdminInboundPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [orgFilter, setOrgFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  useListPaginationPreferenceSplit("admin/inbound", page, pageSize, setPage, setPageSize);

  const filters: InboundFilters = {
    status: activeTab === "all" ? undefined : (activeTab as InboundFilters["status"]),
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    pageSize,
  };

  const { data, isLoading } = useAppQuery<{ data: InboundShipmentWithOrg[]; count: number }>({
    queryKey: queryKeys.inbound.list(filters as Record<string, unknown>),
    queryFn: () => getInboundShipments(filters),
    tier: CACHE_TIERS.REALTIME,
  });

  const allShipments = data?.data ?? [];
  // Local org-name filter (server query handles status/dates/page).
  const shipments = orgFilter
    ? allShipments.filter((s) => s.org_name?.toLowerCase().includes(orgFilter.toLowerCase()))
    : allShipments;
  const totalCount = data?.count ?? 0;

  return (
    <PageShell
      title="Inbound Shipments"
      description="Manage incoming shipments from labels and distributors."
      toolbar={
        <div className="space-y-4">
          {/* Status tabs — ScrollableTabs handles the scroll on narrow screens */}
          <ScrollableTabs value={activeTab} onValueChange={(v) => v && setActiveTab(v)}>
            <ScrollableTabsList variant="line">
              {STATUS_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {STATUS_LABELS[tab]}
                </TabsTrigger>
              ))}
            </ScrollableTabsList>
          </ScrollableTabs>

          {/* Filters */}
          <PageToolbar>
            <div className="flex-1 min-w-[200px] max-w-xs">
              <label htmlFor="inbound-search" className="text-sm font-medium mb-1 block">
                Search
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="inbound-search"
                  placeholder="Filter by org name..."
                  value={orgFilter}
                  onChange={(e) => setOrgFilter(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <div>
              <label htmlFor="inbound-date-from" className="text-sm font-medium mb-1 block">
                From
              </label>
              <Input
                id="inbound-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <label htmlFor="inbound-date-to" className="text-sm font-medium mb-1 block">
                To
              </label>
              <Input
                id="inbound-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          </PageToolbar>
        </div>
      }
    >
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={totalCount}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
      />

      <BlockList
        className="mt-3"
        items={shipments}
        totalCount={totalCount}
        itemKey={(row) => row.id}
        loading={isLoading}
        density="ops"
        ariaLabel="Inbound shipments"
        renderHeader={({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-sm">{row.tracking_number || "—"}</p>
            <p className="text-xs text-muted-foreground">
              {row.carrier || "Unknown carrier"} · {row.org_name || "Unassigned org"}
            </p>
          </div>
        )}
        renderExceptionZone={({ row }) => (
          <div className="flex items-center gap-2">
            <StatusBadge intent={STATUS_INTENT[row.status] ?? "neutral"}>
              {STATUS_LABELS[row.status] ?? row.status}
            </StatusBadge>
            <StatusBadge intent="info">{row.item_count} items</StatusBadge>
          </div>
        )}
        renderBody={({ row }) => (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Expected</p>
              <p>
                {row.expected_date
                  ? new Date(`${row.expected_date}T12:00:00`).toLocaleDateString()
                  : "—"}
              </p>
            </div>
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Submitted by
              </p>
              <p>{row.submitter_name || "—"}</p>
            </div>
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Shipment ID
              </p>
              <p className="font-mono text-xs">{row.id}</p>
            </div>
          </div>
        )}
        renderActions={({ row }) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() => router.push(`/admin/inbound/${row.id}`)}
          >
            Open
          </Button>
        )}
        emptyState={
          <EmptyState
            icon={Package}
            title="No inbound shipments"
            description="Shipments will appear here when they're created or imported."
          />
        }
      />

      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={totalCount}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
      />
    </PageShell>
  );
}
