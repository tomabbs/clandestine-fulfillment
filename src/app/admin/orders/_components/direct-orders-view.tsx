/**
 * Order Pages Transition Phase 3 — Direct Orders read model UI.
 *
 * Server component — renders the first page of orders synchronously.
 * Client interactivity (search filters, pagination) is the Phase 6
 * follow-up; Phase 3 ships the read model with the bare table so staff
 * can verify the data shape before flipping the route.
 */

import Link from "next/link";
import { type DirectOrderDTO, getStaffOrders } from "@/actions/staff-orders";

export async function DirectOrdersView({ workspaceId }: { workspaceId: string }) {
  let initial: Awaited<ReturnType<typeof getStaffOrders>> | null = null;
  let error: string | null = null;
  try {
    initial = await getStaffOrders({ page: 1, pageSize: 50 });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Direct Orders</h1>
          <p className="text-xs text-muted-foreground">
            Read model over <code>warehouse_orders</code> for workspace <code>{workspaceId}</code>.
            Use{" "}
            <Link className="underline" href="/admin/orders/diagnostics">
              diagnostics
            </Link>{" "}
            for identity health and{" "}
            <Link className="underline" href="/admin/orders/shipstation">
              ShipStation Mirror
            </Link>{" "}
            for label workflows.
          </p>
        </div>
        {initial ? (
          <p className="text-sm text-muted-foreground">
            {initial.total.toLocaleString()} order{initial.total === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Failed to load Direct Orders: {error}
        </div>
      ) : initial && initial.orders.length > 0 ? (
        <DirectOrderTable orders={initial.orders} />
      ) : (
        <p className="text-sm text-muted-foreground">No orders.</p>
      )}
    </div>
  );
}

function DirectOrderTable({ orders }: { orders: DirectOrderDTO[] }) {
  return (
    <div className="overflow-x-auto rounded border bg-card">
      <table className="min-w-full divide-y text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <Th>Order</Th>
            <Th>Source</Th>
            <Th>Org</Th>
            <Th>Customer</Th>
            <Th className="text-right">Total</Th>
            <Th>Status</Th>
            <Th>Identity</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-muted/30">
              <Td>
                <Link
                  href={`/admin/orders/${order.id}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {order.orderNumber ?? "—"}
                </Link>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {order.externalOrderId ?? order.id.slice(0, 8)}
                </div>
              </Td>
              <Td>{order.source ?? "—"}</Td>
              <Td>{order.orgName ?? "—"}</Td>
              <Td>
                <div>{order.customerName ?? "—"}</div>
                <div className="text-xs text-muted-foreground">{order.customerEmail ?? ""}</div>
              </Td>
              <Td className="text-right tabular-nums">
                {order.totalPrice !== null
                  ? `${order.totalPrice.toFixed(2)} ${order.currency ?? ""}`.trim()
                  : "—"}
              </Td>
              <Td>
                <div>{order.fulfillmentStatus ?? "—"}</div>
                {order.fulfillmentHold && order.fulfillmentHold !== "no_hold" ? (
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    {order.fulfillmentHold}
                  </div>
                ) : null}
              </Td>
              <Td>
                <IdentityBadge status={order.identityResolutionStatus} />
              </Td>
              <Td className="whitespace-nowrap text-xs">
                {new Date(order.createdAt).toLocaleDateString()}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left ${className ?? ""}`}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}

function IdentityBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    deterministic: {
      label: "deterministic",
      className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    },
    manual: {
      label: "manual",
      className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    },
    unresolved: {
      label: "unresolved",
      className: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
    ambiguous: {
      label: "ambiguous",
      className: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
    live_api_verification_failed: {
      label: "live verify failed",
      className: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
    },
    bandcamp_legacy_null: {
      label: "bandcamp legacy",
      className: "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
    },
  };
  const meta = map[status] ?? {
    label: status,
    className: "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}>
      {meta.label}
    </span>
  );
}
