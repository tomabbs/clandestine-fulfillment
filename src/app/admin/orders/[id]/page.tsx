/**
 * Order Pages Transition Phase 6 — Direct Order detail.
 *
 * Server component over `getStaffOrderDetail()`. Renders items, shipments,
 * tracking events, mirror links, and Phase 5b writeback rows so staff can
 * verify a single order's full transition state without bouncing between
 * cockpit, ShipStation Mirror, and review queue.
 *
 * `dynamic = 'force-dynamic'` — writeback / tracking / mirror state mutates
 * frequently and ISR caching would mislead operators reviewing a live
 * fulfillment.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffOrderDetail } from "@/actions/staff-orders";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const resolved =
    "then" in (params as object)
      ? await (params as Promise<{ id: string }>)
      : (params as { id: string });
  let detail: Awaited<ReturnType<typeof getStaffOrderDetail>>;
  try {
    detail = await getStaffOrderDetail(resolved.id);
  } catch (err) {
    console.error("[admin/orders/:id] failed", err);
    notFound();
  }

  const writebacks = detail.writebacks ?? [];

  return (
    <div className="space-y-6 p-4">
      <header className="space-y-1">
        <div className="flex items-baseline gap-3">
          <Link
            href="/admin/orders"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            ← Direct Orders
          </Link>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="font-mono text-xs text-muted-foreground">{detail.id.slice(0, 8)}</span>
        </div>
        <h1 className="text-2xl font-semibold">
          {detail.orderNumber ?? detail.externalOrderId ?? detail.id.slice(0, 8)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {detail.source ?? "—"} · {detail.orgName ?? "—"} · {detail.fulfillmentStatus ?? "—"}
          {detail.fulfillmentHold && detail.fulfillmentHold !== "no_hold"
            ? ` · hold: ${detail.fulfillmentHold}`
            : null}
        </p>
      </header>

      <Section title="Customer">
        <Field label="Name" value={detail.customerName ?? "—"} />
        <Field label="Email" value={detail.customerEmail ?? "—"} />
        <Field
          label="Total"
          value={
            detail.totalPrice !== null
              ? `${detail.totalPrice.toFixed(2)} ${detail.currency ?? ""}`.trim()
              : "—"
          }
        />
        <Field label="Created" value={new Date(detail.createdAt).toLocaleString()} />
      </Section>

      <Section title="Identity">
        <Field label="Status" value={detail.identityResolutionStatus} mono />
        <Field label="Connection ID" value={detail.connectionId ?? "—"} mono />
        <Field label="External order ID" value={detail.externalOrderId ?? "—"} mono />
      </Section>

      <Section title={`Items (${detail.items.length})`}>
        <Table
          headers={["SKU", "Title", "Qty", "Price"]}
          rows={detail.items.map((it) => [
            <span key="sku" className="font-mono text-xs">
              {it.sku ?? "—"}
            </span>,
            it.title ?? "—",
            it.quantity,
            it.price !== null ? it.price.toFixed(2) : "—",
          ])}
        />
      </Section>

      <Section title={`Shipments (${detail.shipments.length})`}>
        {detail.shipments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shipments.</p>
        ) : (
          <Table
            headers={["Tracking", "Carrier", "Status", "Source", "Ship date"]}
            rows={detail.shipments.map((s) => [
              <span key="tn" className="font-mono text-xs">
                {s.trackingNumber ?? "—"}
              </span>,
              s.carrier ?? "—",
              s.status ?? "—",
              s.labelSource ?? "—",
              s.shipDate ?? "—",
            ])}
          />
        )}
      </Section>

      <Section title={`Tracking events (${detail.trackingEvents.length})`}>
        {detail.trackingEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracking events recorded.</p>
        ) : (
          <Table
            headers={["When", "Status", "Description", "Location", "Source"]}
            rows={detail.trackingEvents.map((ev) => [
              ev.eventTime ? new Date(ev.eventTime).toLocaleString() : "—",
              ev.status,
              ev.description ?? "—",
              ev.location ?? "—",
              ev.trackingSource,
            ])}
          />
        )}
      </Section>

      <Section title={`Platform writeback (${writebacks.length})`}>
        {writebacks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No writeback rows. (For Bandcamp this is expected — bandcamp-mark-shipped owns the
            writeback path.)
          </p>
        ) : (
          writebacks.map((wb) => (
            <div key={wb.id} className="rounded border bg-card p-3 text-sm">
              <div className="mb-2 flex flex-wrap items-baseline gap-3">
                <span className="font-medium">{wb.platform}</span>
                <WritebackStatusBadge status={wb.status} />
                <span className="text-xs text-muted-foreground">
                  attempt {wb.attemptCount}
                  {wb.lastAttemptAt ? ` · ${new Date(wb.lastAttemptAt).toLocaleString()}` : null}
                </span>
                {wb.externalOrderId ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {wb.externalOrderId}
                  </span>
                ) : null}
              </div>
              {wb.errorMessage ? (
                <p className="mb-2 text-xs text-red-700 dark:text-red-300">{wb.errorMessage}</p>
              ) : null}
              {wb.lines.length > 0 ? (
                <Table
                  headers={["Item", "Qty", "Status", "Error"]}
                  rows={wb.lines.map((ln) => [
                    <span key="oi" className="font-mono text-[10px]">
                      {ln.warehouseOrderItemId.slice(0, 8)}
                    </span>,
                    ln.quantityFulfilled,
                    ln.status,
                    ln.errorMessage ?? "—",
                  ])}
                />
              ) : null}
            </div>
          ))
        )}
      </Section>

      <Section title={`Mirror links (${detail.mirrorLinks.length})`}>
        {detail.mirrorLinks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bridge links to ShipStation Mirror. Run the bridge from{" "}
            <Link className="underline" href="/admin/orders/diagnostics">
              diagnostics
            </Link>
            .
          </p>
        ) : (
          <Table
            headers={["Mirror order ID", "Confidence", "Signals"]}
            rows={detail.mirrorLinks.map((ml) => [
              <span key="ss" className="font-mono text-[10px]">
                {ml.shipstationOrderId.slice(0, 8)}
              </span>,
              ml.confidence,
              <pre
                key="sig"
                className="max-w-[40ch] truncate font-mono text-[10px] text-muted-foreground"
              >
                {JSON.stringify(ml.matchSignals)}
              </pre>,
            ])}
          />
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: Array<Array<React.ReactNode>> }) {
  return (
    <div className="overflow-x-auto rounded border bg-card">
      <table className="min-w-full divide-y text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable for this server-rendered detail table
            <tr key={i}>
              {row.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells share row key
                <td key={j} className="px-3 py-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WritebackStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    succeeded: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    partial_succeeded: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    in_progress: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
    pending: "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
    failed_retryable: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    failed_terminal: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
    blocked_missing_identity: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
    blocked_bandcamp_generic_path:
      "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
    not_required: "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
  };
  const cls = map[status] ?? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{status}</span>;
}
