"use client";

import { Package, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getInboundShipments,
  type InboundFilters,
  type InboundShipmentWithOrg,
} from "@/actions/inbound";
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
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

const STATUS_COLORS: Record<string, string> = {
  expected: "bg-blue-100 text-blue-800",
  arrived: "bg-yellow-100 text-yellow-800",
  checking_in: "bg-orange-100 text-orange-800",
  checked_in: "bg-green-100 text-green-800",
  issue: "bg-red-100 text-red-800",
};

export default function AdminInboundPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [orgFilter, setOrgFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

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

  const shipments = data?.data ?? [];
  const totalCount = data?.count ?? 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbound Shipments</h1>
          <p className="text-muted-foreground mt-1">
            Manage incoming shipments from labels and distributors.
          </p>
        </div>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 border-b">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              setActiveTab(tab);
              setPage(1);
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {STATUS_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-end">
        <div className="flex-1 max-w-xs">
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
      </div>

      {/* Table */}
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
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3 font-medium">Tracking Number</th>
              <th className="text-left p-3 font-medium">Carrier</th>
              <th className="text-left p-3 font-medium">Organization</th>
              <th className="text-left p-3 font-medium">Expected Date</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Items</th>
              <th className="text-left p-3 font-medium">Submitted By</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              ["s1", "s2", "s3", "s4", "s5"].map((rowId) => (
                <tr key={rowId} className="border-b">
                  {["a", "b", "c", "d", "e", "f", "g"].map((colId) => (
                    <td key={`${rowId}-${colId}`} className="p-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : shipments.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-12 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No inbound shipments found.
                </td>
              </tr>
            ) : (
              shipments
                .filter((s) =>
                  orgFilter ? s.org_name?.toLowerCase().includes(orgFilter.toLowerCase()) : true,
                )
                .map((shipment) => (
                  <tr
                    key={shipment.id}
                    className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => router.push(`/admin/inbound/${shipment.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") router.push(`/admin/inbound/${shipment.id}`);
                    }}
                  >
                    <td className="p-3 font-mono text-xs">{shipment.tracking_number || "—"}</td>
                    <td className="p-3">{shipment.carrier || "—"}</td>
                    <td className="p-3">{shipment.org_name || "—"}</td>
                    <td className="p-3">
                      {shipment.expected_date
                        ? new Date(`${shipment.expected_date}T12:00:00`).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[shipment.status] ?? "bg-gray-100 text-gray-800"}`}
                      >
                        {STATUS_LABELS[shipment.status] ?? shipment.status}
                      </span>
                    </td>
                    <td className="p-3">{shipment.item_count}</td>
                    <td className="p-3">{shipment.submitter_name || "—"}</td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>

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
    </div>
  );
}
