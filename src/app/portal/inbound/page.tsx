"use client";

import { Package, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { getClientInboundShipments, type InboundShipmentWithOrg } from "@/actions/inbound";
import { type PageSize, PaginationBar } from "@/components/shared/pagination-bar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { InboundStatus } from "@/lib/shared/types";

const STATUS_LABELS: Record<string, string> = {
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

export default function PortalInboundPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);

  const { data, isLoading, error } = useAppQuery<{ data: InboundShipmentWithOrg[]; count: number }>(
    {
      queryKey: queryKeys.inbound.list({ page, pageSize, portal: true } as Record<string, unknown>),
      queryFn: () => getClientInboundShipments({ page, pageSize }),
      tier: CACHE_TIERS.SESSION,
    },
  );

  const shipments = data?.data ?? [];
  const totalCount = data?.count ?? 0;

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Inbound Shipments</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbound Shipments</h1>
          <p className="text-muted-foreground mt-1">
            Track your incoming shipments to the warehouse.
          </p>
        </div>
        <Link href="/portal/inbound/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Submit New Inbound
          </Button>
        </Link>
      </div>

      {/* Shipments List */}
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
      <div className="space-y-3">
        {isLoading ? (
          ["sk-1", "sk-2", "sk-3"].map((id) => (
            <Skeleton key={id} className="h-24 w-full rounded-lg" />
          ))
        ) : shipments.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Package className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p>No inbound shipments yet.</p>
            <p className="text-sm mt-1">Submit a new inbound shipment to get started.</p>
          </div>
        ) : (
          shipments.map((shipment) => <ShipmentCard key={shipment.id} shipment={shipment} />)
        )}
      </div>

      {/* Pagination */}
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

function ShipmentCard({ shipment }: { shipment: InboundShipmentWithOrg }) {
  return (
    <div className="border rounded-lg p-4 hover:bg-muted/30 transition-colors">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">
              {shipment.tracking_number || "No Tracking Number"}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[shipment.status] ?? "bg-gray-100 text-gray-800"}`}
            >
              {STATUS_LABELS[shipment.status] ?? shipment.status}
            </span>
          </div>
          <div className="flex gap-4 mt-1 text-sm text-muted-foreground">
            {shipment.carrier && <span>Carrier: {shipment.carrier}</span>}
            {shipment.expected_date && (
              <span>
                Expected: {new Date(`${shipment.expected_date}T12:00:00`).toLocaleDateString()}
              </span>
            )}
            <span>{shipment.item_count} item(s)</span>
          </div>
        </div>
        <StatusMiniBar status={shipment.status} />
      </div>
    </div>
  );
}

function StatusMiniBar({ status }: { status: InboundStatus }) {
  const steps: InboundStatus[] = ["expected", "arrived", "checking_in", "checked_in"];
  const currentIndex = steps.indexOf(status);

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, i) => (
        <div
          key={step}
          className={`h-1.5 w-6 rounded-full ${
            i <= currentIndex && status !== "issue" ? "bg-primary" : "bg-muted"
          }`}
        />
      ))}
    </div>
  );
}
