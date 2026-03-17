"use client";

import { ArrowLeft, Check, CheckCircle2, CircleDot, Clock, Package, Truck } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  beginCheckIn,
  checkInItem,
  completeCheckIn,
  getInboundDetail,
  type InboundDetailResult,
  markArrived,
} from "@/actions/inbound";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { InboundStatus, WarehouseInboundItem } from "@/lib/shared/types";

const STATUS_STEPS: { key: InboundStatus; label: string; icon: typeof Clock }[] = [
  { key: "expected", label: "Expected", icon: Clock },
  { key: "arrived", label: "Arrived", icon: Truck },
  { key: "checking_in", label: "Checking In", icon: CircleDot },
  { key: "checked_in", label: "Checked In", icon: CheckCircle2 },
];

function StatusProgressBar({ currentStatus }: { currentStatus: InboundStatus }) {
  const currentIndex = STATUS_STEPS.findIndex((s) => s.key === currentStatus);
  const isIssue = currentStatus === "issue";

  return (
    <div className="flex items-center gap-2">
      {STATUS_STEPS.map((step, i) => {
        const isCompleted = !isIssue && i <= currentIndex;
        const isCurrent = !isIssue && i === currentIndex;
        const Icon = step.icon;

        return (
          <div key={step.key} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isCompleted
                  ? isCurrent
                    ? "bg-primary text-primary-foreground"
                    : "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {step.label}
            </div>
            {i < STATUS_STEPS.length - 1 && (
              <div
                className={`h-0.5 w-8 ${!isIssue && i < currentIndex ? "bg-primary" : "bg-muted"}`}
              />
            )}
          </div>
        );
      })}
      {isIssue && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
          Issue
        </div>
      )}
    </div>
  );
}

function ItemCheckInRow({
  item,
  isCheckingIn,
  onCheckIn,
}: {
  item: WarehouseInboundItem;
  isCheckingIn: boolean;
  onCheckIn: (
    itemId: string,
    receivedQty: number,
    conditionNotes: string,
    locationId?: string,
  ) => void;
}) {
  const [receivedQty, setReceivedQty] = useState(
    item.received_quantity?.toString() ?? item.expected_quantity.toString(),
  );
  const [conditionNotes, setConditionNotes] = useState(item.condition_notes ?? "");
  const isChecked = item.received_quantity !== null;
  const hasDiscrepancy = isChecked && item.received_quantity !== item.expected_quantity;

  return (
    <tr className={`border-b ${hasDiscrepancy ? "bg-yellow-50" : ""}`}>
      <td className="p-3 font-mono text-xs">{item.sku}</td>
      <td className="p-3">{item.expected_quantity}</td>
      <td className="p-3">
        {isCheckingIn && !isChecked ? (
          <Input
            type="number"
            min={0}
            value={receivedQty}
            onChange={(e) => setReceivedQty(e.target.value)}
            className="w-20 h-8"
          />
        ) : (
          <span className={hasDiscrepancy ? "text-yellow-700 font-medium" : ""}>
            {item.received_quantity ?? "—"}
          </span>
        )}
      </td>
      <td className="p-3">
        {isCheckingIn && !isChecked ? (
          <Textarea
            value={conditionNotes}
            onChange={(e) => setConditionNotes(e.target.value)}
            placeholder="Condition notes..."
            className="h-8 min-h-[2rem] text-sm"
          />
        ) : (
          item.condition_notes || "—"
        )}
      </td>
      <td className="p-3">{item.location_id ? item.location_id.slice(0, 8) : "—"}</td>
      <td className="p-3">
        {isCheckingIn && !isChecked && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onCheckIn(item.id, Number.parseInt(receivedQty, 10) || 0, conditionNotes)
            }
          >
            <Check className="h-3.5 w-3.5 mr-1" />
            Confirm
          </Button>
        )}
        {isChecked && (
          <span className="text-green-600 text-xs font-medium flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Done
          </span>
        )}
      </td>
    </tr>
  );
}

export default function InboundDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const {
    data: detail,
    isLoading,
    refetch,
  } = useAppQuery<InboundDetailResult>({
    queryKey: queryKeys.inbound.detail(params.id),
    queryFn: () => getInboundDetail(params.id),
    tier: CACHE_TIERS.REALTIME,
  });

  const markArrivedMutation = useAppMutation({
    mutationFn: () => markArrived(params.id),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  const beginCheckInMutation = useAppMutation({
    mutationFn: () => beginCheckIn(params.id),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  const checkInItemMutation = useAppMutation({
    mutationFn: (input: {
      itemId: string;
      receivedQty: number;
      conditionNotes: string;
      locationId?: string;
    }) =>
      checkInItem({
        itemId: input.itemId,
        receivedQty: input.receivedQty,
        conditionNotes: input.conditionNotes,
        locationId: input.locationId,
      }),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  const completeCheckInMutation = useAppMutation({
    mutationFn: () => completeCheckIn(params.id),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Shipment not found.</p>
      </div>
    );
  }

  const allCheckedIn = detail.items.every((item) => item.received_quantity !== null);

  return (
    <div className="p-6 space-y-6">
      {/* Back nav */}
      <button
        type="button"
        onClick={() => router.push("/admin/inbound")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Inbound
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Package className="h-6 w-6" />
            {detail.tracking_number || "No Tracking Number"}
          </h1>
          <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
            <span>Carrier: {detail.carrier || "—"}</span>
            <span>Org: {detail.org_name || "—"}</span>
            <span>
              Expected:{" "}
              {detail.expected_date ? new Date(detail.expected_date).toLocaleDateString() : "—"}
            </span>
            {detail.actual_arrival_date && (
              <span>Arrived: {new Date(detail.actual_arrival_date).toLocaleDateString()}</span>
            )}
          </div>
          {detail.notes && <p className="mt-2 text-sm bg-muted/50 rounded p-2">{detail.notes}</p>}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {detail.status === "expected" && (
            <Button
              onClick={() => markArrivedMutation.mutate()}
              disabled={markArrivedMutation.isPending}
            >
              <Truck className="h-4 w-4 mr-2" />
              Mark Arrived
            </Button>
          )}
          {detail.status === "arrived" && (
            <Button
              onClick={() => beginCheckInMutation.mutate()}
              disabled={beginCheckInMutation.isPending}
            >
              <CircleDot className="h-4 w-4 mr-2" />
              Begin Check-in
            </Button>
          )}
          {detail.status === "checking_in" && allCheckedIn && (
            <Button
              onClick={() => completeCheckInMutation.mutate()}
              disabled={completeCheckInMutation.isPending}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Complete Check-in
            </Button>
          )}
        </div>
      </div>

      {/* Status Progression */}
      <StatusProgressBar currentStatus={detail.status} />

      {/* Items Table */}
      <div>
        <h2 className="text-lg font-medium mb-3">Items ({detail.items.length})</h2>
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">SKU</th>
                <th className="text-left p-3 font-medium">Expected Qty</th>
                <th className="text-left p-3 font-medium">Received Qty</th>
                <th className="text-left p-3 font-medium">Condition Notes</th>
                <th className="text-left p-3 font-medium">Location</th>
                <th className="text-left p-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item) => (
                <ItemCheckInRow
                  key={item.id}
                  item={item}
                  isCheckingIn={detail.status === "checking_in"}
                  onCheckIn={(itemId, receivedQty, conditionNotes, locationId) =>
                    checkInItemMutation.mutate({ itemId, receivedQty, conditionNotes, locationId })
                  }
                />
              ))}
              {detail.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    No items in this shipment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
