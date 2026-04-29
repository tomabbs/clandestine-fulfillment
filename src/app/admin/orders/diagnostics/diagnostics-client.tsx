"use client";

import { useState, useTransition } from "react";
import { enqueueIdentityBackfill } from "@/actions/order-identity-backfill";
import { enqueueMirrorLinksBridge } from "@/actions/order-mirror-links";
import { flipOrdersRouteMode, type OrdersRouteMode } from "@/actions/order-route-mode";
import type { OrderTransitionDiagnostics } from "@/actions/order-transition-diagnostics";
import { Button } from "@/components/ui/button";

interface Props {
  snapshot: OrderTransitionDiagnostics;
}

export function OrderTransitionDiagnosticsClient({ snapshot }: Props) {
  const [reason, setReason] = useState("");
  const [pendingMode, setPendingMode] = useState<OrdersRouteMode | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isBackfillPending, startBackfillTransition] = useTransition();
  const [isBridgePending, startBridgeTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const [bridgeMessage, setBridgeMessage] = useState<string | null>(null);

  function handleBackfill() {
    setBackfillMessage(null);
    startBackfillTransition(async () => {
      try {
        const result = await enqueueIdentityBackfill({});
        setBackfillMessage(`Backfill enqueued (run ${result.runId.slice(0, 8)}…).`);
      } catch (err) {
        setBackfillMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  function handleBridge() {
    setBridgeMessage(null);
    startBridgeTransition(async () => {
      try {
        const result = await enqueueMirrorLinksBridge({});
        setBridgeMessage(`Bridge enqueued (run ${result.runId.slice(0, 8)}…).`);
      } catch (err) {
        setBridgeMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  function handleFlip(mode: OrdersRouteMode) {
    setError(null);
    setSuccess(null);
    if (reason.trim().length < 8) {
      setError("Reason must be at least 8 characters.");
      return;
    }
    setPendingMode(mode);
    startTransition(async () => {
      try {
        const result = await flipOrdersRouteMode({ mode, reason: reason.trim() });
        setSuccess(
          `Route mode set to ${result.toMode}` +
            (result.fromMode ? ` (was ${result.fromMode}).` : "."),
        );
        setReason("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingMode(null);
      }
    });
  }

  return (
    <div className="space-y-6">
      <SnapshotGrid snapshot={snapshot} />
      <IdentityBackfillCard
        snapshot={snapshot}
        pending={isBackfillPending}
        message={backfillMessage}
        onBackfill={handleBackfill}
      />
      <MirrorLinksCard
        snapshot={snapshot}
        pending={isBridgePending}
        message={bridgeMessage}
        onRunBridge={handleBridge}
      />
      <RouteModeCard
        snapshot={snapshot}
        reason={reason}
        onReasonChange={setReason}
        onFlip={handleFlip}
        pending={isPending}
        pendingMode={pendingMode}
        error={error}
        success={success}
      />
      <p className="text-xs text-muted-foreground">
        Generated {new Date(snapshot.generatedAt).toLocaleString()}.
      </p>
    </div>
  );
}

function MirrorLinksCard({
  snapshot,
  pending,
  message,
  onRunBridge,
}: {
  snapshot: OrderTransitionDiagnostics;
  pending: boolean;
  message: string | null;
  onRunBridge: () => void;
}) {
  const total =
    snapshot.mirrorLinks.deterministic +
    snapshot.mirrorLinks.probable +
    snapshot.mirrorLinks.manual;
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">Mirror-links bridge</h2>
      <p className="mb-3 text-sm">
        Diagnostic-only bridge between Direct (warehouse_orders) and ShipStation Mirror
        (shipstation_orders). The bridge worker uses the pure <code>decideMirrorLink</code> helper
        to score candidate pairs by order_number / email / total / ship-window.
      </p>
      <div className="mb-3 grid grid-cols-1 gap-1 text-sm md:grid-cols-2">
        <Stat label="Linked orders (any confidence)" value={total} />
        <Stat label="Probable (needs review)" value={snapshot.mirrorLinks.probable} dim />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="default" disabled={pending} onClick={onRunBridge}>
          {pending ? "Enqueuing…" : "Run mirror-links bridge batch"}
        </Button>
      </div>
      {message ? <p className="mt-2 text-sm">{message}</p> : null}
    </div>
  );
}

function IdentityBackfillCard({
  snapshot,
  pending,
  message,
  onBackfill,
}: {
  snapshot: OrderTransitionDiagnostics;
  pending: boolean;
  message: string | null;
  onBackfill: () => void;
}) {
  const blocking =
    snapshot.counts.warehouseOrdersWithoutConnectionId > 0 ||
    snapshot.counts.warehouseOrdersAmbiguousIdentity > 0 ||
    snapshot.reviewQueue.openIdentityReviewItems > 0;
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">Identity v2 backfill</h2>
      <p className="mb-3 text-sm">
        Direct order rows missing <code>connection_id</code> can&apos;t use the v2 dedup index.
        Backfill resolves identity using the same pure resolver the live ingest path uses, then
        stamps <code>connection_id</code> + <code>ingestion_idempotency_key_v2</code>. Each run
        processes a batch and persists a cursor for resumability.
      </p>
      <div className="mb-3 grid grid-cols-1 gap-1 text-sm md:grid-cols-3">
        <Stat
          label="Without connection_id"
          value={snapshot.counts.warehouseOrdersWithoutConnectionId}
          warn={snapshot.counts.warehouseOrdersWithoutConnectionId > 0}
        />
        <Stat
          label="Ambiguous identity"
          value={snapshot.counts.warehouseOrdersAmbiguousIdentity}
          warn={snapshot.counts.warehouseOrdersAmbiguousIdentity > 0}
        />
        <Stat
          label="Open identity review queue"
          value={snapshot.reviewQueue.openIdentityReviewItems}
          warn={snapshot.reviewQueue.openIdentityReviewItems > 0}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="default" disabled={pending} onClick={onBackfill}>
          {pending ? "Enqueuing…" : "Run identity backfill batch"}
        </Button>
        {blocking ? (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Phase 1 release gate: identity issues remain. Run backfill or resolve review rows.
          </span>
        ) : (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            Identity v2 release gate clear.
          </span>
        )}
      </div>
      {message ? <p className="mt-2 text-sm">{message}</p> : null}
    </div>
  );
}

function SnapshotGrid({ snapshot }: { snapshot: OrderTransitionDiagnostics }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Direct (warehouse_orders)">
        <Stat label="Total" value={snapshot.counts.warehouseOrdersTotal} />
        <Stat label="Last 30 days" value={snapshot.counts.warehouseOrdersLast30d} />
        <Stat label="Last 90 days" value={snapshot.counts.warehouseOrdersLast90d} />
        <Stat
          label="Without connection_id (Phase 1)"
          value={snapshot.counts.warehouseOrdersWithoutConnectionId}
          dim
        />
        <Stat
          label="Ambiguous identity (Phase 1)"
          value={snapshot.counts.warehouseOrdersAmbiguousIdentity}
          dim
        />
      </Card>

      <Card title="ShipStation Mirror (shipstation_orders)">
        <Stat label="Total" value={snapshot.counts.shipstationOrdersTotal} />
        <Stat label="Last 30 days" value={snapshot.counts.shipstationOrdersLast30d} />
        <Stat label="Last 90 days" value={snapshot.counts.shipstationOrdersLast90d} />
      </Card>

      <Card title="Shipments by label source">
        <Stat label="Total" value={snapshot.shipments.total} />
        <Stat label="ShipStation" value={snapshot.shipments.bySource.shipstation} />
        <Stat label="EasyPost" value={snapshot.shipments.bySource.easypost} />
        <Stat label="Pirate Ship" value={snapshot.shipments.bySource.pirate_ship} />
        <Stat label="Manual" value={snapshot.shipments.bySource.manual} />
        <Stat label="Unknown" value={snapshot.shipments.bySource.unknown} dim />
        <Stat
          label="Pirate Ship potential mislinks (>180d skew)"
          value={snapshot.shipments.pirateShipPotentialMislinks}
          warn={snapshot.shipments.pirateShipPotentialMislinks > 0}
        />
      </Card>

      <Card title="Preorder parity (Phase 4a)">
        <Stat label="Direct preorder pending" value={snapshot.preorderPending.direct} />
        <Stat
          label="ShipStation Mirror preorder pending"
          value={snapshot.preorderPending.shipstationMirror}
        />
      </Card>

      <Card title="Writeback parity (Phase 5b)">
        <Stat label="Succeeded" value={snapshot.writebacks.succeeded} dim />
        <Stat
          label="Partial succeeded"
          value={snapshot.writebacks.partialSucceeded}
          warn={snapshot.writebacks.partialSucceeded > 0}
        />
        <Stat label="In progress" value={snapshot.writebacks.inProgress} dim />
        <Stat
          label="Failed retryable"
          value={snapshot.writebacks.failedRetryable}
          warn={snapshot.writebacks.failedRetryable > 0}
        />
        <Stat
          label="Failed terminal"
          value={snapshot.writebacks.failedTerminal}
          warn={snapshot.writebacks.failedTerminal > 0}
        />
        <Stat
          label="Blocked: missing identity"
          value={snapshot.writebacks.blockedMissingIdentity}
          warn={snapshot.writebacks.blockedMissingIdentity > 0}
        />
        <Stat
          label="Blocked: bandcamp generic"
          value={snapshot.writebacks.blockedBandcampGenericPath}
          warn={snapshot.writebacks.blockedBandcampGenericPath > 0}
        />
      </Card>

      <Card title="Hold parity (Phase 4b)">
        <Stat label="On hold" value={snapshot.holds.onHold} warn={snapshot.holds.onHold > 0} />
        <Stat label="Released" value={snapshot.holds.released} dim />
        <Stat label="Cancelled" value={snapshot.holds.cancelled} dim />
      </Card>

      <Card title="Mirror link confidence (Phase 2)">
        <Stat label="Deterministic" value={snapshot.mirrorLinks.deterministic} />
        <Stat label="Probable" value={snapshot.mirrorLinks.probable} />
        <Stat label="Manual" value={snapshot.mirrorLinks.manual} />
        <Stat label="Rejected" value={snapshot.mirrorLinks.rejected} dim />
      </Card>

      <Card title="Open review queue">
        <Stat label="Order route-mode flips" value={snapshot.reviewQueue.openOrderRouteFlips} />
        <Stat
          label="Identity review (Phase 1)"
          value={snapshot.reviewQueue.openIdentityReviewItems}
          dim
        />
        <Stat
          label="Pirate Ship potential mislinks"
          value={snapshot.reviewQueue.openPirateShipMislinkItems}
          warn={snapshot.reviewQueue.openPirateShipMislinkItems > 0}
        />
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">{title}</h2>
      <dl className="space-y-1.5 text-sm">{children}</dl>
    </div>
  );
}

function Stat({
  label,
  value,
  dim,
  warn,
}: {
  label: string;
  value: number;
  dim?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 ${
        dim ? "opacity-60" : warn ? "text-amber-700 dark:text-amber-400" : ""
      }`}
    >
      <dt>{label}</dt>
      <dd className="font-mono tabular-nums">{value.toLocaleString()}</dd>
    </div>
  );
}

function RouteModeCard({
  snapshot,
  reason,
  onReasonChange,
  onFlip,
  pending,
  pendingMode,
  error,
  success,
}: {
  snapshot: OrderTransitionDiagnostics;
  reason: string;
  onReasonChange: (next: string) => void;
  onFlip: (mode: OrdersRouteMode) => void;
  pending: boolean;
  pendingMode: OrdersRouteMode | null;
  error: string | null;
  success: string | null;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">Route mode (rollback)</h2>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span>
          Effective surface: <strong>{snapshot.effectiveSurface}</strong>
        </span>
        <span className="opacity-70">
          orders_route_mode: <code>{snapshot.routeMode ?? "(unset)"}</code>
        </span>
        <span className="opacity-70">
          legacy shipstation_unified_shipping:{" "}
          <code>{String(snapshot.legacyShipstationUnifiedShipping)}</code>
        </span>
      </div>
      <div className="space-y-3">
        <label className="block text-xs font-medium text-muted-foreground" htmlFor="reason">
          Reason for flip (≥ 8 chars, will be logged)
        </label>
        <textarea
          id="reason"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          rows={2}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="e.g. rolling back to mirror because direct list is missing late-arriving Bandcamp orders"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="default"
            disabled={pending}
            onClick={() => onFlip("direct")}
          >
            {pending && pendingMode === "direct" ? "Flipping…" : "Set to direct"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => onFlip("shipstation_mirror")}
          >
            {pending && pendingMode === "shipstation_mirror"
              ? "Flipping…"
              : "Set to shipstation_mirror (rollback)"}
          </Button>
        </div>
        {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        {success ? <p className="text-sm text-green-700 dark:text-green-400">{success}</p> : null}
        <p className="text-xs text-muted-foreground">
          Restricted to <code>super_admin</code> and <code>warehouse_manager</code>. Each flip
          inserts an audit row in <code>warehouse_review_queue</code> (category{" "}
          <code>order_route_mode_change</code>).
        </p>
      </div>
    </div>
  );
}
