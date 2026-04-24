"use server";

/**
 * Phase 3 Pass 2 — per-connection cutover Server Actions.
 *
 * D3 — `getCutoverDiagnostics(connectionId)`:
 *   Returns 7-day rolling shadow-mode statistics for one connection so the
 *   `/admin/settings/connection-cutover` wizard can show an operator
 *   whether shadow mode has converged enough to flip to `direct`. The
 *   primary cutover gate is `match_rate >= 0.995` over the last 7 days
 *   with `>= MIN_SAMPLE_COUNT_FOR_CUTOVER` resolved comparisons.
 *
 * Pass 2 D4 (`runConnectionCutover`) and the wizard UI (D5) consume the
 * shape returned here as their gate input — see plan §9.4 for the full
 * gate matrix. This module is read-only; the cutover flip itself lives
 * in the D4 follow-up.
 *
 * Read-only access (Rule #7 staff-only). The shadow log RLS already
 * restricts reads to staff; we re-check `requireAuth({ staffOnly })` for
 * defence-in-depth.
 */

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection, ConnectionShadowLog, CutoverState } from "@/lib/shared/types";

/**
 * Minimum number of resolved (`observed_at IS NOT NULL`) shadow comparisons
 * required in the last 7 days before `runConnectionCutover` will accept a
 * match-rate gate. Below this, the operator sees `eligible: false` with
 * `gate_reason: 'insufficient_samples'` even if the match-rate is 100%.
 */
export const MIN_SAMPLE_COUNT_FOR_CUTOVER = 50;

/**
 * Required match rate over the rolling 7-day window. 0.995 = 1 drift event
 * per 200 comparisons. Plan §9.4 D2 calibrates this against historical
 * SS Inventory Sync mirror jitter (peak 0.4% drift events at sustained
 * load).
 */
export const REQUIRED_MATCH_RATE = 0.995;

const SHADOW_WINDOW_DAYS = 7;

const getCutoverDiagnosticsInputSchema = z.object({
  connectionId: z.string().uuid(),
});

export type CutoverGateReason =
  | "ok"
  | "wrong_state"
  | "insufficient_samples"
  | "match_rate_below_threshold"
  | "unresolved_window_too_old";

/** Bucketed counts persisted to the diagnostic shape. */
export interface ShadowMatchCounters {
  total_logged: number;
  resolved: number;
  matched: number;
  drifted: number;
  /** `observed_at IS NULL` — comparison hasn't fired yet OR never will. */
  unresolved: number;
  /** Rows where the comparison ran but couldn't compute (e.g. v2 not configured). */
  comparison_skipped: number;
  /** match_rate = matched / resolved (NaN-safe: returns 0 when resolved == 0). */
  match_rate: number;
  /** Aggregate drift magnitude across all drifted rows. */
  total_abs_drift_units: number;
  /** Largest absolute drift seen in the window. */
  max_abs_drift_units: number;
}

export interface CutoverDriftSample {
  shadow_log_id: string;
  sku: string;
  pushed_quantity: number;
  ss_observed_quantity: number | null;
  drift_units: number | null;
  pushed_at: string;
  observed_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CutoverGateEvaluation {
  eligible: boolean;
  gate_reason: CutoverGateReason;
  required_match_rate: number;
  required_min_samples: number;
}

export interface ConnectionCutoverDiagnostics {
  connection: {
    id: string;
    workspace_id: string;
    platform: string;
    store_url: string | null;
    cutover_state: CutoverState;
    cutover_started_at: string | null;
    cutover_completed_at: string | null;
    shadow_window_tolerance_seconds: number | null;
  };
  window: {
    days: number;
    starts_at: string;
    ends_at: string;
  };
  counters: ShadowMatchCounters;
  /** Most recent up-to-25 drifted rows for the diagnostics table. */
  recent_drift_samples: CutoverDriftSample[];
  /** `comparison_skipped` distribution by `metadata.skip_reason`. */
  comparison_skip_breakdown: Record<string, number>;
  gate: CutoverGateEvaluation;
}

/**
 * Read-only diagnostic. Returns 7-day rolling shadow-mode stats for one
 * connection so the wizard UI + `runConnectionCutover` D4 gate can render.
 *
 * Returns the same shape regardless of `cutover_state` — operators may
 * inspect a `legacy` or `direct` connection too (the resulting counters
 * will be all-zero or stale, but the shape is stable). The `gate` block's
 * `gate_reason='wrong_state'` flags any non-`shadow` lookup so the UI
 * can show "must be in shadow mode to evaluate".
 */
export async function getCutoverDiagnostics(
  rawInput: z.infer<typeof getCutoverDiagnosticsInputSchema>,
): Promise<ConnectionCutoverDiagnostics> {
  const { isStaff } = await requireAuth();
  if (!isStaff) {
    throw new Error("getCutoverDiagnostics: staff-only");
  }
  const { connectionId } = getCutoverDiagnosticsInputSchema.parse(rawInput);

  const supabase = createServiceRoleClient();

  const { data: connRow, error: connErr } = await supabase
    .from("client_store_connections")
    .select(
      "id, workspace_id, platform, store_url, cutover_state, cutover_started_at, cutover_completed_at, shadow_window_tolerance_seconds",
    )
    .eq("id", connectionId)
    .maybeSingle();

  if (connErr) {
    throw new Error(`getCutoverDiagnostics: connection lookup failed: ${connErr.message}`);
  }
  if (!connRow) {
    throw new Error(`getCutoverDiagnostics: connection not found: ${connectionId}`);
  }

  const conn = connRow as Pick<
    ClientStoreConnection,
    | "id"
    | "workspace_id"
    | "platform"
    | "store_url"
    | "cutover_state"
    | "cutover_started_at"
    | "cutover_completed_at"
    | "shadow_window_tolerance_seconds"
  >;

  const endsAt = new Date();
  const startsAt = new Date(endsAt.getTime() - SHADOW_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Pull every shadow log row in the window. With UNIQUE(correlation_id,
  // sku) and per-push fanout volume of ~10-100 rows / day for a healthy
  // connection, 7 days = O(10^3) rows max — comfortable for a single
  // SELECT. If a single connection ever blows past 100k rows in 7 days
  // we'll need a paginated count, but at that point the operator should
  // see something pathological happening upstream first.
  const { data: rows, error: logErr } = await supabase
    .from("connection_shadow_log")
    .select(
      "id, sku, pushed_quantity, ss_observed_quantity, drift_units, match, pushed_at, observed_at, metadata",
    )
    .eq("connection_id", connectionId)
    .gte("pushed_at", startsAt.toISOString())
    .order("pushed_at", { ascending: false });

  if (logErr) {
    throw new Error(`getCutoverDiagnostics: shadow log query failed: ${logErr.message}`);
  }

  const counters: ShadowMatchCounters = {
    total_logged: 0,
    resolved: 0,
    matched: 0,
    drifted: 0,
    unresolved: 0,
    comparison_skipped: 0,
    match_rate: 0,
    total_abs_drift_units: 0,
    max_abs_drift_units: 0,
  };
  const skipBreakdown: Record<string, number> = {};
  const recentDriftSamples: CutoverDriftSample[] = [];
  const MAX_RECENT_DRIFT_SAMPLES = 25;

  for (const r of (rows ?? []) as ConnectionShadowLog[]) {
    counters.total_logged += 1;
    if (r.observed_at === null) {
      counters.unresolved += 1;
      continue;
    }
    // observed_at IS NOT NULL means the comparison ran. `match=null`
    // here means the comparison ran but couldn't compute (no v2 defaults,
    // v2 read failed, etc. — the metadata.skip_reason has the detail).
    if (r.match === null) {
      counters.comparison_skipped += 1;
      const reason =
        ((r.metadata as Record<string, unknown> | null)?.skip_reason as string | undefined) ??
        "unknown";
      skipBreakdown[reason] = (skipBreakdown[reason] ?? 0) + 1;
      continue;
    }
    counters.resolved += 1;
    if (r.match === true) {
      counters.matched += 1;
    } else {
      counters.drifted += 1;
      const absDrift = r.drift_units !== null ? Math.abs(r.drift_units) : 0;
      counters.total_abs_drift_units += absDrift;
      if (absDrift > counters.max_abs_drift_units) {
        counters.max_abs_drift_units = absDrift;
      }
      if (recentDriftSamples.length < MAX_RECENT_DRIFT_SAMPLES) {
        recentDriftSamples.push({
          shadow_log_id: r.id,
          sku: r.sku,
          pushed_quantity: r.pushed_quantity,
          ss_observed_quantity: r.ss_observed_quantity,
          drift_units: r.drift_units,
          pushed_at: r.pushed_at,
          observed_at: r.observed_at,
          metadata: r.metadata as Record<string, unknown> | null,
        });
      }
    }
  }
  counters.match_rate = counters.resolved > 0 ? counters.matched / counters.resolved : 0;

  // Gate: only meaningful when the connection is currently in shadow
  // mode. Other states get `gate_reason='wrong_state'` so the UI can
  // surface "this is read-only because the connection isn't being
  // shadowed right now".
  let gate: CutoverGateEvaluation;
  if (conn.cutover_state !== "shadow") {
    gate = {
      eligible: false,
      gate_reason: "wrong_state",
      required_match_rate: REQUIRED_MATCH_RATE,
      required_min_samples: MIN_SAMPLE_COUNT_FOR_CUTOVER,
    };
  } else if (counters.resolved < MIN_SAMPLE_COUNT_FOR_CUTOVER) {
    gate = {
      eligible: false,
      gate_reason: "insufficient_samples",
      required_match_rate: REQUIRED_MATCH_RATE,
      required_min_samples: MIN_SAMPLE_COUNT_FOR_CUTOVER,
    };
  } else if (counters.match_rate < REQUIRED_MATCH_RATE) {
    gate = {
      eligible: false,
      gate_reason: "match_rate_below_threshold",
      required_match_rate: REQUIRED_MATCH_RATE,
      required_min_samples: MIN_SAMPLE_COUNT_FOR_CUTOVER,
    };
  } else if (counters.unresolved > Math.max(10, counters.total_logged * 0.05)) {
    // Backstop: if >5% of recent pushes never had a comparison fire (or
    // 10 absolute, whichever is larger), shadow mode isn't actually
    // observing reality. Surface as non-eligible so we don't flip a
    // connection on a stale read.
    gate = {
      eligible: false,
      gate_reason: "unresolved_window_too_old",
      required_match_rate: REQUIRED_MATCH_RATE,
      required_min_samples: MIN_SAMPLE_COUNT_FOR_CUTOVER,
    };
  } else {
    gate = {
      eligible: true,
      gate_reason: "ok",
      required_match_rate: REQUIRED_MATCH_RATE,
      required_min_samples: MIN_SAMPLE_COUNT_FOR_CUTOVER,
    };
  }

  return {
    connection: {
      id: conn.id,
      workspace_id: conn.workspace_id,
      platform: conn.platform,
      store_url: conn.store_url ?? null,
      cutover_state: conn.cutover_state,
      cutover_started_at: conn.cutover_started_at ?? null,
      cutover_completed_at: conn.cutover_completed_at ?? null,
      shadow_window_tolerance_seconds: conn.shadow_window_tolerance_seconds ?? null,
    },
    window: {
      days: SHADOW_WINDOW_DAYS,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    },
    counters,
    recent_drift_samples: recentDriftSamples,
    comparison_skip_breakdown: skipBreakdown,
    gate,
  };
}

// ---------------------------------------------------------------------------
// D4 — runConnectionCutover + companion state-machine actions
// ---------------------------------------------------------------------------

/**
 * Maps a `client_store_connections.platform` to the matching
 * `external_sync_events.system` literal. Mirrors the same switch in
 * `client-store-push-on-sku.ts` — kept local so a future platform addition
 * has to be wired in both places (intentional friction; an unhandled
 * platform should fail loudly here, not silently bypass the in-flight gate).
 */
function platformToSyncSystem(
  platform: string,
): "client_store_shopify" | "client_store_squarespace" | "client_store_woocommerce" | null {
  switch (platform) {
    case "shopify":
      return "client_store_shopify";
    case "squarespace":
      return "client_store_squarespace";
    case "woocommerce":
      return "client_store_woocommerce";
    default:
      return null;
  }
}

/** Window inside which `external_sync_events.status='in_flight'` is treated
 *  as a real concurrent push vs a stuck/orphaned row. 5 minutes mirrors the
 *  cron sweep cadence — anything older than that is by definition stuck and
 *  the cutover sweep doesn't need to wait on it. */
const IN_FLIGHT_WINDOW_MINUTES = 5;

const startConnectionShadowModeInputSchema = z.object({
  connectionId: z.string().uuid(),
  /** Optional per-connection comparison delay override. Bounded 30..600s
   *  by the DB CHECK constraint; outside that range we reject with a clear
   *  message rather than letting Postgres surface a confusing 23514. */
  shadowWindowToleranceSeconds: z.number().int().min(30).max(600).nullable().optional(),
});

const runConnectionCutoverInputSchema = z.object({
  connectionId: z.string().uuid(),
  /** Operator override — bypass the diagnostics gate. ONLY honored when
   *  `force_reason` is provided AND the operator's audit trail will record
   *  it. Use for fire-drills / recovery scenarios where the gate is wrong
   *  for known reasons. */
  force: z.boolean().optional(),
  forceReason: z.string().min(8).max(500).nullable().optional(),
});

const rollbackConnectionCutoverInputSchema = z.object({
  connectionId: z.string().uuid(),
  /** Required for direct→legacy rollbacks so the audit trail is honest about
   *  why we abandoned the cutover. Reuses the review-queue note convention. */
  reason: z.string().min(8).max(500),
});

export type RunConnectionCutoverResult =
  | {
      status: "ok";
      connectionId: string;
      previousState: CutoverState;
      newState: CutoverState;
      cutoverCompletedAt: string;
      echoOverrideId: string;
    }
  | {
      status: "blocked";
      connectionId: string;
      blockedReason:
        | "wrong_state"
        | "diagnostics_gate_failed"
        | "in_flight_push_active"
        | "force_missing_reason";
      details?: Record<string, unknown>;
    };

/**
 * Move a connection from `legacy` → `shadow`. Only valid transition is
 * legacy→shadow (re-entering shadow from direct requires
 * `rollbackConnectionCutover` first). Sets `cutover_started_at` so
 * diagnostics can show "shadow mode running for N hours" and the 7-day
 * window can opportunistically start counting from this timestamp.
 *
 * Idempotent: re-calling on a connection already in `shadow` returns the
 * existing started_at without resetting it.
 */
export async function startConnectionShadowMode(
  rawInput: z.infer<typeof startConnectionShadowModeInputSchema>,
): Promise<{ connectionId: string; cutoverStartedAt: string; alreadyShadow: boolean }> {
  const { isStaff } = await requireAuth();
  if (!isStaff) {
    throw new Error("startConnectionShadowMode: staff-only");
  }
  const { connectionId, shadowWindowToleranceSeconds } =
    startConnectionShadowModeInputSchema.parse(rawInput);

  const supabase = createServiceRoleClient();

  const { data: connRow, error: connErr } = await supabase
    .from("client_store_connections")
    .select("id, cutover_state, cutover_started_at, do_not_fanout, shadow_window_tolerance_seconds")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) {
    throw new Error(`startConnectionShadowMode: lookup failed: ${connErr.message}`);
  }
  if (!connRow) {
    throw new Error(`startConnectionShadowMode: connection not found: ${connectionId}`);
  }

  // Defensive: the DB CHECK forbids shadow|direct + do_not_fanout=true,
  // but surface a clearer error before we attempt the UPDATE.
  if (connRow.do_not_fanout === true) {
    throw new Error(
      "startConnectionShadowMode: cannot start shadow mode while do_not_fanout=true; clear do_not_fanout first",
    );
  }

  if (connRow.cutover_state === "shadow") {
    return {
      connectionId,
      cutoverStartedAt: (connRow.cutover_started_at as string) ?? new Date().toISOString(),
      alreadyShadow: true,
    };
  }

  if (connRow.cutover_state !== "legacy") {
    throw new Error(
      `startConnectionShadowMode: invalid transition from '${connRow.cutover_state}' to 'shadow'; only legacy→shadow is allowed`,
    );
  }

  const cutoverStartedAt = new Date().toISOString();
  const updates: Record<string, unknown> = {
    cutover_state: "shadow" satisfies CutoverState,
    cutover_started_at: cutoverStartedAt,
    cutover_completed_at: null,
    updated_at: cutoverStartedAt,
  };
  if (shadowWindowToleranceSeconds !== undefined) {
    updates.shadow_window_tolerance_seconds = shadowWindowToleranceSeconds;
  }

  const { error: updErr } = await supabase
    .from("client_store_connections")
    .update(updates)
    .eq("id", connectionId);
  if (updErr) {
    throw new Error(`startConnectionShadowMode: update failed: ${updErr.message}`);
  }

  return { connectionId, cutoverStartedAt, alreadyShadow: false };
}

/**
 * Flip a connection from `shadow` → `direct`. Gates (in order):
 *
 *   1. Connection currently in `shadow` state (reject `wrong_state`
 *      otherwise).
 *   2. `getCutoverDiagnostics(connectionId).gate.eligible === true` —
 *      7-day match-rate >= 99.5% with >= 50 resolved samples and <5%
 *      unresolved (`force=true` skips this if `forceReason` provided).
 *   3. Zero `external_sync_events.status='in_flight'` rows for this
 *      connection within the last 5 minutes — refuse to flip mid-push,
 *      because the in-flight push uses the OLD `cutover_state` and we'd
 *      double-write or drop a fanout depending on the platform branch
 *      it landed in.
 *
 * On success:
 *   a. Insert a `connection_echo_overrides` row of type
 *      `exclude_from_v2_echo` so the V2 echo-skip logic now treats this
 *      connection's storefront-driven inventory writes as primary
 *      (non-skip). This is the key behavioral switch — the cutover_state
 *      flip alone wouldn't change any code path; the echo override is
 *      what makes Direct-Shopify the authoritative writer.
 *   b. Update `cutover_state='direct'` + `cutover_completed_at=now()`.
 *
 * Both writes are sequenced (echo override first, then cutover_state)
 * so a crash between them leaves the connection in `shadow` with an
 * orphan echo override (defensible: shadow mode keeps logging, the
 * override doesn't matter until cutover_state='direct'). The opposite
 * order would leave `direct` with no echo override — silently double-
 * writing inventory. Always echo override first.
 *
 * Audit trail: writes the operator's `userId` to
 * `connection_echo_overrides.created_by` so we can trace who flipped
 * each connection.
 */
export async function runConnectionCutover(
  rawInput: z.infer<typeof runConnectionCutoverInputSchema>,
): Promise<RunConnectionCutoverResult> {
  const { isStaff, userRecord } = await requireAuth();
  if (!isStaff) {
    throw new Error("runConnectionCutover: staff-only");
  }
  const input = runConnectionCutoverInputSchema.parse(rawInput);
  const { connectionId, force, forceReason } = input;

  if (force === true && (!forceReason || forceReason.trim().length === 0)) {
    return {
      status: "blocked",
      connectionId,
      blockedReason: "force_missing_reason",
    };
  }

  const supabase = createServiceRoleClient();

  // Gate 1 — current state.
  const { data: connRow, error: connErr } = await supabase
    .from("client_store_connections")
    .select("id, platform, cutover_state, do_not_fanout")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) {
    throw new Error(`runConnectionCutover: lookup failed: ${connErr.message}`);
  }
  if (!connRow) {
    throw new Error(`runConnectionCutover: connection not found: ${connectionId}`);
  }
  if (connRow.cutover_state !== "shadow") {
    return {
      status: "blocked",
      connectionId,
      blockedReason: "wrong_state",
      details: { current_state: connRow.cutover_state },
    };
  }

  // Gate 2 — diagnostics. `force=true` bypasses but still records the
  // diagnostics snapshot in the override metadata for audit.
  const diagnostics = await getCutoverDiagnostics({ connectionId });
  if (!diagnostics.gate.eligible && force !== true) {
    return {
      status: "blocked",
      connectionId,
      blockedReason: "diagnostics_gate_failed",
      details: {
        gate_reason: diagnostics.gate.gate_reason,
        match_rate: diagnostics.counters.match_rate,
        resolved: diagnostics.counters.resolved,
        unresolved: diagnostics.counters.unresolved,
      },
    };
  }

  // Gate 3 — in-flight pushes. Query external_sync_events for any
  // recent in_flight rows whose request_body.connection_id matches.
  // We use the recent window (5 min) so a stuck row from days ago
  // doesn't permanently block the cutover.
  const syncSystem = platformToSyncSystem(connRow.platform as string);
  if (syncSystem) {
    const inFlightCutoff = new Date(
      Date.now() - IN_FLIGHT_WINDOW_MINUTES * 60 * 1000,
    ).toISOString();
    const { data: inFlightRows, error: inFlightErr } = await supabase
      .from("external_sync_events")
      .select("id, sku, started_at")
      .eq("system", syncSystem)
      .eq("status", "in_flight")
      // PostgREST `eq` on a JSONB path:
      .eq("request_body->>connection_id", connectionId)
      .gte("started_at", inFlightCutoff)
      .limit(5);

    if (inFlightErr) {
      throw new Error(`runConnectionCutover: in-flight check failed: ${inFlightErr.message}`);
    }
    if (inFlightRows && inFlightRows.length > 0) {
      return {
        status: "blocked",
        connectionId,
        blockedReason: "in_flight_push_active",
        details: {
          sample_in_flight_rows: inFlightRows,
          window_minutes: IN_FLIGHT_WINDOW_MINUTES,
        },
      };
    }
  }

  // (a) Insert echo override FIRST. The partial unique index
  // `uq_connection_echo_overrides_active` (migration 20260424000002)
  // prevents duplicates per (connection_id, override_type) where
  // is_active=true; if a previous run inserted one and this one is a
  // retry, treat it as the active row and reuse its id.
  const overrideMetadata: Record<string, unknown> = {
    diagnostics_snapshot: {
      counters: diagnostics.counters,
      gate: diagnostics.gate,
      window: diagnostics.window,
    },
    initiated_by_user_id: userRecord.id,
    forced: force === true,
  };
  if (force === true && forceReason) {
    overrideMetadata.force_reason = forceReason;
  }

  let echoOverrideId: string;
  const { data: insertedOverride, error: overrideErr } = await supabase
    .from("connection_echo_overrides")
    .insert({
      connection_id: connectionId,
      override_type: "exclude_from_v2_echo",
      created_by: userRecord.id,
      reason:
        force === true && forceReason ? `forced cutover: ${forceReason}` : "cutover_to_direct",
      is_active: true,
      metadata: overrideMetadata,
    })
    .select("id")
    .single();

  if (overrideErr) {
    // Unique-violation = an active override row already exists. Reuse it
    // — the cutover is being retried after a crash between override
    // insert and cutover_state flip.
    if ((overrideErr as { code?: string }).code === "23505") {
      const { data: existing, error: existingErr } = await supabase
        .from("connection_echo_overrides")
        .select("id")
        .eq("connection_id", connectionId)
        .eq("override_type", "exclude_from_v2_echo")
        .eq("is_active", true)
        .maybeSingle();
      if (existingErr || !existing) {
        throw new Error(
          `runConnectionCutover: echo override conflict but no active row found: ${
            existingErr?.message ?? "row_missing"
          }`,
        );
      }
      echoOverrideId = existing.id as string;
    } else {
      throw new Error(`runConnectionCutover: echo override insert failed: ${overrideErr.message}`);
    }
  } else {
    echoOverrideId = (insertedOverride as { id: string }).id;
  }

  // (b) Flip cutover_state to direct.
  const cutoverCompletedAt = new Date().toISOString();
  const { error: flipErr } = await supabase
    .from("client_store_connections")
    .update({
      cutover_state: "direct" satisfies CutoverState,
      cutover_completed_at: cutoverCompletedAt,
      updated_at: cutoverCompletedAt,
    })
    .eq("id", connectionId);
  if (flipErr) {
    // Don't try to roll back the echo override — leaving it active with
    // cutover_state still 'shadow' is the safer state (no behavior
    // change yet). The wizard can detect this and offer a retry.
    throw new Error(
      `runConnectionCutover: cutover_state flip failed (echo override left active): ${flipErr.message}`,
    );
  }

  return {
    status: "ok",
    connectionId,
    previousState: "shadow",
    newState: "direct",
    cutoverCompletedAt,
    echoOverrideId,
  };
}

/**
 * Roll back a connection from `direct` or `shadow` back to `legacy`.
 *
 * Steps (reverse of `runConnectionCutover`):
 *   1. Deactivate any active `connection_echo_overrides` rows for this
 *      connection (set `is_active=false`). The partial unique index lets
 *      a future re-cutover insert a fresh active row.
 *   2. Update `cutover_state='legacy'`, `cutover_completed_at=NULL`,
 *      `cutover_started_at=NULL`. Shadow log rows are left intact for
 *      historical analysis.
 *
 * Idempotent: running on a connection already in `legacy` is a no-op.
 */
export async function rollbackConnectionCutover(
  rawInput: z.infer<typeof rollbackConnectionCutoverInputSchema>,
): Promise<{
  connectionId: string;
  previousState: CutoverState;
  newState: CutoverState;
  deactivatedOverrideIds: string[];
}> {
  const { isStaff, userRecord } = await requireAuth();
  if (!isStaff) {
    throw new Error("rollbackConnectionCutover: staff-only");
  }
  const { connectionId, reason } = rollbackConnectionCutoverInputSchema.parse(rawInput);

  const supabase = createServiceRoleClient();

  const { data: connRow, error: connErr } = await supabase
    .from("client_store_connections")
    .select("id, cutover_state")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) {
    throw new Error(`rollbackConnectionCutover: lookup failed: ${connErr.message}`);
  }
  if (!connRow) {
    throw new Error(`rollbackConnectionCutover: connection not found: ${connectionId}`);
  }

  const previousState = connRow.cutover_state as CutoverState;
  if (previousState === "legacy") {
    return {
      connectionId,
      previousState,
      newState: "legacy",
      deactivatedOverrideIds: [],
    };
  }

  // Deactivate every active echo override for this connection.
  const { data: deactivated, error: deactivateErr } = await supabase
    .from("connection_echo_overrides")
    .update({
      is_active: false,
      metadata: {
        deactivated_at: new Date().toISOString(),
        deactivated_by_user_id: userRecord.id,
        rollback_reason: reason,
        previous_cutover_state: previousState,
      },
    })
    .eq("connection_id", connectionId)
    .eq("is_active", true)
    .select("id");
  if (deactivateErr) {
    throw new Error(`rollbackConnectionCutover: deactivate failed: ${deactivateErr.message}`);
  }
  const deactivatedOverrideIds = (deactivated ?? []).map((r) => r.id as string);

  const { error: flipErr } = await supabase
    .from("client_store_connections")
    .update({
      cutover_state: "legacy" satisfies CutoverState,
      cutover_started_at: null,
      cutover_completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);
  if (flipErr) {
    throw new Error(`rollbackConnectionCutover: cutover_state flip failed: ${flipErr.message}`);
  }

  return {
    connectionId,
    previousState,
    newState: "legacy",
    deactivatedOverrideIds,
  };
}
