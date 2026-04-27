"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  PauseCircle,
  ShieldAlert,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  type AutonomousRolloutHealth,
  createAutonomousCanaryReview,
  resolveAutonomousCanaryReview,
} from "@/actions/sku-autonomous-rollout";
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

// Phase 7 Slice 7.D — client surface for
// /admin/settings/sku-matching/rollout. Renders the aggregated rollout
// health snapshot from `getAutonomousRolloutHealth()` across five
// read-only panels (flags, emergency pause, telemetry, linkage, canary
// review) + two write actions (open canary review, resolve canary
// review). Every mutation uses `useTransition` + `router.refresh()` so
// the server render stays the source of truth after each write.

type IntendedFlag =
  | "sku_identity_autonomy_enabled"
  | "sku_live_alias_autonomy_enabled"
  | "non_warehouse_order_hold_enabled"
  | "non_warehouse_order_client_alerts_enabled";

const INTENDED_FLAG_LABELS: Record<IntendedFlag, string> = {
  sku_identity_autonomy_enabled: "Phase 2 — identity autonomy",
  sku_live_alias_autonomy_enabled: "Phase 7 — live-alias autonomy",
  non_warehouse_order_hold_enabled: "Phase 4 — non-warehouse order holds",
  non_warehouse_order_client_alerts_enabled: "Phase 5 — non-warehouse client alerts",
};

const FLAG_HELP_TEXT: Record<keyof AutonomousRolloutHealth["flags"], string> = {
  sku_identity_autonomy_enabled:
    "Phase 2 — autonomous database-identity matching. Canary-gated; requires a resolved canary review to enable.",
  sku_live_alias_autonomy_enabled:
    "Phase 7 — autonomous live-inventory alias writes. Canary-gated + linkage-gated; emergency pause blocks enable.",
  sku_autonomous_ui_enabled:
    "Read surface master switch. This page + identity-matches + autonomous-runs visibility all depend on this flag.",
  non_warehouse_order_hold_enabled:
    "Phase 4 — autonomous order holds for non-warehouse orders. Canary-gated.",
  non_warehouse_order_client_alerts_enabled:
    "Phase 5 — autonomous client alerts for non-warehouse orders. Canary-gated.",
  client_stock_exception_reports_enabled:
    "Phase 6 — exposes client-portal stock exception reports to labels.",
};

interface Props {
  bootstrap: AutonomousRolloutHealth;
}

export function RolloutClient({ bootstrap }: Props) {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Autonomous SKU matching — rollout</h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Single-read rollout dashboard: flag state, emergency-pause state, latest weekly
            telemetry rollup, Bandcamp linkage health, and the canary sign-off review row. Flag
            flips still happen on{" "}
            <Link
              href="/admin/settings/feature-flags"
              className="underline decoration-dotted underline-offset-4"
            >
              /admin/settings/feature-flags
            </Link>
            ; this page owns canary review lifecycle + observability.
          </p>
        </div>
        <Link
          href="/admin/settings/feature-flags"
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Feature flags <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <EmergencyPausePanel emergencyPause={bootstrap.emergencyPause} />
      <FlagsPanel flags={bootstrap.flags} />
      <TelemetryPanel telemetry={bootstrap.telemetry} />
      <LinkagePanel linkage={bootstrap.linkage} />
      <CanaryReviewPanel canaryReview={bootstrap.canaryReview} />
    </div>
  );
}

// ── Emergency pause ────────────────────────────────────────────────────

function EmergencyPausePanel({
  emergencyPause,
}: {
  emergencyPause: AutonomousRolloutHealth["emergencyPause"];
}) {
  if (!emergencyPause.paused) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Emergency pause — inactive
          </CardTitle>
          <CardDescription className="text-xs">
            Autonomous writes are eligible to run. The kill switch{" "}
            <code className="font-mono text-[11px]">
              workspaces.sku_autonomous_emergency_paused
            </code>{" "}
            is <code className="font-mono text-[11px]">false</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm text-destructive">
          <PauseCircle className="h-4 w-4" />
          Emergency pause — ACTIVE
        </CardTitle>
        <CardDescription className="text-xs">
          Every autonomous side effect is suppressed (telemetry still flows). Clear the kill switch
          on <code className="font-mono text-[11px]">workspaces</code> once the incident is
          resolved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="min-w-24 text-muted-foreground">Paused at:</span>
          <code className="font-mono text-[11px]">{emergencyPause.pausedAt ?? "(unknown)"}</code>
        </div>
        <div className="flex items-start gap-2">
          <span className="min-w-24 text-muted-foreground">Reason:</span>
          <span className="break-words">{emergencyPause.reason ?? "(none recorded)"}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Flags ──────────────────────────────────────────────────────────────

function FlagsPanel({ flags }: { flags: AutonomousRolloutHealth["flags"] }) {
  const rows = (Object.keys(flags) as Array<keyof AutonomousRolloutHealth["flags"]>).map((key) => ({
    key,
    enabled: flags[key],
    help: FLAG_HELP_TEXT[key],
  }));
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Feature flags</CardTitle>
        <CardDescription className="text-xs">
          Read-only view of the autonomous SKU matching flags. To flip a flag, open{" "}
          <Link
            href="/admin/settings/feature-flags"
            className="underline decoration-dotted underline-offset-4"
          >
            /admin/settings/feature-flags
          </Link>{" "}
          — every flip runs through the canary + linkage gates.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {rows.map(({ key, enabled, help }) => (
            <div
              key={key}
              className="flex items-start justify-between gap-4 rounded-md border bg-card p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[11px]">{key}</code>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{help}</p>
              </div>
              <Badge variant={enabled ? "default" : "secondary"} className="shrink-0">
                {enabled ? "enabled" : "disabled"}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Telemetry ──────────────────────────────────────────────────────────

function TelemetryPanel({ telemetry }: { telemetry: AutonomousRolloutHealth["telemetry"] }) {
  if (telemetry.kind === "missing") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Telemetry — no readings yet
          </CardTitle>
          <CardDescription className="text-xs">
            The <code className="font-mono text-[11px]">sku-autonomous-telemetry</code> Trigger task
            runs weekly. If this is a new workspace, wait for the next scheduled run or fire the
            manual task from the Trigger dashboard.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (telemetry.kind === "error") {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm text-destructive">
            <ShieldAlert className="h-4 w-4" />
            Telemetry — unavailable
          </CardTitle>
          <CardDescription className="text-xs">
            Could not read the latest rollup. Detail: {telemetry.detail}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const statusColor =
    telemetry.status === "healthy"
      ? "text-emerald-600"
      : telemetry.status === "paused"
        ? "text-amber-600"
        : "text-destructive";
  const StatusIcon =
    telemetry.status === "healthy"
      ? CheckCircle2
      : telemetry.status === "paused"
        ? PauseCircle
        : AlertTriangle;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusIcon className={`h-4 w-4 ${statusColor}`} />
          Telemetry — {telemetry.status}
        </CardTitle>
        <CardDescription className="text-xs">
          Recorded {telemetry.recordedAt} · {telemetry.windowDays}-day window ·{" "}
          {telemetry.summary.runsTotal} runs · {telemetry.summary.decisionsTotal} decisions ·{" "}
          {telemetry.summary.promotionsInWindow} promoted · {telemetry.summary.demotionsInWindow}{" "}
          demoted
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {telemetry.reasons.length > 0 && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs">
            <div className="font-medium text-amber-900">
              Threshold trips ({telemetry.reasons.length})
            </div>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-900">
              {telemetry.reasons.map((reason) => (
                <li key={reason}>
                  <code className="font-mono text-[11px]">{reason}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
          <MetricCell label="runs total" value={telemetry.summary.runsTotal} />
          <MetricCell label="runs failed" value={telemetry.summary.runsFailed} />
          <MetricCell label="decisions" value={telemetry.summary.decisionsTotal} />
          <MetricCell label="promotions" value={telemetry.summary.promotionsInWindow} />
          <MetricCell label="demotions" value={telemetry.summary.demotionsInWindow} />
          <MetricCell label="holds applied" value={telemetry.summary.holdsAppliedCycles} />
          <MetricCell label="holds released" value={telemetry.summary.holdsReleasedCycles} />
          <MetricCell label="client alerts" value={telemetry.summary.clientAlertsSent} />
        </div>

        {telemetry.identityCounts && (
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Identity counts at window end
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <MetricCell
                label="shadow candidates"
                value={telemetry.identityCounts.shadow_candidates}
              />
              <MetricCell
                label="stock exception"
                value={telemetry.identityCounts.stock_exception}
              />
              <MetricCell label="holdout" value={telemetry.identityCounts.holdout} />
            </div>
          </div>
        )}

        {(telemetry.truncated.runs ||
          telemetry.truncated.decisions ||
          telemetry.truncated.transitions ||
          telemetry.truncated.hold_events) && (
          <div className="rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            Window truncated at fetch caps —{telemetry.truncated.runs ? " runs" : ""}
            {telemetry.truncated.decisions ? " decisions" : ""}
            {telemetry.truncated.transitions ? " transitions" : ""}
            {telemetry.truncated.hold_events ? " hold_events" : ""}. Numbers above reflect the
            truncated window; re-run the task with a shorter window if exact totals are needed.
          </div>
        )}

        {telemetry.emergencyPausedAtRecord && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-[11px] text-amber-900">
            Emergency pause was ACTIVE when this reading was recorded. Review queue upserts were
            suppressed; telemetry continued.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-card px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}

// ── Linkage ────────────────────────────────────────────────────────────

function LinkagePanel({ linkage }: { linkage: AutonomousRolloutHealth["linkage"] }) {
  if (linkage.kind === "unavailable") {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Bandcamp linkage — unavailable
          </CardTitle>
          <CardDescription className="text-xs">Detail: {linkage.detail}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          {linkage.allClear ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          )}
          Bandcamp linkage — {linkage.allClear ? "all thresholds met" : "below threshold"}
        </CardTitle>
        <CardDescription className="text-xs">
          Phase 7 gate for{" "}
          <code className="font-mono text-[11px]">sku_live_alias_autonomy_enabled</code>: the flag
          flip is blocked unless linkage_rate, verified_rate, and option_rate all clear their
          thresholds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <LinkageRateCell
            label="linkage rate"
            value={linkage.metrics.linkage_rate}
            threshold={linkage.thresholds.linkage_rate}
          />
          <LinkageRateCell
            label="verified rate"
            value={linkage.metrics.verified_rate}
            threshold={linkage.thresholds.verified_rate}
          />
          <LinkageRateCell
            label="option rate"
            value={linkage.metrics.option_rate}
            threshold={linkage.thresholds.option_rate}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
          <MetricCell label="total variants" value={linkage.metrics.total_canonical_variants} />
          <MetricCell
            label="w/ bandcamp mapping"
            value={linkage.metrics.variants_with_bandcamp_mapping}
          />
          <MetricCell
            label="verified url"
            value={linkage.metrics.variants_with_verified_bandcamp_url}
          />
          <MetricCell
            label="option evidence"
            value={linkage.metrics.variants_with_option_evidence}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function LinkageRateCell({
  label,
  value,
  threshold,
}: {
  label: string;
  value: number;
  threshold: number;
}) {
  const passes = value >= threshold;
  return (
    <div
      className={`rounded-md border p-2 ${
        passes ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-300"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{(value * 100).toFixed(1)}%</div>
      <div className="text-[10px] text-muted-foreground">
        threshold {(threshold * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// ── Canary review ──────────────────────────────────────────────────────

function CanaryReviewPanel({
  canaryReview,
}: {
  canaryReview: AutonomousRolloutHealth["canaryReview"];
}) {
  const router = useRouter();
  const [isCreating, startCreate] = useTransition();
  const [isResolving, startResolve] = useTransition();
  const [intendedFlag, setIntendedFlag] = useState<IntendedFlag>("sku_live_alias_autonomy_enabled");
  const [note, setNote] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canOpenNew = canaryReview.kind !== "open";
  const openReviewId = canaryReview.kind === "open" ? canaryReview.id : null;

  function onCreate() {
    setError(null);
    startCreate(async () => {
      try {
        const result = await createAutonomousCanaryReview({
          intendedFlag,
          note: note || undefined,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNote("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onResolve() {
    if (!openReviewId) return;
    setError(null);
    startResolve(async () => {
      try {
        const result = await resolveAutonomousCanaryReview({
          reviewId: openReviewId,
          resolutionNote: resolutionNote || undefined,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setResolutionNote("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" />
          Canary review
        </CardTitle>
        <CardDescription className="text-xs">
          The flag-flip gate for canary-protected autonomy flags. Open a new review before the
          sign-off window; resolve it once telemetry is green. The flip action reads the most recent{" "}
          <code className="font-mono text-[11px]">resolved</code> row for this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canaryReview.kind === "missing" && (
          <div className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
            No canary review has been opened yet for this workspace.
          </div>
        )}

        {canaryReview.kind === "open" && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-amber-900">
              <Clock className="h-3.5 w-3.5" />
              Open review · status {canaryReview.status}
            </div>
            <div className="mt-2 space-y-0.5 text-amber-900">
              <div>
                <span className="text-amber-800">ID:</span>{" "}
                <code className="font-mono text-[11px]">{canaryReview.id}</code>
              </div>
              <div>
                <span className="text-amber-800">Title:</span> {canaryReview.title}
              </div>
              {canaryReview.intendedFlag && (
                <div>
                  <span className="text-amber-800">Intended flag:</span>{" "}
                  <code className="font-mono text-[11px]">{canaryReview.intendedFlag}</code>
                </div>
              )}
              <div>
                <span className="text-amber-800">Opened:</span> {canaryReview.createdAt}
              </div>
              {canaryReview.note && (
                <div className="mt-1 border-t border-amber-200 pt-1">
                  <span className="text-amber-800">Note:</span> {canaryReview.note}
                </div>
              )}
            </div>
          </div>
        )}

        {canaryReview.kind === "resolved" && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Resolved — flag flip now eligible
            </div>
            <div className="mt-2 space-y-0.5 text-emerald-900">
              <div>
                <span className="text-emerald-700">ID:</span>{" "}
                <code className="font-mono text-[11px]">{canaryReview.id}</code>
              </div>
              <div>
                <span className="text-emerald-700">Title:</span> {canaryReview.title}
              </div>
              {canaryReview.intendedFlag && (
                <div>
                  <span className="text-emerald-700">Intended flag:</span>{" "}
                  <code className="font-mono text-[11px]">{canaryReview.intendedFlag}</code>
                </div>
              )}
              <div>
                <span className="text-emerald-700">Opened:</span> {canaryReview.createdAt}
              </div>
              <div>
                <span className="text-emerald-700">Resolved:</span> {canaryReview.resolvedAt}
                {canaryReview.resolvedBy && (
                  <>
                    {" "}
                    by <code className="font-mono text-[11px]">{canaryReview.resolvedBy}</code>
                  </>
                )}
              </div>
              {canaryReview.note && (
                <div className="mt-1 border-t border-emerald-200 pt-1">
                  <span className="text-emerald-700">Note:</span> {canaryReview.note}
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <div className="flex items-start gap-1.5">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* ── Open a new review ────────────────────────────────── */}
        {canOpenNew && (
          <div className="space-y-3 rounded-md border bg-card p-3">
            <div className="text-xs font-medium">Open a new canary review</div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rollout-intended-flag" className="text-[11px]">
                  Intended flag
                </Label>
                <Select
                  value={intendedFlag}
                  onValueChange={(v) => setIntendedFlag(v as IntendedFlag)}
                  disabled={isCreating}
                >
                  <SelectTrigger id="rollout-intended-flag" className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(INTENDED_FLAG_LABELS) as IntendedFlag[]).map((flag) => (
                      <SelectItem key={flag} value={flag} className="text-xs">
                        {INTENDED_FLAG_LABELS[flag]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rollout-note" className="text-[11px]">
                  Note (optional)
                </Label>
                <Input
                  id="rollout-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. linkage green, starting 7-day canary window"
                  maxLength={4000}
                  className="h-8 text-xs"
                  disabled={isCreating}
                />
              </div>
            </div>
            <div>
              <Button size="sm" onClick={onCreate} disabled={isCreating}>
                {isCreating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Open canary review
              </Button>
            </div>
          </div>
        )}

        {/* ── Resolve an open review ───────────────────────────── */}
        {openReviewId && (
          <div className="space-y-3 rounded-md border bg-card p-3">
            <div className="text-xs font-medium">Resolve open review</div>
            <div className="space-y-1.5">
              <Label htmlFor="rollout-resolution-note" className="text-[11px]">
                Resolution note (optional)
              </Label>
              <Input
                id="rollout-resolution-note"
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                placeholder="e.g. telemetry green, 0 demotions, ready to flip"
                maxLength={4000}
                className="h-8 text-xs"
                disabled={isResolving}
              />
            </div>
            <div>
              <Button size="sm" onClick={onResolve} disabled={isResolving} variant="default">
                {isResolving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Mark resolved
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
