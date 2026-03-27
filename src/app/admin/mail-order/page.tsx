"use client";

import { ChevronLeft, ChevronRight, Store } from "lucide-react";
import { useState } from "react";
import { getMailOrders } from "@/actions/mail-orders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type MailOrderRow = Awaited<ReturnType<typeof getMailOrders>>["orders"][number];

const PAYOUT_STATUS_CONFIG: Record<
  string,
  { variant: "default" | "secondary" | "outline"; label: string }
> = {
  pending: { variant: "outline", label: "Pending" },
  included_in_snapshot: { variant: "secondary", label: "In Billing" },
  paid: { variant: "default", label: "Paid" },
};

const FULFILLMENT_CONFIG: Record<
  string,
  { variant: "default" | "secondary" | "outline" | "destructive"; label: string }
> = {
  unfulfilled: { variant: "outline", label: "Unfulfilled" },
  fulfilled: { variant: "default", label: "Fulfilled" },
};

export default function AdminMailOrderPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: 25,
    search: "",
    status: "",
    payoutStatus: "",
  });

  const { data, isLoading } = useAppQuery({
    queryKey: ["mail-orders", "admin", filters],
    queryFn: () => getMailOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Mail-Order</h1>
      <p className="text-sm text-muted-foreground">
        Consignment orders from Clandestine Shopify and Discogs. Client payout = 50% of subtotal.
      </p>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order number…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
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
              <TableHead>Client</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
              <TableHead className="text-right">Payout (50%)</TableHead>
              <TableHead>Payout Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: MailOrderRow) => {
              const orgName =
                (order as MailOrderRow & { organizations?: { name: string } }).organizations
                  ?.name ?? "—";
              const fulfillConfig =
                FULFILLMENT_CONFIG[order.fulfillment_status ?? "unfulfilled"] ??
                FULFILLMENT_CONFIG.unfulfilled;
              const payoutConfig =
                PAYOUT_STATUS_CONFIG[order.client_payout_status ?? "pending"] ??
                PAYOUT_STATUS_CONFIG.pending;

              return (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-sm">{order.order_number ?? "—"}</TableCell>
                  <TableCell className="text-sm">{orgName}</TableCell>
                  <TableCell>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-800">
                      {order.source === "clandestine_shopify" ? "Shopify" : "Discogs"}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(order.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={fulfillConfig.variant}>{fulfillConfig.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${Number(order.subtotal).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium">
                    ${Number(order.client_payout_amount ?? 0).toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={payoutConfig.variant}>{payoutConfig.label}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
            {(data?.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  <Store className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No mail-order orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages} ({data?.total ?? 0} total)
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
