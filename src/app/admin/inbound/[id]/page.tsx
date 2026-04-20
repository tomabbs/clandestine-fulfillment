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
import { BlockList } from "@/components/shared/block-list";
import { CollaborativePage, PresenceBar } from "@/components/shared/collaborative-page";
import { EmptyState } from "@/components/shared/empty-state";
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

function ItemCheckInCard({
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
    <div
      className={`space-y-3 ${hasDiscrepancy ? "rounded-md border border-yellow-200 bg-yellow-50 p-2" : ""}`}
    >
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <div className="rounded-md border bg-background/60 p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">SKU</p>
          <p className="font-mono text-xs">{item.sku}</p>
        </div>
        <div className="rounded-md border bg-background/60 p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Expected Qty</p>
          <p>{item.expected_quantity}</p>
        </div>
        <div className="rounded-md border bg-background/60 p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Received Qty</p>
          {isCheckingIn && !isChecked ? (
            <Input
              type="number"
              min={0}
              value={receivedQty}
              onChange={(e) => setReceivedQty(e.target.value)}
              className="w-24 h-8 mt-1"
            />
          ) : (
            <p className={hasDiscrepancy ? "text-yellow-700 font-medium" : ""}>
              {item.received_quantity ?? "—"}
            </p>
          )}
        </div>
        <div className="rounded-md border bg-background/60 p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Location</p>
          <p>{item.location_id ? item.location_id.slice(0, 8) : "—"}</p>
        </div>
        <div className="rounded-md border bg-background/60 p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</p>
          {isChecked ? (
            <span className="text-green-600 text-xs font-medium flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Done
            </span>
          ) : (
            <p className="text-xs text-muted-foreground">Pending</p>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-background/60 p-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
          Condition Notes
        </p>
        {isCheckingIn && !isChecked ? (
          <Textarea
            value={conditionNotes}
            onChange={(e) => setConditionNotes(e.target.value)}
            placeholder="Condition notes..."
            className="h-8 min-h-[2rem] text-sm"
          />
        ) : (
          <p className="text-sm">{item.condition_notes || "—"}</p>
        )}
      </div>

      {isCheckingIn && !isChecked && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onCheckIn(item.id, Number.parseInt(receivedQty, 10) || 0, conditionNotes)}
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          Confirm
        </Button>
      )}
    </div>
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
    <CollaborativePage resourceType="inbound" resourceId={params.id}>
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
              <PresenceBar />
            </h1>
            <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
              <span>Carrier: {detail.carrier || "—"}</span>
              <span>Org: {detail.org_name || "—"}</span>
              <span>
                Expected:{" "}
                {detail.expected_date
                  ? new Date(`${detail.expected_date}T12:00:00`).toLocaleDateString()
                  : "—"}
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

        {/* Items */}
        <div>
          <h2 className="text-lg font-medium mb-3">Items ({detail.items.length})</h2>
          {detail.items.length === 0 ? (
            <EmptyState title="No items in this shipment" compact />
          ) : (
            <BlockList
              className="mt-2"
              items={detail.items}
              itemKey={(item) => item.id}
              density="ops"
              ariaLabel="Inbound shipment items"
              renderHeader={({ row: item }) => <p className="font-mono text-xs">{item.sku}</p>}
              renderBody={({ row: item }) => (
                <ItemCheckInCard
                  item={item}
                  isCheckingIn={detail.status === "checking_in"}
                  onCheckIn={(itemId, receivedQty, conditionNotes, locationId) =>
                    checkInItemMutation.mutate({
                      itemId,
                      receivedQty,
                      conditionNotes,
                      locationId,
                    })
                  }
                />
              )}
            />
          )}
        </div>
      </div>
    </CollaborativePage>
  );
}
