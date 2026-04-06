"use client";

import { ChevronDown, ChevronRight, MapPin, Package, Store } from "lucide-react";
import { useState } from "react";
import { getMailOrders } from "@/actions/mail-orders";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
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

type LineItem = {
  sku: string | null;
  title: string | null;
  variant_title: string | null;
  quantity: number;
  price: number | null;
};

type ShippingAddress = {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
};

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

function formatAddress(addr: ShippingAddress | null): string {
  if (!addr) return "—";
  const parts = [
    [addr.firstName, addr.lastName].filter(Boolean).join(" "),
    addr.address1,
    addr.address2,
    [addr.city, addr.province, addr.zip].filter(Boolean).join(", "),
    addr.country,
  ].filter(Boolean);
  return parts.join(" · ");
}

function OrderDetail({ order }: { order: MailOrderRow }) {
  const lineItems = (order.line_items as unknown as LineItem[]) ?? [];
  const addr = order.shipping_address as unknown as ShippingAddress | null;

  return (
    <div className="bg-muted/30 border-t px-4 py-3 space-y-3">
      {/* Customer + address */}
      <div className="flex items-start gap-6 text-sm">
        <div className="min-w-0">
          <p className="font-medium">{order.customer_name ?? "—"}</p>
          {order.customer_email && (
            <p className="text-muted-foreground text-xs">{order.customer_email}</p>
          )}
        </div>
        {addr && (
          <div className="flex items-start gap-1.5 text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="text-xs">{formatAddress(addr)}</span>
          </div>
        )}
      </div>

      {/* Line items */}
      {lineItems.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Items</p>
          <div className="rounded border bg-background divide-y">
            {lineItems.map((li, i) => (
              <div
                key={`${li.sku}-${i}`}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium">{li.title ?? "—"}</span>
                  {li.variant_title && li.variant_title !== "Default Title" && (
                    <span className="text-muted-foreground ml-1">· {li.variant_title}</span>
                  )}
                  {li.sku && (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{li.sku}</span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0 ml-4">
                  <span className="text-muted-foreground">×{li.quantity}</span>
                  <span className="font-mono tabular-nums w-16 text-right">
                    {li.price != null ? `$${(li.price * li.quantity).toFixed(2)}` : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="flex gap-6 text-sm text-muted-foreground">
        <span>
          Subtotal:{" "}
          <span className="font-mono text-foreground">${Number(order.subtotal).toFixed(2)}</span>
        </span>
        {Number(order.shipping_amount) > 0 && (
          <span>
            Shipping:{" "}
            <span className="font-mono text-foreground">
              ${Number(order.shipping_amount).toFixed(2)}
            </span>
          </span>
        )}
        <span>
          Payout (50%):{" "}
          <span className="font-mono font-medium text-foreground">
            ${Number(order.client_payout_amount ?? 0).toFixed(2)}
          </span>
        </span>
      </div>
    </div>
  );
}

export default function AdminMailOrderPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    search: "",
    status: "",
    payoutStatus: "",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: ["mail-orders", "admin", filters],
    queryFn: () => getMailOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Mail-Order</h1>
      <p className="text-sm text-muted-foreground">
        Consignment orders from Clandestine Shopify and Discogs. Each row is one client's share of
        an order. Payout = 50% of their items' subtotal.
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
        <>
          {data && data.total > 0 && (
            <PaginationBar
              page={filters.page}
              pageSize={filters.pageSize}
              total={data.total}
              onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
              onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
            />
          )}
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Order</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Fulfillment</TableHead>
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
                  const isExpanded = expandedId === order.id;

                  return (
                    <>
                      <TableRow
                        key={order.id}
                        className="cursor-pointer"
                        onClick={() => setExpandedId(isExpanded ? null : order.id)}
                      >
                        <TableCell className="w-8 text-muted-foreground">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {order.order_number ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm font-medium">{orgName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[160px] truncate">
                          {order.customer_name ?? "—"}
                        </TableCell>
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
                      {isExpanded && (
                        <tr key={`${order.id}-detail`}>
                          <td colSpan={10} className="p-0">
                            <OrderDetail order={order} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
                {(data?.orders ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                      <Store className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      No mail-order orders found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
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
