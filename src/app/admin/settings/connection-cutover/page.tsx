"use client";

/**
 * Phase 3 Pass 2 D5 — Direct-Shopify cutover wizard.
 *
 * Operator surface for the per-connection cutover state machine:
 *   1. Pick a `client_store_connections` row.
 *   2. Inspect 7-day shadow-mode diagnostics (match-rate, drift samples,
 *      comparison skip breakdown).
 *   3. Drive the state machine via three actions:
 *        legacy → shadow      `startConnectionShadowMode`
 *        shadow → direct      `runConnectionCutover`
 *        any    → legacy      `rollbackConnectionCutover`
 *
 * The page is intentionally workspace-scoped via `getStoreConnections`
 * (the action enforces staff auth and falls back to the operator's
 * workspace_id when no filter is supplied). RLS on `connection_shadow_log`
 * + `client_store_connections` provides the secondary defense.
 *
 * UX guard rails:
 *   - The "Cutover to direct" button is disabled unless `gate.eligible`
 *     is true, with the gate failure reason rendered next to the button.
 *   - The forced override is hidden behind a checkbox + free-text reason
 *     (matches the `runConnectionCutover` Server Action contract — empty
 *     reason returns `force_missing_reason`).
 *   - The rollback button always requires a reason; we surface the same
 *     control for shadow→legacy and direct→legacy so operators can
 *     abandon a cutover at either stage without context-switching.
 */

import { AlertTriangle, ArrowRightLeft, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  type ConnectionCutoverDiagnostics,
  getCutoverDiagnostics,
  type RunConnectionCutoverResult,
  rollbackConnectionCutover,
  runConnectionCutover,
  startConnectionShadowMode,
} from "@/actions/connection-cutover";
import { getStoreConnections } from "@/actions/store-connections";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import type { ClientStoreConnection, CutoverState } from "@/lib/shared/types";

type ConnectionListItem = ClientStoreConnection & {
  org_name: string;
  sku_mapping_count: number;
};

const STATE_BADGE_VARIANT: Record<CutoverState, "secondary" | "default" | "outline"> = {
  legacy: "outline",
  shadow: "secondary",
  direct: "default",
};

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export default function ConnectionCutoverPage() {
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [forceCutover, setForceCutover] = useState(false);
  const [forceReason, setForceReason] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [shadowToleranceInput, setShadowToleranceInput] = useState<string>("");

  const connectionsQuery = useAppQuery<{ connections: ConnectionListItem[] }>({
    queryKey: ["admin", "connection-cutover", "connections"],
    queryFn: () => getStoreConnections(),
    tier: CACHE_TIERS.SESSION,
  });

  const diagnosticsQuery = useAppQuery<ConnectionCutoverDiagnostics>({
    queryKey: ["admin", "connection-cutover", "diagnostics", selectedConnectionId ?? ""],
    queryFn: () => getCutoverDiagnostics({ connectionId: selectedConnectionId as string }),
    enabled: !!selectedConnectionId,
    tier: CACHE_TIERS.REALTIME,
  });

  const refetchAll = async () => {
    await Promise.all([connectionsQuery.refetch(), diagnosticsQuery.refetch()]);
  };

  const startShadowMut = useAppMutation({
    mutationFn: () => {
      const tolerance = shadowToleranceInput.trim();
      const parsed = tolerance.length > 0 ? Number.parseInt(tolerance, 10) : null;
      return startConnectionShadowMode({
        connectionId: selectedConnectionId as string,
        shadowWindowToleranceSeconds: parsed,
      });
    },
    onSuccess: refetchAll,
  });

  const runCutoverMut = useAppMutation<RunConnectionCutoverResult, Error, void>({
    mutationFn: () =>
      runConnectionCutover({
        connectionId: selectedConnectionId as string,
        force: forceCutover,
        forceReason: forceCutover ? forceReason : null,
      }),
    onSuccess: refetchAll,
  });

  const rollbackMut = useAppMutation({
    mutationFn: () =>
      rollbackConnectionCutover({
        connectionId: selectedConnectionId as string,
        reason: rollbackReason,
      }),
    onSuccess: () => {
      setRollbackReason("");
      return refetchAll();
    },
  });

  const connections = connectionsQuery.data?.connections ?? [];
  const diagnostics = diagnosticsQuery.data;
  const selectedConnection = connections.find((c) => c.id === selectedConnectionId) ?? null;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Direct-Shopify cutover</h1>
        <p className="text-sm text-muted-foreground">
          Phase 3 Pass 2: per-connection cutover wizard. Promotes a connection from{" "}
          <code>legacy</code> (SS-mirror owns inventory) → <code>shadow</code> (we push directly AND
          SS still mirrors) → <code>direct</code> (we own the writes; SS becomes label-only). Each
          transition is gated; review the diagnostics block before flipping.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pick a connection</CardTitle>
          <CardDescription>
            Workspace-scoped list of all <code>client_store_connections</code>. Status badge shows
            current cutover state.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="connection-picker">Connection</Label>
            <Select
              value={selectedConnectionId ?? undefined}
              onValueChange={(value) => {
                setSelectedConnectionId(value);
                setForceCutover(false);
                setForceReason("");
                setRollbackReason("");
                setShadowToleranceInput("");
              }}
            >
              <SelectTrigger id="connection-picker" className="w-full">
                <SelectValue placeholder="Select a store connection..." />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="font-mono text-xs mr-2">[{c.platform}]</span>
                    {c.org_name} — {c.store_url ?? "(no store url)"} ·{" "}
                    <span className="opacity-70">{c.cutover_state ?? "legacy"}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedConnection && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Badge variant={STATE_BADGE_VARIANT[selectedConnection.cutover_state ?? "legacy"]}>
                cutover_state: {selectedConnection.cutover_state ?? "legacy"}
              </Badge>
              <Badge variant="outline">platform: {selectedConnection.platform}</Badge>
              <Badge variant="outline">
                do_not_fanout: {String(selectedConnection.do_not_fanout ?? false)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Started {formatRelative(selectedConnection.cutover_started_at)} · Completed{" "}
                {formatRelative(selectedConnection.cutover_completed_at)}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedConnectionId && (
        <Card>
          <CardHeader>
            <CardTitle>7-day shadow-mode diagnostics</CardTitle>
            <CardDescription>
              Refreshes from <code>connection_shadow_log</code>. Cutover gate requires match_rate ≥
              99.5% across ≥ 50 resolved comparisons.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {diagnosticsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading diagnostics...
              </p>
            ) : diagnostics ? (
              <DiagnosticsPanel diagnostics={diagnostics} />
            ) : (
              <EmptyState
                title="No diagnostics available"
                description="Try refreshing or pick another connection."
              />
            )}
          </CardContent>
        </Card>
      )}

      {selectedConnectionId && (
        <Card>
          <CardHeader>
            <CardTitle>State transitions</CardTitle>
            <CardDescription>
              All transitions are gated. Forced cutover requires a reason and is recorded on the
              echo override metadata for audit.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* legacy → shadow */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">1. Start shadow mode</h3>
              <p className="text-xs text-muted-foreground">
                Begin logging direct pushes to <code>connection_shadow_log</code> for 7-day
                comparison.
              </p>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="shadow-tolerance" className="text-xs">
                    Window tolerance (s, optional, 30–600)
                  </Label>
                  <Input
                    id="shadow-tolerance"
                    type="number"
                    min={30}
                    max={600}
                    placeholder="60 (default)"
                    value={shadowToleranceInput}
                    onChange={(e) => setShadowToleranceInput(e.target.value)}
                    className="w-48"
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={() => startShadowMut.mutate()}
                  disabled={
                    startShadowMut.isPending || diagnostics?.connection.cutover_state !== "legacy"
                  }
                >
                  {startShadowMut.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Start shadow mode
                </Button>
              </div>
              {startShadowMut.error ? (
                <p className="text-xs text-red-600">{startShadowMut.error.message}</p>
              ) : null}
            </div>

            {/* shadow → direct */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">2. Cutover to direct</h3>
              <p className="text-xs text-muted-foreground">
                Inserts a <code>connection_echo_overrides</code> row first, then flips{" "}
                <code>cutover_state=direct</code>. Order matters — see{" "}
                <code>runConnectionCutover</code> for the crash-safety contract.
              </p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={forceCutover}
                    onChange={(e) => setForceCutover(e.target.checked)}
                  />
                  <ShieldAlert className="h-3 w-3 text-amber-600" />
                  Force (bypass diagnostics gate — requires reason ≥ 8 chars)
                </label>
                {forceCutover && (
                  <Textarea
                    placeholder="Why is the diagnostics gate being bypassed? (audit-logged)"
                    value={forceReason}
                    onChange={(e) => setForceReason(e.target.value)}
                    rows={2}
                  />
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => runCutoverMut.mutate()}
                  disabled={
                    runCutoverMut.isPending ||
                    diagnostics?.connection.cutover_state !== "shadow" ||
                    (!forceCutover && !diagnostics?.gate.eligible) ||
                    (forceCutover && forceReason.trim().length < 8)
                  }
                >
                  {runCutoverMut.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRightLeft className="mr-2 h-4 w-4" />
                  )}
                  Cutover to direct
                </Button>
                {diagnostics &&
                  diagnostics.connection.cutover_state === "shadow" &&
                  !diagnostics.gate.eligible &&
                  !forceCutover && (
                    <span className="text-xs text-amber-600 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Gate: {diagnostics.gate.gate_reason}
                    </span>
                  )}
              </div>
              {runCutoverMut.error ? (
                <p className="text-xs text-red-600">{runCutoverMut.error.message}</p>
              ) : null}
              {runCutoverMut.data?.status === "blocked" ? (
                <p className="text-xs text-red-600">Blocked: {runCutoverMut.data.blockedReason}</p>
              ) : null}
              {runCutoverMut.data?.status === "ok" ? (
                <p className="text-xs text-green-600">
                  Cutover complete at {formatRelative(runCutoverMut.data.cutoverCompletedAt)}{" "}
                  (override id <code>{runCutoverMut.data.echoOverrideId}</code>).
                </p>
              ) : null}
            </div>

            {/* any → legacy */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">3. Rollback to legacy</h3>
              <p className="text-xs text-muted-foreground">
                Deactivates active echo override and reverts <code>cutover_state=legacy</code>.
                Shadow log rows are preserved for historical analysis.
              </p>
              <Textarea
                placeholder="Why are we rolling back? (audit-logged, ≥ 8 chars)"
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                rows={2}
              />
              <Button
                variant="destructive"
                onClick={() => rollbackMut.mutate()}
                disabled={
                  rollbackMut.isPending ||
                  rollbackReason.trim().length < 8 ||
                  diagnostics?.connection.cutover_state === "legacy"
                }
              >
                {rollbackMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-2 h-4 w-4" />
                )}
                Rollback to legacy
              </Button>
              {rollbackMut.error ? (
                <p className="text-xs text-red-600">{rollbackMut.error.message}</p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: ConnectionCutoverDiagnostics }) {
  const { counters, gate, recent_drift_samples, comparison_skip_breakdown, window } = diagnostics;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Match rate" value={formatPercent(counters.match_rate)} />
        <Metric label="Resolved" value={String(counters.resolved)} />
        <Metric label="Matched" value={String(counters.matched)} />
        <Metric label="Drifted" value={String(counters.drifted)} danger={counters.drifted > 0} />
        <Metric label="Unresolved" value={String(counters.unresolved)} />
        <Metric
          label="Comparison skipped"
          value={String(counters.comparison_skipped)}
          danger={counters.comparison_skipped > 0}
        />
        <Metric label="Total |drift| units" value={String(counters.total_abs_drift_units)} />
        <Metric
          label="Max |drift|"
          value={String(counters.max_abs_drift_units)}
          danger={counters.max_abs_drift_units > 5}
        />
      </div>

      <div className="rounded border bg-muted/30 p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Gate:</span>
          {gate.eligible ? (
            <Badge variant="default">eligible</Badge>
          ) : (
            <Badge variant="destructive">{gate.gate_reason}</Badge>
          )}
          <span className="text-muted-foreground">
            (≥ {(gate.required_match_rate * 100).toFixed(1)}% match across ≥{" "}
            {gate.required_min_samples} resolved samples)
          </span>
        </div>
        <p className="text-muted-foreground mt-1">
          Window: {formatRelative(window.starts_at)} → {formatRelative(window.ends_at)} (
          {window.days} days).
        </p>
      </div>

      {Object.keys(comparison_skip_breakdown).length > 0 && (
        <div className="rounded border p-3 text-xs">
          <p className="font-semibold mb-2">Comparison skip breakdown</p>
          <ul className="space-y-1">
            {Object.entries(comparison_skip_breakdown).map(([reason, count]) => (
              <li key={reason} className="font-mono">
                {reason}: {count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recent_drift_samples.length > 0 && (
        <div className="rounded border p-3 text-xs">
          <p className="font-semibold mb-2">Recent drift samples (max 25)</p>
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pr-2">SKU</th>
                <th className="pr-2">Pushed</th>
                <th className="pr-2">SS observed</th>
                <th className="pr-2">Drift</th>
                <th>Pushed at</th>
              </tr>
            </thead>
            <tbody>
              {recent_drift_samples.map((s) => (
                <tr key={s.shadow_log_id} className="font-mono">
                  <td className="pr-2">{s.sku}</td>
                  <td className="pr-2">{s.pushed_quantity}</td>
                  <td className="pr-2">{s.ss_observed_quantity ?? "—"}</td>
                  <td className="pr-2 text-amber-600">{s.drift_units ?? "—"}</td>
                  <td>{formatRelative(s.pushed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-mono ${danger ? "text-red-600 font-semibold" : ""}`}>{value}</p>
    </div>
  );
}
