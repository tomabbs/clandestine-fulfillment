"use client";

/**
 * Saturday Workstream 3 (2026-04-18) — count session UI panel.
 *
 * Renders inside the existing inventory page expanded-row detail (one panel
 * per SKU). Wraps the five Server Actions in src/actions/inventory-counts.ts:
 *
 *   - idle:               "Start count" button
 *   - count_in_progress:  status badge (started by + duration)
 *                         running sum-of-locations chip
 *                         per-location editable list
 *                         "+ Add location" typeahead with inline create
 *                         "Complete count" + "Cancel count" buttons
 *
 * Fanout suppression invariant (R-1 / Rule #76): per-location quantity edits
 * during count_in_progress hit setVariantLocationQuantity which DOES NOT call
 * recordInventoryChange. Only completeCountSession fires fanout — once.
 *
 * Locator typeahead: inline state-only filter against listLocations({activeOnly,
 * search}). When the typed query has no exact match, an "Add new ‹query›"
 * affordance calls createLocation() and selects the new row immediately.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  type CountSessionState,
  cancelCountSession,
  completeCountSession,
  getCountSessionState,
  setVariantLocationQuantity,
  startCountSession,
} from "@/actions/inventory-counts";
import { createLocation, listLocations } from "@/actions/locations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

interface Props {
  sku: string;
}

const sessionKey = (sku: string) => ["count-session", sku] as const;
const locationsKey = (search: string) => ["warehouse-locations-typeahead", search] as const;

export function InventoryCountSessionPanel({ sku }: Props) {
  // ─── State ────────────────────────────────────────────────────────────────

  const sessionQuery = useAppQuery<CountSessionState>({
    queryKey: sessionKey(sku),
    queryFn: () => getCountSessionState(sku),
    tier: CACHE_TIERS.REALTIME,
  });

  const startMutation = useAppMutation({
    mutationFn: () => startCountSession(sku),
    invalidateKeys: [sessionKey(sku)],
    onSuccess: () => toast.success("Count session started"),
    onError: (err) => toast.error(`Could not start count: ${(err as Error).message}`),
  });

  const completeMutation = useAppMutation({
    mutationFn: () => completeCountSession(sku),
    invalidateKeys: [sessionKey(sku), ["inventory-levels"]],
    onSuccess: (result) => {
      if (result.delta === 0) {
        toast.success("Count complete — no change to push");
      } else {
        toast.success(
          `Count complete — pushed delta ${result.delta > 0 ? `+${result.delta}` : result.delta}`,
        );
      }
    },
    onError: (err) => toast.error(`Could not complete count: ${(err as Error).message}`),
  });

  const cancelMutation = useAppMutation({
    mutationFn: (rollback: boolean) =>
      cancelCountSession(sku, { rollbackLocationEntries: rollback }),
    invalidateKeys: [sessionKey(sku)],
    onSuccess: (result) => {
      toast.info(
        result.rolledBackRows > 0
          ? `Cancelled — discarded ${result.rolledBackRows} draft row(s)`
          : "Cancelled — draft entries kept",
      );
    },
    onError: (err) => toast.error(`Could not cancel: ${(err as Error).message}`),
  });

  const setQtyMutation = useAppMutation({
    mutationFn: (vars: { locationId: string; quantity: number }) =>
      setVariantLocationQuantity({ sku, locationId: vars.locationId, quantity: vars.quantity }),
    invalidateKeys: [sessionKey(sku)],
    onError: (err) => toast.error(`Save failed: ${(err as Error).message}`),
  });

  const session = sessionQuery.data;

  // ─── Render ───────────────────────────────────────────────────────────────

  if (sessionQuery.isLoading) {
    return <Skeleton className="col-span-2 h-24 w-full" />;
  }
  if (sessionQuery.error) {
    return (
      <div className="col-span-2 rounded border bg-card p-4 text-sm text-destructive">
        Could not load count session state: {(sessionQuery.error as Error).message}
      </div>
    );
  }
  if (!session) return null;

  const isInProgress = session.status === "count_in_progress";

  return (
    <div className="col-span-2 mb-4 rounded border bg-card p-4">
      {!isInProgress ? (
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium">Per-location count</p>
            <p className="text-muted-foreground">
              Start a count session to enter per-location quantities. Fanout to Bandcamp / Shopify /
              ShipStation is suppressed until you complete the count.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
          >
            {startMutation.isPending ? "Starting…" : "Start count"}
          </Button>
        </div>
      ) : (
        <CountSessionBody
          sku={sku}
          session={session}
          onSetQty={(locationId, quantity) => setQtyMutation.mutate({ locationId, quantity })}
          onComplete={() => completeMutation.mutate()}
          onCancel={(rollback) => cancelMutation.mutate(rollback)}
          completePending={completeMutation.isPending}
          cancelPending={cancelMutation.isPending}
          setQtyPending={setQtyMutation.isPending}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner: in-progress UI body
// ─────────────────────────────────────────────────────────────────────────────

interface BodyProps {
  sku: string;
  session: CountSessionState;
  onSetQty: (locationId: string, quantity: number) => void;
  onComplete: () => void;
  onCancel: (rollback: boolean) => void;
  completePending: boolean;
  cancelPending: boolean;
  setQtyPending: boolean;
}

function CountSessionBody({
  sku,
  session,
  onSetQty,
  onComplete,
  onCancel,
  completePending,
  cancelPending,
  setQtyPending,
}: BodyProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const elapsed = useMemo(() => {
    if (!session.startedAt) return null;
    const ms = Date.now() - new Date(session.startedAt).getTime();
    const min = Math.floor(ms / 60_000);
    return min < 1 ? "<1 min" : `${min} min`;
  }, [session.startedAt]);

  const drift = session.sumOfLocations - session.currentAvailable;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default">Count in progress</Badge>
        <span className="text-muted-foreground text-xs">
          {session.startedBy?.name ?? "unknown"} · {elapsed ?? "?"}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          <Badge variant="secondary">Sum: {session.sumOfLocations}</Badge>
          <Badge variant="outline">Current avail: {session.currentAvailable}</Badge>
          <Badge variant={drift === 0 ? "outline" : drift > 0 ? "default" : "destructive"}>
            Δ {drift > 0 ? `+${drift}` : drift}
          </Badge>
        </span>
      </div>

      <CountLocationList session={session} onSetQty={onSetQty} setQtyPending={setQtyPending} />

      <AddLocationRow sku={sku} onSetQty={onSetQty} />

      <div className="flex items-center justify-end gap-2 pt-2">
        {confirmCancel ? (
          <div className="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            <span>Cancel count?</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCancel(false)}
              disabled={cancelPending}
            >
              Keep entries
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onCancel(true)}
              disabled={cancelPending}
            >
              Discard entries
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmCancel(false)}
              disabled={cancelPending}
            >
              Back
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmCancel(true)}
            disabled={cancelPending || completePending}
          >
            Cancel count
          </Button>
        )}
        <Button size="sm" onClick={onComplete} disabled={completePending}>
          {completePending ? "Completing…" : "Complete count"}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner: per-location editable list with debounced save
// ─────────────────────────────────────────────────────────────────────────────

function CountLocationList({
  session,
  onSetQty,
  setQtyPending,
}: {
  session: CountSessionState;
  onSetQty: (locationId: string, quantity: number) => void;
  setQtyPending: boolean;
}) {
  if (session.locations.length === 0) {
    return (
      <p className="text-muted-foreground text-sm italic">
        No per-location entries yet. Add a location below to begin counting.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {session.locations.map((loc) => (
        <li
          key={loc.locationId}
          className="grid grid-cols-[1fr_auto] items-center gap-2 rounded px-2 py-1 hover:bg-muted/40"
        >
          <span className="text-sm">
            <span className="font-mono">{loc.locationName}</span>{" "}
            <span className="text-muted-foreground text-xs">({loc.locationType})</span>
          </span>
          <QtyInput
            initialValue={loc.quantity}
            disabled={setQtyPending}
            onCommit={(n) => onSetQty(loc.locationId, n)}
          />
        </li>
      ))}
    </ul>
  );
}

function QtyInput({
  initialValue,
  disabled,
  onCommit,
}: {
  initialValue: number;
  disabled: boolean;
  onCommit: (n: number) => void;
}) {
  const [value, setValue] = useState(String(initialValue));

  const commit = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      setValue(String(initialValue));
      toast.error("Quantity must be a non-negative integer");
      return;
    }
    if (n === initialValue) return;
    onCommit(n);
  };

  return (
    <Input
      type="number"
      min={0}
      step={1}
      className="h-8 w-20 text-right font-mono"
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner: locator typeahead with inline create
// ─────────────────────────────────────────────────────────────────────────────

function AddLocationRow({
  sku: _sku,
  onSetQty,
}: {
  sku: string;
  onSetQty: (locationId: string, quantity: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [pendingQty, setPendingQty] = useState("0");

  const trimmed = search.trim();
  const locationsQuery = useAppQuery({
    queryKey: locationsKey(trimmed),
    queryFn: () => listLocations({ activeOnly: true, search: trimmed || undefined }),
    tier: CACHE_TIERS.REALTIME,
    enabled: trimmed.length > 0,
  });

  const matches = locationsQuery.data ?? [];
  const exactMatch = matches.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());

  const createMutation = useAppMutation({
    mutationFn: () => createLocation({ name: trimmed, locationType: "shelf" }),
    invalidateKeys: [locationsKey(trimmed)],
    onSuccess: (result) => {
      if (result.warning === "shipstation_mirror_failed") {
        toast.warning("Created locally — ShipStation mirror failed (Retry from Locations page)");
      } else if (result.warning === "shipstation_mirror_resolved_existing") {
        toast.info("Used existing ShipStation location with the same name");
      } else if (result.warning === "no_v2_warehouse_configured") {
        toast.info("Created locally — no ShipStation v2 warehouse configured");
      } else {
        toast.success("Location created");
      }
      const qty = Number(pendingQty) || 0;
      if (qty < 0) {
        toast.error("Quantity must be ≥ 0");
        return;
      }
      onSetQty(result.row.id, qty);
      setSearch("");
      setPendingQty("0");
    },
    onError: (err) => toast.error(`Create failed: ${(err as Error).message}`),
  });

  const pickExisting = (locationId: string) => {
    const qty = Number(pendingQty) || 0;
    if (qty < 0 || !Number.isInteger(qty)) {
      toast.error("Quantity must be a non-negative integer");
      return;
    }
    onSetQty(locationId, qty);
    setSearch("");
    setPendingQty("0");
  };

  return (
    <div className="space-y-2 rounded border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-48"
          placeholder="Search or enter new location name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Input
          type="number"
          min={0}
          step={1}
          className="h-8 w-20 text-right font-mono"
          value={pendingQty}
          onChange={(e) => setPendingQty(e.target.value)}
          aria-label="Quantity at new location"
        />
        {trimmed && !exactMatch ? (
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating…" : `Create "${trimmed}"`}
          </Button>
        ) : null}
      </div>
      {trimmed && matches.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {matches.slice(0, 8).map((l) => (
            <li
              key={l.id}
              className="flex cursor-pointer items-center justify-between rounded px-2 py-1 hover:bg-muted/60"
            >
              <button
                type="button"
                onClick={() => pickExisting(l.id)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="font-mono">{l.name}</span>
                <span className="text-muted-foreground text-xs">
                  ({l.location_type}){!l.shipstation_inventory_location_id && " · not synced"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
