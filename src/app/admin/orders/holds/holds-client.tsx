"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ListOrderHoldsResult,
  listOrderHolds,
  type OrderHoldListRow,
  type ReleaseOrderHoldsBulkResult,
  releaseOrderHold,
  releaseOrderHoldsBulk,
} from "@/actions/order-holds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// Phase 6 Slice 6.D — client surface for /admin/orders/holds. Groups the
// on_hold queue by `fulfillment_hold_reason`, offers per-row release +
// bulk release, and enforces the staff_override note rule client-side so
// the UI surfaces the error before the Server Action round-trips.

type ReasonFilter =
  | "all"
  | "unknown_remote_sku"
  | "placeholder_remote_sku"
  | "non_warehouse_match"
  | "fetch_incomplete_at_match";

type ResolutionCode = "staff_override" | "alias_learned" | "manual_sku_fix" | "order_cancelled";

const PAGE_SIZE = 50;

const RESOLUTION_LABELS: Record<ResolutionCode, string> = {
  staff_override: "Staff override (requires note)",
  alias_learned: "Alias learned",
  manual_sku_fix: "Manual SKU fix",
  order_cancelled: "Order cancelled",
};

export function HoldsClient({ bootstrap }: { bootstrap: ListOrderHoldsResult }) {
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("all");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [releaseTarget, setReleaseTarget] = useState<
    { mode: "single"; order: OrderHoldListRow } | { mode: "bulk"; orderIds: string[] } | null
  >(null);
  const [resolutionCode, setResolutionCode] = useState<ResolutionCode>("alias_learned");
  const [note, setNote] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<ReleaseOrderHoldsBulkResult | null>(null);

  const listQuery = useAppQuery<ListOrderHoldsResult, Error>({
    queryKey: ["admin", "order-holds", "list", reasonFilter, offset],
    queryFn: () =>
      listOrderHolds({
        reason: reasonFilter === "all" ? undefined : reasonFilter,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: bootstrap,
    tier: CACHE_TIERS.REALTIME,
  });

  const singleReleaseMut = useAppMutation({
    mutationFn: releaseOrderHold,
    onSuccess: (res) => {
      if (res.ok) {
        setReleaseTarget(null);
        setNote("");
        setErrorText(null);
        listQuery.refetch();
      } else {
        setErrorText(`${res.reason}${res.detail ? `: ${res.detail}` : ""}`);
      }
    },
    onError: (err) => setErrorText(err instanceof Error ? err.message : String(err)),
  });

  const bulkReleaseMut = useAppMutation({
    mutationFn: releaseOrderHoldsBulk,
    onSuccess: (res) => {
      setBulkResult(res);
      setSelected(new Set());
      listQuery.refetch();
    },
    onError: (err) => setErrorText(err instanceof Error ? err.message : String(err)),
  });

  const rows = listQuery.data?.rows ?? bootstrap.rows;
  const total = listQuery.data?.total ?? bootstrap.total;

  const groupedByReason = useMemo(() => {
    const grouped = new Map<string, OrderHoldListRow[]>();
    for (const row of rows) {
      const key = row.fulfillment_hold_reason ?? "unknown";
      const arr = grouped.get(key) ?? [];
      arr.push(row);
      grouped.set(key, arr);
    }
    return Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [rows]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function openRelease(target: typeof releaseTarget) {
    setReleaseTarget(target);
    setResolutionCode("alias_learned");
    setNote("");
    setErrorText(null);
  }

  function submitRelease() {
    if (!releaseTarget) return;
    const trimmedNote = note.trim();
    if (resolutionCode === "staff_override" && trimmedNote.length === 0) {
      setErrorText("staff_override requires a note");
      return;
    }
    setErrorText(null);
    if (releaseTarget.mode === "single") {
      singleReleaseMut.mutate({
        orderId: releaseTarget.order.id,
        resolutionCode,
        note: trimmedNote.length > 0 ? trimmedNote : null,
      });
    } else {
      bulkReleaseMut.mutate({
        orderIds: releaseTarget.orderIds,
        resolutionCode,
        note: trimmedNote.length > 0 ? trimmedNote : null,
      });
      setReleaseTarget(null);
    }
  }

  return (
    <div className="max-w-7xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Order fulfillment holds</h1>
        <p className="text-sm text-muted-foreground">
          Orders placed on hold by the autonomous SKU matcher, webhook ingress, or hold evaluator.
          Releasing a hold writes a{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">hold_released</code> event and
          lets the order flow to pick/pack + ShipStation export.
        </p>
      </div>

      {bulkResult ? (
        <Card>
          <CardHeader>
            <CardTitle>Bulk release result</CardTitle>
            <CardDescription>
              {bulkResult.succeeded.length} released · {bulkResult.failed.length} failed
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {bulkResult.failed.length > 0 ? (
              <details>
                <summary className="cursor-pointer text-destructive">View failures</summary>
                <ul className="mt-2 space-y-1 text-xs font-mono">
                  {bulkResult.failed.map((f) => (
                    <li key={f.orderId}>
                      {f.orderId} — {f.reason}
                      {f.detail ? ` (${f.detail})` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setBulkResult(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Held orders</CardTitle>
              <CardDescription>
                {total} orders currently on hold
                {listQuery.isFetching ? " · refreshing…" : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="space-y-1">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Hold reason
                </Label>
                <Select
                  value={reasonFilter}
                  onValueChange={(v) => {
                    setReasonFilter((v ?? "all") as ReasonFilter);
                    setOffset(0);
                    setSelected(new Set());
                  }}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All reasons</SelectItem>
                    <SelectItem value="unknown_remote_sku">unknown_remote_sku</SelectItem>
                    <SelectItem value="placeholder_remote_sku">placeholder_remote_sku</SelectItem>
                    <SelectItem value="non_warehouse_match">non_warehouse_match</SelectItem>
                    <SelectItem value="fetch_incomplete_at_match">
                      fetch_incomplete_at_match
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                disabled={selected.size === 0 || bulkReleaseMut.isPending}
                onClick={() => openRelease({ mode: "bulk", orderIds: Array.from(selected) })}
              >
                {bulkReleaseMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Release {selected.size} selected
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {groupedByReason.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No orders are currently on hold for this workspace.
            </div>
          ) : (
            <div className="space-y-6">
              {groupedByReason.map(([reason, reasonRows]) => (
                <div key={reason}>
                  <div className="mb-2 flex items-center gap-2">
                    <Badge variant="secondary">{reason}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {reasonRows.length} order{reasonRows.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-muted-foreground">
                        <tr className="border-b bg-muted/40">
                          <th className="w-8 py-2 pl-3" />
                          <th className="py-2 pr-4 font-medium">Order #</th>
                          <th className="py-2 pr-4 font-medium">External ID</th>
                          <th className="py-2 pr-4 font-medium">Held at</th>
                          <th className="py-2 pr-4 font-medium">Alerted at</th>
                          <th className="py-2 pr-4 font-medium">Cycle</th>
                          <th className="py-2 pr-4 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reasonRows.map((row) => (
                          <tr key={row.id} className="border-b last:border-0">
                            <td className="w-8 py-2 pl-3">
                              <Checkbox
                                checked={selected.has(row.id)}
                                onCheckedChange={() => toggleSelect(row.id)}
                              />
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">
                              {row.order_number ?? "—"}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                              {row.external_order_id ?? "—"}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">
                              {row.fulfillment_hold_at
                                ? new Date(row.fulfillment_hold_at).toLocaleString()
                                : "—"}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">
                              {row.fulfillment_hold_client_alerted_at ? (
                                <span className="text-green-600">✓</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-4 font-mono text-[10px] text-muted-foreground">
                              {row.fulfillment_hold_cycle_id?.slice(0, 8) ?? "—"}
                            </td>
                            <td className="py-2 pr-4">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openRelease({ mode: "single", order: row })}
                              >
                                Release
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {total > 0 ? `Page ${Math.floor(offset / PAGE_SIZE) + 1}` : "—"}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || listQuery.isFetching}
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total || listQuery.isFetching}
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!releaseTarget} onOpenChange={(o) => !o && setReleaseTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {releaseTarget?.mode === "bulk"
                ? `Release ${releaseTarget.orderIds.length} holds`
                : "Release hold"}
            </DialogTitle>
            <DialogDescription>
              {releaseTarget?.mode === "single" && releaseTarget.order.order_number
                ? `Order ${releaseTarget.order.order_number} currently held.`
                : null}
              {releaseTarget?.mode === "bulk"
                ? "Bulk releases apply the same resolution code and note to every selected order."
                : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Resolution code</Label>
              <Select
                value={resolutionCode}
                onValueChange={(v) => setResolutionCode((v ?? "alias_learned") as ResolutionCode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(RESOLUTION_LABELS) as ResolutionCode[]).map((code) => (
                    <SelectItem key={code} value={code}>
                      {RESOLUTION_LABELS[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>
                Note{resolutionCode === "staff_override" ? " (required)" : " (optional)"}
              </Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  resolutionCode === "staff_override"
                    ? "Why is this override justified?"
                    : "Optional context for the audit trail"
                }
                rows={3}
              />
            </div>

            {errorText ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {errorText}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitRelease}
              disabled={singleReleaseMut.isPending || bulkReleaseMut.isPending}
            >
              {singleReleaseMut.isPending || bulkReleaseMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              Release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
