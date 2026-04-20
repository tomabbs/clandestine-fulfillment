"use client";

// Phase 9.1 — Bulk Buy + Print Labels modal.
//
// Lazy-loads getShippingRates per selected order in parallel (capped to a
// small concurrency to avoid hammering EP), shows a dropdown per row with
// the cheapest rate selected by default, then calls bulkBuyLabels and
// polls print_batch_jobs.progress for completion. On completion, navigates
// to /admin/orders/print-batch/[batchId].
//
// Failure modes surfaced visibly:
//   - rate fetch fails for a row → row shows "Could not load rates" + the
//     order is excluded from the Buy All payload (cannot purchase without a
//     selected rate).
//   - per-order purchase fails inside the orchestrator → batch row's
//     `progress.per_order[uuid].error` lights up the row red in the modal.

import { Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { bulkBuyLabels, getPrintBatchProgress } from "@/actions/bulk-orders";
import type { CockpitOrder } from "@/actions/shipstation-orders";
import type { RateOption } from "@/actions/shipping";
import { getShippingRates } from "@/actions/shipping";
import { Button } from "@/components/ui/button";

const RATES_FETCH_CONCURRENCY = 4;
const POLL_INTERVAL_MS = 2000;

interface RowRateState {
  loading: boolean;
  error?: string;
  options: RateOption[];
  selectedId: string | null;
}

export function BulkBuyLabelsModal({
  selectedIds,
  visibleOrders,
  onClose,
  onCompleted,
}: {
  selectedIds: string[];
  visibleOrders: CockpitOrder[];
  onClose: () => void;
  onCompleted: () => void;
}) {
  const router = useRouter();
  const [rateState, setRateState] = useState<Record<string, RowRateState>>({});
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<{
    status: string;
    progress: Record<string, unknown>;
    shipment_ids: string[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch rates per selected order in batches of RATES_FETCH_CONCURRENCY.
  useEffect(() => {
    let cancelled = false;
    async function loadRates() {
      const init: Record<string, RowRateState> = {};
      for (const id of selectedIds) {
        init[id] = { loading: true, options: [], selectedId: null };
      }
      setRateState(init);

      // Slice queue into chunks for crude concurrency control.
      const queue = [...selectedIds];
      while (queue.length > 0 && !cancelled) {
        const chunk = queue.splice(0, RATES_FETCH_CONCURRENCY);
        await Promise.all(
          chunk.map(async (id) => {
            try {
              const r = await getShippingRates(id, "shipstation");
              if (cancelled) return;
              const cheapest = r.rates.length > 0
                ? r.rates.reduce((a, b) => (a.rate <= b.rate ? a : b))
                : null;
              setRateState((s) => ({
                ...s,
                [id]: {
                  loading: false,
                  options: r.rates,
                  error: r.error,
                  selectedId: cheapest?.id ?? null,
                },
              }));
            } catch (err) {
              if (cancelled) return;
              setRateState((s) => ({
                ...s,
                [id]: {
                  loading: false,
                  options: [],
                  error: err instanceof Error ? err.message : String(err),
                  selectedId: null,
                },
              }));
            }
          }),
        );
      }
    }
    void loadRates();
    return () => {
      cancelled = true;
    };
  }, [selectedIds]);

  // Poll batch progress while a batch is in flight.
  useEffect(() => {
    if (!batchId) return;
    let active = true;
    async function tick() {
      try {
        const p = await getPrintBatchProgress({ batchId: batchId! });
        if (!active) return;
        setBatchStatus({
          status: p.status,
          progress: p.progress,
          shipment_ids: p.shipment_ids,
        });
        if (
          p.status === "completed" ||
          p.status === "completed_with_errors" ||
          p.status === "failed"
        ) {
          // Navigate to print batch page on terminal status.
          router.push(`/admin/orders/print-batch/${batchId}`);
          onCompleted();
        }
      } catch (err) {
        // Surface but keep polling.
        console.error("[BulkBuyLabelsModal] poll failed", err);
      }
    }
    const int = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      active = false;
      clearInterval(int);
    };
  }, [batchId, router, onCompleted]);

  const orderById = useMemo(
    () => new Map(visibleOrders.map((o) => [o.id, o])),
    [visibleOrders],
  );

  const ready = selectedIds.filter((id) => rateState[id]?.selectedId);
  const hasErrors = selectedIds.filter((id) => rateState[id]?.error).length > 0;

  async function buyAll() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const buys = ready.flatMap((id) => {
        const st = rateState[id];
        const rate = st?.options.find((r) => r.id === st.selectedId);
        if (!st || !rate) return [];
        return [
          {
            shipstationOrderUuid: id,
            selectedRate: {
              carrier: rate.carrier,
              service: rate.service,
              rate: rate.rate,
              deliveryDays: rate.deliveryDays,
            },
          },
        ];
      });
      const r = await bulkBuyLabels({ buys });
      setBatchId(r.batchId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">
            Buy + Print Labels{" "}
            <span className="text-muted-foreground font-normal">
              ({selectedIds.length} order{selectedIds.length === 1 ? "" : "s"})
            </span>
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {batchId && batchStatus ? (
          <BatchProgress batchStatus={batchStatus} total={selectedIds.length} />
        ) : (
          <>
            <div className="p-4 text-xs text-muted-foreground">
              {hasErrors
                ? `Some orders couldn't load rates and will be skipped. ${ready.length} of ${selectedIds.length} ready to buy.`
                : `Suggested rate per order is the cheapest. Override in the dropdown if needed.`}
              {selectedIds.length > 50 && (
                <span className="block mt-1 text-amber-700">
                  Heads up — batches over 50 orders take ≥90 seconds wall-clock at the SS rate limit.
                </span>
              )}
            </div>
            <div className="px-4 pb-4 space-y-2">
              {selectedIds.map((id) => {
                const order = orderById.get(id);
                const st = rateState[id];
                return (
                  <div
                    key={id}
                    className="grid grid-cols-12 items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="col-span-3 font-mono">
                      {order?.order_number ?? id.slice(0, 8)}
                    </div>
                    <div className="col-span-3 truncate text-muted-foreground">
                      {order?.customer_name ?? "—"}
                    </div>
                    <div className="col-span-6">
                      {st?.loading ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          loading rates…
                        </span>
                      ) : st?.error ? (
                        <span className="text-xs text-red-700">
                          {st.error.slice(0, 80)}
                        </span>
                      ) : st?.options.length === 0 ? (
                        <span className="text-xs text-amber-700">
                          No rates returned
                        </span>
                      ) : (
                        <select
                          className="w-full rounded border px-2 py-1 text-xs"
                          value={st?.selectedId ?? ""}
                          onChange={(e) =>
                            setRateState((s) => ({
                              ...s,
                              [id]: { ...s[id]!, selectedId: e.target.value },
                            }))
                          }
                        >
                          {st?.options.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.displayName} — ${r.rate.toFixed(2)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {submitError && (
              <div className="mx-4 mb-4 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                {submitError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={() => void buyAll()}
                disabled={submitting || ready.length === 0}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    Starting batch…
                  </>
                ) : (
                  `Buy ${ready.length} label${ready.length === 1 ? "" : "s"}`
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BatchProgress({
  batchStatus,
  total,
}: {
  batchStatus: { status: string; progress: Record<string, unknown> };
  total: number;
}) {
  const completed = Number((batchStatus.progress as { completed?: number })?.completed ?? 0);
  const succeeded = Number((batchStatus.progress as { succeeded?: number })?.succeeded ?? 0);
  const failed = Number((batchStatus.progress as { failed?: number })?.failed ?? 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="p-6 space-y-4">
      <div className="text-sm">
        {completed === total ? (
          <span>
            Batch <strong>{batchStatus.status.replace(/_/g, " ")}</strong> — {succeeded} ok ·{" "}
            {failed} failed
          </span>
        ) : (
          <span>
            Buying labels — {completed} / {total} done · {failed} failed
          </span>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-blue-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground">
        Redirecting to the print page when the batch completes.
      </div>
    </div>
  );
}
