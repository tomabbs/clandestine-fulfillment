"use client";

import { ChevronDown, ChevronRight, MapPin, Store } from "lucide-react";
import { useState } from "react";
import { getMailOrders } from "@/actions/mail-orders";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
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
                // biome-ignore lint/suspicious/noArrayIndexKey: JSONB line items have no stable unique ID
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
  useListPaginationPreference("admin/mail-order", filters, setFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: ["mail-orders", "admin", filters],
    queryFn: () => getMailOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <PageShell
      title="Mail-Order"
      description="Consignment orders from Clandestine Shopify and Discogs."
      maxWidth="full"
      toolbar={
        <PageToolbar>
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
        </PageToolbar>
      }
    >
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
        className="mt-3"
        items={data?.orders ?? []}
        totalCount={data?.total}
        itemKey={(order) => order.id}
        loading={isLoading}
        density="ops"
        ariaLabel="Admin mail-order list"
        expandedKeys={
          expandedId
            ? (new Set<string | number>([expandedId]) as Set<string | number>)
            : (new Set<string | number>() as Set<string | number>)
        }
        onExpandedKeysChange={(keys) => {
          const next = Array.from(keys)[0];
          setExpandedId(next ? String(next) : null);
        }}
        renderHeader={({ row, expanded, toggleExpanded }) => {
          const order = row as MailOrderRow;
          const orgName =
            (order as MailOrderRow & { organizations?: { name: string } }).organizations?.name ??
            "—";
          return (
            <div className="min-w-0 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-sm">{order.order_number ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {orgName} · {order.customer_name ?? "—"}
                </p>
              </div>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpanded();
                }}
              >
                {expanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
            </div>
          );
        }}
        renderExceptionZone={({ row }) => {
          const order = row as MailOrderRow;
          const fulfillConfig =
            FULFILLMENT_CONFIG[order.fulfillment_status ?? "unfulfilled"] ??
            FULFILLMENT_CONFIG.unfulfilled;
          const payoutConfig =
            PAYOUT_STATUS_CONFIG[order.client_payout_status ?? "pending"] ??
            PAYOUT_STATUS_CONFIG.pending;
          return (
            <div className="flex items-center gap-2">
              <Badge variant={fulfillConfig.variant}>{fulfillConfig.label}</Badge>
              <Badge variant={payoutConfig.variant}>{payoutConfig.label}</Badge>
            </div>
          );
        }}
        renderBody={({ row }) => {
          const order = row as MailOrderRow;
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <OrderMetric
                label="Source"
                value={order.source === "clandestine_shopify" ? "Shopify" : "Discogs"}
              />
              <OrderMetric label="Date" value={new Date(order.created_at).toLocaleDateString()} />
              <OrderMetric label="Subtotal" value={`$${Number(order.subtotal).toFixed(2)}`} mono />
              <OrderMetric
                label="Payout (50%)"
                value={`$${Number(order.client_payout_amount ?? 0).toFixed(2)}`}
                mono
              />
            </div>
          );
        }}
        renderExpanded={({ row }) => (
          <div className="rounded-md border bg-muted/30 p-0">
            <OrderDetail order={row as MailOrderRow} />
          </div>
        )}
        emptyState={
          <EmptyState
            icon={Store}
            title="No mail-order orders found"
            description="Try broader filters."
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

function OrderMetric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-sm" : "text-sm"}>{value}</p>
    </div>
  );
}
