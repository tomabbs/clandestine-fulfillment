"use client";

import { Package, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getInboundShipments,
  type InboundFilters,
  type InboundShipmentWithOrg,
} from "@/actions/inbound";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import {
  ResponsiveTable,
  type ResponsiveTableColumn,
} from "@/components/shared/responsive-table";
import { ScrollableTabs, ScrollableTabsList } from "@/components/shared/scrollable-tabs";
import { StatusBadge, type StatusIntent } from "@/components/shared/status-badge";
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
    ? allShipments.filter((s) =>
        s.org_name?.toLowerCase().includes(orgFilter.toLowerCase()),
      )
    : allShipments;
  const totalCount = data?.count ?? 0;

  const columns: Array<ResponsiveTableColumn<InboundShipmentWithOrg>> = [
    {
      key: "tracking_number",
      label: "Tracking Number",
      primary: true,
      mono: true,
      render: (row) => row.tracking_number || "—",
    },
    {
      key: "carrier",
      label: "Carrier",
      render: (row) => row.carrier || "—",
    },
    {
      key: "org_name",
      label: "Organization",
      render: (row) => row.org_name || "—",
    },
    {
      key: "expected_date",
      label: "Expected Date",
      hideBelow: "md",
      render: (row) =>
        row.expected_date
          ? new Date(`${row.expected_date}T12:00:00`).toLocaleDateString()
          : "—",
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusBadge intent={STATUS_INTENT[row.status] ?? "neutral"}>
          {STATUS_LABELS[row.status] ?? row.status}
        </StatusBadge>
      ),
    },
    {
      key: "item_count",
      label: "Items",
      align: "right",
      hideBelow: "md",
      render: (row) => row.item_count,
    },
    {
      key: "submitter_name",
      label: "Submitted By",
      hideBelow: "lg",
      render: (row) => row.submitter_name || "—",
    },
  ];

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

      <ResponsiveTable
        rows={shipments}
        columns={columns}
        getRowId={(row) => row.id}
        rowExpand={(row) => (
          <button
            type="button"
            className="text-sm text-primary hover:underline"
            onClick={() => router.push(`/admin/inbound/${row.id}`)}
          >
            Open shipment details →
          </button>
        )}
        loading={isLoading}
        loadingRowCount={5}
        density="ops"
        ariaLabel="Inbound shipments"
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
