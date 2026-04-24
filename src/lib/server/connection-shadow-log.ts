/**
 * Phase 3 Pass 2 — connection shadow-mode write hook.
 *
 * When a client-store push fires for a connection in `cutover_state='shadow'`,
 * we record what we pushed to the storefront (Shopify CAS final value, or
 * the value handed to the legacy dispatcher) AND enqueue a delayed
 * comparison task that will read ShipStation v2 a configurable number of
 * seconds later to confirm SS Inventory Sync mirrored the same value.
 *
 * The 7-day rolling match-rate computed from these rows is the primary gate
 * for `runConnectionCutover` (D4) — the operator cannot flip a connection
 * to `cutover_state='direct'` until shadow mode demonstrates that direct
 * pushes and SS-mirrored writes converge for at least 99.5% of events over
 * the prior 7 days.
 *
 * Two write surfaces hook this module:
 *   - `client-store-push-on-sku` (per-SKU happy path, both Shopify CAS and
 *     legacy dispatcher branches).
 *   - Future bulk paths (none today; reserved for Pass 2.5 if `bandcamp-
 *     inventory-push` ever needs shadow coverage too).
 *
 * Failure mode: a logging-only write that throws would abort the parent
 * push and cause user-visible regressions. Every call is wrapped in
 * try/catch and reports through Sentry on failure but never rethrows.
 * Shadow mode is a diagnostic harness; it MUST NOT block real writes.
 *
 * Rule #7  — service-role client.
 * Rule #12 — task payloads are IDs only.
 * Rule #15 — stable correlation_id per logical push.
 * Rule #43 — shadow log writes happen AFTER Postgres truth is updated.
 */

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import type { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { CutoverState } from "@/lib/shared/types";
import type { ShadowModeComparisonPayload } from "@/trigger/tasks/shadow-mode-comparison";

type SupabaseServiceRoleClient = ReturnType<typeof createServiceRoleClient>;

/**
 * Default delay between a direct push and the v2 comparison read. SS
 * Inventory Sync typically mirrors a write into v2 within 10-30s; 60s
 * gives the longest observed mirror time a comfortable margin. Operators
 * can override per-connection via
 * `client_store_connections.shadow_window_tolerance_seconds` (DB CHECK
 * bounds it to 30-600s).
 */
export const DEFAULT_SHADOW_WINDOW_SECONDS = 60;

export interface RecordShadowPushParams {
  supabase: SupabaseServiceRoleClient;
  workspaceId: string;
  connectionId: string;
  sku: string;
  /** Stable per-logical-push id, mirrors the external_sync_events.correlation_id. */
  correlationId: string;
  /** Final value handed to the storefront (CAS final value for Shopify). */
  pushedQuantity: number;
  /** Seen-by-the-gate cutover_state at push time. Useful when diagnostics
   *  want to bucket shadow-only entries vs direct (the column should always
   *  be 'shadow' here, but recording the actual value defends against a
   *  rare race where the operator flipped state mid-push). */
  cutoverStateAtPush: CutoverState;
  /**
   * Per-connection override for the comparison delay. Falls back to the
   * default when null/undefined. Always clamped to the DB bounds (30..600s)
   * before scheduling so a malformed override cannot defer the comparison
   * indefinitely.
   */
  shadowWindowToleranceSeconds: number | null | undefined;
  /** Free-form context that ends up on the ledger row for debugging. */
  metadata?: Record<string, unknown>;
}

export interface RecordShadowPushResult {
  status: "logged" | "logged_compare_skipped" | "skipped_not_shadow" | "skipped_error";
  shadowLogId?: string;
  comparisonScheduledAtSeconds?: number;
  reason?: string;
}

/**
 * Insert a `connection_shadow_log` row and enqueue the delayed comparison.
 *
 * Idempotency: the table has `UNIQUE(correlation_id, sku)` (migration
 * 20260424000002 §3 — to prevent double-logging when a parent push retries).
 * On conflict we log + return `logged_compare_skipped` rather than throw —
 * the original log row already drove a comparison enqueue; a second one
 * would just duplicate the v2 read.
 */
export async function recordShadowPush(
  params: RecordShadowPushParams,
): Promise<RecordShadowPushResult> {
  const {
    supabase,
    workspaceId,
    connectionId,
    sku,
    correlationId,
    pushedQuantity,
    cutoverStateAtPush,
    shadowWindowToleranceSeconds,
    metadata,
  } = params;

  // Defensive: hard-skip when the parent push didn't actually run in
  // shadow mode. Callers should only invoke this when cutover_state is
  // 'shadow', but if a future caller forgets, the shadow log shouldn't
  // accumulate noise from non-shadow pushes.
  if (cutoverStateAtPush !== "shadow") {
    return {
      status: "skipped_not_shadow",
      reason: `cutover_state_at_push='${cutoverStateAtPush}'`,
    };
  }

  // Clamp the comparison delay to the DB bounds. The CHECK constraint on
  // shadow_window_tolerance_seconds enforces 30..600 at write time, but a
  // null/undefined override falls through to the default and a malformed
  // override (e.g. 0 or 99999) gets bucketed back to a sane window.
  const requestedSeconds = shadowWindowToleranceSeconds ?? DEFAULT_SHADOW_WINDOW_SECONDS;
  const delaySeconds = Math.max(30, Math.min(600, Math.round(requestedSeconds)));
  const pushedAt = new Date().toISOString();

  try {
    const { data: inserted, error: insertError } = await supabase
      .from("connection_shadow_log")
      .insert({
        workspace_id: workspaceId,
        connection_id: connectionId,
        correlation_id: correlationId,
        sku,
        pushed_quantity: pushedQuantity,
        pushed_at: pushedAt,
        cutover_state_at_push: cutoverStateAtPush,
        metadata: metadata ?? null,
      })
      .select("id")
      .single();

    if (insertError) {
      // Treat unique-violation as a soft skip — the original push already
      // recorded a row + scheduled a comparison; a retry would double-read
      // v2. Anything else is a real bug; record it but do not throw.
      // PostgREST surfaces unique violations as `code: '23505'`.
      if ((insertError as { code?: string }).code === "23505") {
        return {
          status: "logged_compare_skipped",
          reason: "duplicate_correlation_id_sku",
        };
      }
      Sentry.captureException(insertError, {
        tags: { subsystem: "connection_shadow_log", phase: "insert" },
        extra: { workspaceId, connectionId, sku, correlationId },
      });
      return {
        status: "skipped_error",
        reason: insertError.message,
      };
    }

    const shadowLogId = inserted.id as string;
    const comparisonPayload: ShadowModeComparisonPayload = {
      shadowLogId,
      workspaceId,
      connectionId,
      sku,
      correlationId,
      pushedQuantity,
      pushedAt,
    };

    try {
      await tasks.trigger("shadow-mode-comparison", comparisonPayload, {
        delay: `${delaySeconds}s`,
        // Idempotency: a duplicated trigger on the same shadow log row
        // (e.g. shopify-CAS retry that re-enters the push hook) collides
        // here instead of producing two reads against v2.
        idempotencyKey: `shadow-mode-comparison:${shadowLogId}`,
      });
    } catch (triggerErr) {
      // The shadow row exists but the comparison didn't enqueue. Mark the
      // row so diagnostics can surface "scheduled but never compared"
      // separately from "compared and drift detected". Best-effort —
      // a UPDATE failure is logged but never thrown.
      Sentry.captureException(triggerErr, {
        tags: { subsystem: "connection_shadow_log", phase: "trigger_enqueue" },
        extra: { workspaceId, connectionId, sku, shadowLogId },
      });
      try {
        await supabase
          .from("connection_shadow_log")
          .update({
            metadata: { ...(metadata ?? {}), trigger_enqueue_error: String(triggerErr) },
          })
          .eq("id", shadowLogId);
      } catch {
        // ignore — we already captured to Sentry
      }
      return {
        status: "logged_compare_skipped",
        shadowLogId,
        reason: "trigger_enqueue_failed",
      };
    }

    return {
      status: "logged",
      shadowLogId,
      comparisonScheduledAtSeconds: delaySeconds,
    };
  } catch (err) {
    // Last-line defense: never let shadow logging abort the parent push.
    Sentry.captureException(err, {
      tags: { subsystem: "connection_shadow_log", phase: "outer" },
      extra: { workspaceId, connectionId, sku, correlationId },
    });
    return {
      status: "skipped_error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
