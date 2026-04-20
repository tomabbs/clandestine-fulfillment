"use client";

import { ChevronDown, ChevronRight, DollarSign, MapPin } from "lucide-react";
import { useState } from "react";
import { getClientMailOrders, getMailOrderPayoutSummary } from "@/actions/mail-orders";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type MailOrderRow = Awaited<ReturnType<typeof getClientMailOrders>>["orders"][number];

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

const PAYOUT_LABELS: Record<string, string> = {
  pending: "Pending",
  included_in_snapshot: "In Billing",
  paid: "Paid",
};

function formatAddress(addr: ShippingAddress | null): string {
  if (!addr) return "—";
  const line1 = [addr.firstName, addr.lastName].filter(Boolean).join(" ");
  const line2 = addr.address1 ?? "";
  const line3 = [addr.city, addr.province, addr.zip].filter(Boolean).join(", ");
  const line4 = addr.country ?? "";
  return [line1, line2, line3, line4].filter(Boolean).join(" · ");
}

function OrderDetail({ order }: { order: MailOrderRow }) {
  const lineItems = (order.line_items as unknown as LineItem[]) ?? [];
  const addr = order.shipping_address as unknown as ShippingAddress | null;

  return (
    <div className="bg-muted/30 border-t px-4 py-3 space-y-3">
      {/* Ship-to */}
      <div className="flex items-start gap-6 text-sm">
        <div>
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

      {/* Your items in this order */}
      {lineItems.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Your items in this order
          </p>
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

      {/* Payout breakdown */}
      <div className="flex gap-6 text-sm text-muted-foreground">
        <span>
          Items subtotal:{" "}
          <span className="font-mono text-foreground">${Number(order.subtotal).toFixed(2)}</span>
        </span>
        <span>
          Your payout (50%):{" "}
          <span className="font-mono font-medium text-green-700">
            +${Number(order.client_payout_amount ?? 0).toFixed(2)}
          </span>
        </span>
      </div>
    </div>
  );
}

export default function PortalMailOrderPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    status: "",
    payoutStatus: "",
  });
  useListPaginationPreference("portal/mail-order", filters, setFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error } = useAppQuery({
    queryKey: ["mail-orders", "portal", filters],
    queryFn: () => getClientMailOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: summary } = useAppQuery({
    queryKey: ["mail-orders", "summary"],
    queryFn: () => getMailOrderPayoutSummary(),
    tier: CACHE_TIERS.SESSION,
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Mail-Order</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  return (
    <PageShell
      title="Mail-Order"
      description="Your consignment orders sold through Clandestine. You receive 50% of your items' subtotal."
      maxWidth="full"
    >
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
            <p className="text-xs text-muted-foreground mt-0.5">of your items' subtotal</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <PageToolbar>
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
        ariaLabel="Portal mail-order list"
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
          return (
            <div className="min-w-0 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-sm">{order.order_number ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{order.customer_name ?? "—"}</p>
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
          return (
            <div className="flex items-center gap-2">
              <Badge variant={order.fulfillment_status === "fulfilled" ? "default" : "outline"}>
                {order.fulfillment_status === "fulfilled" ? "Fulfilled" : "Unfulfilled"}
              </Badge>
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
            </div>
          );
        }}
        renderBody={({ row }) => {
          const order = row as MailOrderRow;
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <PayoutMetric
                label="Source"
                value={order.source === "clandestine_shopify" ? "Shopify" : "Discogs"}
              />
              <PayoutMetric label="Date" value={new Date(order.created_at).toLocaleDateString()} />
              <PayoutMetric label="Subtotal" value={`$${Number(order.subtotal).toFixed(2)}`} mono />
              <PayoutMetric
                label="Your payout"
                value={`+$${Number(order.client_payout_amount ?? 0).toFixed(2)}`}
                mono
                success
              />
            </div>
          );
        }}
        renderExpanded={({ row }) => (
          <div className="rounded-md border bg-muted/30 p-0">
            <OrderDetail order={row as MailOrderRow} />
          </div>
        )}
        emptyState={<EmptyState title="No mail-order sales yet" />}
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

function PayoutMetric({
  label,
  value,
  mono = false,
  success = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  success?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={
          mono ? (success ? "font-mono text-sm text-green-700" : "font-mono text-sm") : "text-sm"
        }
      >
        {value}
      </p>
    </div>
  );
}
