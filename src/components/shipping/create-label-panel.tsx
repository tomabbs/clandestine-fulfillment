// Phase 3.3 — Shared per-row Buy Label panel.
//
// Lifted from src/app/admin/orders-legacy/_legacy-orders-view.tsx so the cockpit
// (Phase 2.2) and the legacy view share one implementation. Differences vs
// the legacy version:
//
//   1. orderType union widened to include "shipstation" (Phase 3.1/3.2).
//   2. Passes the Phase 0.2 stable rate key (selectedRate) to the action,
//      not selectedRateId. The action accepts both for back-compat but the
//      key path is preferred — survives EP rate-ID churn between preview
//      and purchase.
//   3. Optional onSuccess callback so the cockpit row can refetch / collapse
//      after a successful label purchase.
"use client";

import { ExternalLink, Loader2, Tag } from "lucide-react";
import { useState } from "react";
import {
  createOrderLabel,
  getLabelTaskStatus,
  getShippingRates,
  type LabelResult,
  type OrderType,
  type RateOption,
} from "@/actions/shipping";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export interface CreateLabelPanelProps {
  orderId: string;
  orderType: OrderType;
  customerShippingCharged?: number | null;
  /** Fired when a label is successfully purchased. Cockpit uses this to refetch + collapse the row. */
  onSuccess?: (result: LabelResult) => void;
}

export function CreateLabelPanel({
  orderId,
  orderType,
  customerShippingCharged,
  onSuccess,
}: CreateLabelPanelProps) {
  const [showRates, setShowRates] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [labelResult, setLabelResult] = useState<LabelResult | null>(null);
  const [_taskRunId, setTaskRunId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const ratesQuery = useAppQuery({
    queryKey: ["label-rates", orderId, orderType],
    queryFn: () => getShippingRates(orderId, orderType),
    tier: CACHE_TIERS.SESSION,
    enabled: showRates,
  });

  const rates: RateOption[] = ratesQuery.data?.rates ?? [];

  const createMut = useAppMutation({
    mutationFn: async () => {
      if (!selectedRateId) throw new Error("Select a rate first");
      const picked = rates.find((r) => r.id === selectedRateId);
      // Phase 0.2 stable key — pass carrier+service+rate+deliveryDays so the
      // task can re-resolve on the new EP shipment created at purchase time.
      const selectedRate = picked
        ? {
            carrier: picked.carrier,
            service: picked.service,
            rate: picked.rate,
            deliveryDays: picked.deliveryDays,
          }
        : undefined;
      return createOrderLabel(orderId, {
        orderType,
        selectedRateId,
        selectedRate,
      });
    },
    onSuccess: async (result) => {
      if (!result.success) {
        setLabelResult(result);
        return;
      }
      // result.shipmentId is the Trigger.dev run ID when using the task path.
      if (result.shipmentId) {
        const shipmentId = result.shipmentId;
        setTaskRunId(shipmentId);
        setPolling(true);
        const poll = async () => {
          const status = await getLabelTaskStatus(shipmentId);
          if (status.status === "completed" || status.status === "failed") {
            setPolling(false);
            const finalResult = status.result ?? { success: false, error: "Unknown status" };
            setLabelResult(finalResult);
            if (finalResult.success && onSuccess) onSuccess(finalResult);
          } else {
            setTimeout(poll, 2500);
          }
        };
        setTimeout(poll, 2500);
      } else {
        setLabelResult(result);
        if (result.success && onSuccess) onSuccess(result);
      }
    },
  });

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <Tag className="h-4 w-4" />
          Create Shipping Label
        </h4>
        {!showRates && !labelResult && (
          <Button size="sm" variant="outline" onClick={() => setShowRates(true)}>
            Get Rates
          </Button>
        )}
      </div>

      {customerShippingCharged != null && (
        <p className="text-xs text-muted-foreground">
          Customer paid for shipping:{" "}
          <span className="font-mono font-medium text-foreground">
            ${customerShippingCharged.toFixed(2)}
          </span>{" "}
          — pick the rate closest to this amount.
        </p>
      )}

      {showRates && ratesQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Fetching rates…
        </div>
      )}

      {ratesQuery.data?.error && (
        <p className="text-sm text-destructive">{ratesQuery.data.error}</p>
      )}

      {!ratesQuery.isLoading && rates.length > 0 && !labelResult && (
        <div className="space-y-2">
          <div className="grid gap-2">
            {rates.map((rate) => (
              <label
                key={rate.id}
                className={`flex items-center justify-between border rounded-md px-3 py-2 cursor-pointer text-sm transition-colors ${
                  selectedRateId === rate.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground"
                }`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`rate-${orderId}`}
                    value={rate.id}
                    checked={selectedRateId === rate.id}
                    onChange={() => setSelectedRateId(rate.id)}
                    className="sr-only"
                  />
                  <div>
                    <span className="font-medium">{rate.displayName}</span>
                    {rate.recommended && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        Recommended
                      </Badge>
                    )}
                    {rate.isMediaMail && (
                      <Badge variant="outline" className="ml-1 text-xs">
                        Media Mail
                      </Badge>
                    )}
                    {rate.deliveryDays && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        ~{rate.deliveryDays}d
                      </span>
                    )}
                  </div>
                </div>
                <span className="font-mono font-semibold">${rate.rate.toFixed(2)}</span>
              </label>
            ))}
          </div>
          <Button
            size="sm"
            disabled={!selectedRateId || createMut.isPending || polling}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending || polling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Creating…
              </>
            ) : (
              "Buy Label"
            )}
          </Button>
        </div>
      )}

      {labelResult && (
        <div
          className={`rounded-md p-3 text-sm ${labelResult.success ? "bg-green-50 border border-green-200" : "bg-destructive/10 border border-destructive/20"}`}
        >
          {labelResult.success ? (
            <div className="space-y-2">
              <p className="font-medium text-green-800">Label created!</p>
              <div className="text-green-700 space-y-1">
                <p>
                  Carrier: {labelResult.carrier} · {labelResult.service}
                </p>
                <p>
                  Tracking: <span className="font-mono">{labelResult.trackingNumber}</span>
                </p>
                <p>
                  Cost: <span className="font-mono">${labelResult.rate?.toFixed(2)}</span>
                </p>
              </div>
              {labelResult.labelUrl && (
                <a
                  href={labelResult.labelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open label (Cmd+P to print)
                </a>
              )}
            </div>
          ) : (
            <p className="text-destructive">{labelResult.error ?? "Label creation failed"}</p>
          )}
        </div>
      )}
    </div>
  );
}
