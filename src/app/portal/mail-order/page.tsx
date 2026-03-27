"use client";

import { ChevronLeft, ChevronRight, DollarSign } from "lucide-react";
import { useState } from "react";
import { getClientMailOrders, getMailOrderPayoutSummary } from "@/actions/mail-orders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type MailOrderRow = Awaited<ReturnType<typeof getClientMailOrders>>["orders"][number];

const PAYOUT_LABELS: Record<string, string> = {
  pending: "Pending",
  included_in_snapshot: "In Billing",
  paid: "Paid",
};

export default function PortalMailOrderPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: 25,
    status: "",
    payoutStatus: "",
  });

  const { data, isLoading } = useAppQuery({
    queryKey: ["mail-orders", "portal", filters],
    queryFn: () => getClientMailOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: summary } = useAppQuery({
    queryKey: ["mail-orders", "summary"],
    queryFn: () => getMailOrderPayoutSummary(),
    tier: CACHE_TIERS.SESSION,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mail-Order</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your consignment orders sold through Clandestine. You receive 50% of the product subtotal.
        </p>
      </div>

      {/* Payout summary */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">Pending Payout</p>
            <p className="text-2xl font-semibold font-mono mt-1">
              ${summary.totalPendingPayout.toFixed(2)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {summary.pendingOrderCount} order{summary.pendingOrderCount !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">In Current Billing</p>
            <p className="text-2xl font-semibold font-mono mt-1">
              ${summary.totalIncludedPayout.toFixed(2)}
            </p>
          </div>
          <div className="border rounded-lg p-4 col-span-2 sm:col-span-1">
            <p className="text-sm text-muted-foreground">Payout Rate</p>
            <div className="flex items-center gap-1 mt-1">
              <DollarSign className="h-5 w-5 text-muted-foreground" />
              <p className="text-2xl font-semibold">50%</p>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">of product subtotal</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="unfulfilled">Unfulfilled</option>
          <option value="fulfilled">Fulfilled</option>
        </select>
        <select
          value={filters.payoutStatus}
          onChange={(e) => setFilters((f) => ({ ...f, payoutStatus: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All payout statuses</option>
          <option value="pending">Pending payout</option>
          <option value="included_in_snapshot">In billing</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
              <TableHead className="text-right">Your Payout</TableHead>
              <TableHead>Payout Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: MailOrderRow) => (
              <TableRow key={order.id}>
                <TableCell className="font-mono text-sm">{order.order_number ?? "—"}</TableCell>
                <TableCell>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-800">
                    {order.source === "clandestine_shopify" ? "Shopify" : "Discogs"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(order.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Badge variant={order.fulfillment_status === "fulfilled" ? "default" : "outline"}>
                    {order.fulfillment_status === "fulfilled" ? "Fulfilled" : "Unfulfilled"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono">
                  ${Number(order.subtotal).toFixed(2)}
                </TableCell>
                <TableCell className="text-right font-mono font-medium text-green-700">
                  +${Number(order.client_payout_amount ?? 0).toFixed(2)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      order.client_payout_status === "paid"
                        ? "default"
                        : order.client_payout_status === "included_in_snapshot"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {PAYOUT_LABELS[order.client_payout_status ?? "pending"] ?? "Pending"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {(data?.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No mail-order sales yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
