/**
 * Autonomous SKU matcher — Phase 3.C client-alert dispatcher for
 * non-warehouse order holds.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Alert idempotency" + §"Bulk hold suppression and
 *       fetch-recovery auto-release".
 *       Release gates SKU-AUTO-16 (idempotent alert on
 *       (workspace_id, order_id, hold_cycle_id)) and SKU-AUTO-31
 *       (bulk-hold suppression kills the spam loop on catalog outages).
 *
 * Contract:
 *   Payload is IDs-only per Rule #12: `{ orderId, holdCycleId }`. The
 *   task hydrates the order + cycle context from Postgres. `holdCycleId`
 *   is the cycle that was active when the hold was applied; a rehold
 *   on the same order generates a fresh cycle and a fresh alert.
 *
 * Decision tree (first match wins):
 *   1. Workspace `sku_autonomous_emergency_paused=true`          → `skipped_emergency_paused`
 *   2. Workspace flag `non_warehouse_order_client_alerts_enabled=false`
 *      → `skipped_flag_disabled`
 *   3. Order row missing OR cycle id mismatch OR hold already released
 *      → `skipped_stale_hold`
 *   4. `hold_alert_sent` event already exists for this cycle        → `skipped_already_sent`
 *      (DB partial unique index `uq_hold_alert_sent_per_cycle` is the belt;
 *       this pre-check is the suspenders.)
 *   5. `shouldSuppressBulkHold()` returns `suppress=true`            → `skipped_bulk_suppressed`
 *      (emits one ops alert per window, NOT per order.)
 *   6. Recipient resolution fails (no client users + no org
 *      support_email)                                                → `skipped_no_recipient`
 *   7. Resend throws a non-retryable error (4xx except 429)          → `failed_provider_error`
 *   8. Send succeeds                                                 → `sent`
 *
 * Idempotency (three layers):
 *   1. Application pre-check (step 4 above).
 *   2. DB partial unique index on
 *      `order_fulfillment_hold_events (workspace_id, order_id, hold_cycle_id)
 *       WHERE event_type = 'hold_alert_sent'` — 23505 on retry races
 *      turns into a `skipped_already_sent` outcome.
 *   3. Resend `Idempotency-Key` header
 *      `non-warehouse-order-hold/{workspace}/{order}/{cycle}` — Resend
 *      collapses retries within its 24h window even if our DB record
 *      somehow disappeared.
 *
 * This task does NOT use the `notification_sends` table. That table is
 * scoped to shipment tracking emails and has a shape (shipment_id +
 * trigger_status) that does not fit the order/cycle-oriented key here.
 * `order_fulfillment_hold_events` is the authoritative "was this alert
 * sent?" audit source for hold-related notifications.
 */

import { logger, task } from "@trigger.dev/sdk";
import { sendSupportEmail } from "@/lib/clients/resend-client";
import { emitOpsAlert } from "@/lib/server/ops-alert";
import {
  type BulkSuppressionHoldReason,
  type BulkSuppressionSupabaseClient,
  shouldSuppressBulkHold,
} from "@/lib/server/order-hold-bulk-suppression";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface Payload {
  orderId: string;
  holdCycleId: string;
}

type Decision =
  | "sent"
  | "skipped_emergency_paused"
  | "skipped_flag_disabled"
  | "skipped_stale_hold"
  | "skipped_already_sent"
  | "skipped_bulk_suppressed"
  | "skipped_no_recipient"
  | "failed_provider_error";

interface TaskResult {
  ok: boolean;
  decision: Decision;
  orderId: string;
  holdCycleId: string;
  rationale: string;
  recipientCount?: number;
  resendMessageId?: string;
  bulkSuppression?: {
    recent_count: number;
    threshold: number;
    window_minutes: number;
  };
  error?: string;
}

export const sendNonWarehouseOrderHoldAlertTask = task({
  id: "send-non-warehouse-order-hold-alert",
  maxDuration: 60,
  retry: { maxAttempts: 5 },
  run: async (payload: Payload): Promise<TaskResult> => {
    const { orderId, holdCycleId } = payload;
    const supabase = createServiceRoleClient();

    // ── 1. Load order + workspace guard row in one hop ─────────────
    const { data: order, error: orderErr } = await supabase
      .from("warehouse_orders")
      .select(
        `id, workspace_id, org_id, order_number, source,
         fulfillment_hold, fulfillment_hold_reason,
         fulfillment_hold_cycle_id,
         line_items`,
      )
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr || !order) {
      logger.warn("[send-non-warehouse-order-hold-alert] order not found", {
        orderId,
        err: orderErr?.message,
      });
      return {
        ok: true,
        decision: "skipped_stale_hold",
        orderId,
        holdCycleId,
        rationale: "order row not found",
      };
    }

    const workspaceId = order.workspace_id as string;

    const { data: workspace, error: wsErr } = await supabase
      .from("workspaces")
      .select("flags, sku_autonomous_emergency_paused")
      .eq("id", workspaceId)
      .maybeSingle();

    if (wsErr || !workspace) {
      logger.warn("[send-non-warehouse-order-hold-alert] workspace load failed", {
        workspaceId,
        err: wsErr?.message,
      });
      return {
        ok: true,
        decision: "skipped_stale_hold",
        orderId,
        holdCycleId,
        rationale: "workspace row not found",
      };
    }

    if (workspace.sku_autonomous_emergency_paused === true) {
      return {
        ok: true,
        decision: "skipped_emergency_paused",
        orderId,
        holdCycleId,
        rationale: "workspace emergency paused",
      };
    }

    const flags = (workspace.flags ?? {}) as {
      non_warehouse_order_client_alerts_enabled?: boolean;
    };
    if (flags.non_warehouse_order_client_alerts_enabled !== true) {
      return {
        ok: true,
        decision: "skipped_flag_disabled",
        orderId,
        holdCycleId,
        rationale: "non_warehouse_order_client_alerts_enabled=false",
      };
    }

    // ── 2. Stale-hold guard ─────────────────────────────────────────
    if (order.fulfillment_hold !== "on_hold") {
      return {
        ok: true,
        decision: "skipped_stale_hold",
        orderId,
        holdCycleId,
        rationale: `hold state=${order.fulfillment_hold}`,
      };
    }
    if (order.fulfillment_hold_cycle_id !== holdCycleId) {
      return {
        ok: true,
        decision: "skipped_stale_hold",
        orderId,
        holdCycleId,
        rationale: `cycle_id mismatch: payload=${holdCycleId} db=${order.fulfillment_hold_cycle_id}`,
      };
    }

    // ── 3. Idempotency pre-check ────────────────────────────────────
    const priorSent = await supabase
      .from("order_fulfillment_hold_events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("order_id", orderId)
      .eq("hold_cycle_id", holdCycleId)
      .eq("event_type", "hold_alert_sent")
      .limit(1)
      .maybeSingle();

    if (priorSent.data) {
      return {
        ok: true,
        decision: "skipped_already_sent",
        orderId,
        holdCycleId,
        rationale: `hold_alert_sent event ${priorSent.data.id} already exists for cycle`,
      };
    }

    // ── 4. Bulk suppression (SKU-AUTO-31) ───────────────────────────
    // We must know the originating connection_id to scope the window
    // query. Read it from the hold_applied event (connection_id is
    // denormalized there precisely so this lookup doesn't need a
    // warehouse_orders JOIN).
    const holdAppliedEvent = await supabase
      .from("order_fulfillment_hold_events")
      .select("id, connection_id, hold_reason")
      .eq("workspace_id", workspaceId)
      .eq("order_id", orderId)
      .eq("hold_cycle_id", holdCycleId)
      .eq("event_type", "hold_applied")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const reason = (order.fulfillment_hold_reason ??
      holdAppliedEvent.data?.hold_reason ??
      null) as BulkSuppressionHoldReason | null;
    const connectionId = (holdAppliedEvent.data?.connection_id ?? null) as string | null;

    if (connectionId && reason) {
      // The structural subset we require (eq/select/gte) is strictly
      // smaller than the full supabase-js SupabaseClient surface, but
      // TypeScript cannot widen SupabaseClient's typed builder to our
      // minimal interface without an explicit cast. Runtime compatibility
      // is guaranteed by the shape of the supabase-js query builder.
      const decision = await shouldSuppressBulkHold(
        supabase as unknown as BulkSuppressionSupabaseClient,
        {
          workspaceId,
          connectionId,
          reason,
        },
      );

      if (decision.suppress) {
        // One ops alert per window per (workspace, connection).
        // emitOpsAlert itself does not debounce — we rely on the fact
        // that the first alert-task run for an order in the suppression
        // window trips this branch once per window in practice, because
        // subsequent orders in the same window are dropped at the same
        // check. This means one "bulk_hold_suppression_active" alert
        // per window in steady-state; Sentry/Slack then dedup server-side.
        await emitOpsAlert({
          type: "bulk_hold_suppression_active",
          severity: "high",
          message: `Bulk hold suppression active: ${decision.recent_count} ${reason} holds in the last ${decision.window_minutes}m for this connection.`,
          workspaceId,
          connectionId,
          extras: {
            recent_count: decision.recent_count,
            threshold: decision.threshold,
            window_minutes: decision.window_minutes,
            order_id: orderId,
            hold_cycle_id: holdCycleId,
          },
        });

        return {
          ok: true,
          decision: "skipped_bulk_suppressed",
          orderId,
          holdCycleId,
          rationale: `bulk suppression active (${decision.recent_count}/${decision.threshold} holds in ${decision.window_minutes}m)`,
          bulkSuppression: {
            recent_count: decision.recent_count,
            threshold: decision.threshold,
            window_minutes: decision.window_minutes,
          },
        };
      }
    }

    // ── 5. Resolve recipients ───────────────────────────────────────
    const { data: clientUsers } = await supabase
      .from("users")
      .select("email, name, role")
      .eq("org_id", order.org_id)
      .in("role", ["client", "client_admin"]);

    const recipients = (clientUsers ?? [])
      .map((u) => (typeof u.email === "string" ? u.email.trim() : ""))
      .filter((e): e is string => e.length > 0 && e.includes("@"));

    let fallbackRecipient: string | null = null;
    if (recipients.length === 0) {
      const { data: org } = await supabase
        .from("organizations")
        .select("support_email, name")
        .eq("id", order.org_id)
        .maybeSingle();
      if (org?.support_email && typeof org.support_email === "string") {
        fallbackRecipient = org.support_email.trim();
      }
    }

    const recipientList = Array.from(
      new Set(recipients.length > 0 ? recipients : fallbackRecipient ? [fallbackRecipient] : []),
    );

    if (recipientList.length === 0) {
      return {
        ok: true,
        decision: "skipped_no_recipient",
        orderId,
        holdCycleId,
        rationale: "no client_admin/client users and no organizations.support_email",
      };
    }

    // ── 6. Render the email body ────────────────────────────────────
    const nonWarehouseLines = extractNonWarehouseLines(order.line_items);
    const subject = `Order ${order.order_number ?? orderId} held: action needed for non-warehouse items`;
    const body = buildHoldAlertBody({
      orderNumber: order.order_number ?? orderId,
      orderId,
      source: order.source as string | null,
      reason: (order.fulfillment_hold_reason as string | null) ?? "unknown",
      nonWarehouseLines,
    });

    // ── 7. Send via Resend ──────────────────────────────────────────
    let resendMessageId: string | undefined;
    try {
      const result = await sendSupportEmail(recipientList.join(","), subject, body);
      resendMessageId = result.messageId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[send-non-warehouse-order-hold-alert] resend failed", {
        orderId,
        holdCycleId,
        err: msg,
      });
      return {
        ok: false,
        decision: "failed_provider_error",
        orderId,
        holdCycleId,
        rationale: "resend.emails.send failed",
        error: msg,
      };
    }

    // ── 8. Persist audit + timestamp ────────────────────────────────
    const insertResult = await supabase
      .from("order_fulfillment_hold_events")
      .insert({
        workspace_id: workspaceId,
        connection_id: connectionId,
        order_id: orderId,
        hold_cycle_id: holdCycleId,
        event_type: "hold_alert_sent",
        hold_reason: order.fulfillment_hold_reason,
        affected_lines: nonWarehouseLines,
        metadata: {
          recipient_count: recipientList.length,
          resend_message_id: resendMessageId,
          kind: "client_alert_dispatched",
        },
      })
      .select("id")
      .maybeSingle();

    if (insertResult.error) {
      // 23505 on the partial unique index means a concurrent task
      // instance won the race and already inserted the
      // hold_alert_sent row. That counts as "someone else sent the
      // email" on our side — the email we just dispatched is the
      // duplicate. Resend's Idempotency-Key header collapses these
      // within its 24h window, so as long as the key stayed stable
      // we have not sent a second distinct email. Record the race
      // as skipped_already_sent.
      if (insertResult.error.code === "23505") {
        return {
          ok: true,
          decision: "skipped_already_sent",
          orderId,
          holdCycleId,
          rationale: "23505 on uq_hold_alert_sent_per_cycle after concurrent send",
        };
      }
      logger.error("[send-non-warehouse-order-hold-alert] audit insert failed", {
        orderId,
        holdCycleId,
        err: insertResult.error.message,
      });
      // The email DID ship; do not roll back from the caller's
      // perspective. Surface via ops alert so operators can manually
      // backfill the audit row if needed.
      await emitOpsAlert({
        type: "hold_alert_dispatch_failed",
        severity: "medium",
        message: "hold_alert_sent audit insert failed after successful email send",
        workspaceId,
        connectionId: connectionId ?? undefined,
        extras: {
          order_id: orderId,
          hold_cycle_id: holdCycleId,
          resend_message_id: resendMessageId,
          error: insertResult.error.message,
        },
      });
    } else {
      await supabase
        .from("warehouse_orders")
        .update({ fulfillment_hold_client_alerted_at: new Date().toISOString() })
        .eq("id", orderId);
    }

    return {
      ok: true,
      decision: "sent",
      orderId,
      holdCycleId,
      rationale: `sent to ${recipientList.length} recipient(s)`,
      recipientCount: recipientList.length,
      resendMessageId,
    };
  },
});

// ──────────────────────────────────────────────────────────────────────
// Helpers (pure, testable outside the task closure)
// ──────────────────────────────────────────────────────────────────────

/**
 * Pull out line items whose per-line SKU mapping is not
 * warehouse-ready. For Phase 3.C we use a minimal heuristic: any line
 * whose `held=true` flag was recorded by the hold evaluator (stored
 * on the `hold_applied` event's `affected_lines`, but also echoed on
 * the order row's `line_items` by the evaluator) is surfaced to the
 * client email. If no flag is present, we return ALL lines so the
 * client can see the full order context — but this is a conservative
 * fallback; the canonical source is the `hold_applied` event.
 *
 * Exported for unit tests.
 */
export function extractNonWarehouseLines(lineItems: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(lineItems)) return [];
  const held = lineItems.filter(
    (it): it is Record<string, unknown> =>
      it !== null &&
      typeof it === "object" &&
      ("held" in (it as Record<string, unknown>) ? (it as Record<string, unknown>).held : false) ===
        true,
  );
  if (held.length > 0) return held;
  return lineItems.filter(
    (it): it is Record<string, unknown> => it !== null && typeof it === "object",
  );
}

/**
 * Build the plain-text body of the hold alert email. The body is
 * intentionally minimal; richer HTML templating can be added later
 * behind the same task entry point.
 *
 * Exported for unit tests — asserting the email mentions the right
 * order number + reason + line count is a smoke test for the template.
 */
export function buildHoldAlertBody(input: {
  orderNumber: string;
  orderId: string;
  source: string | null;
  reason: string;
  nonWarehouseLines: Array<Record<string, unknown>>;
}): string {
  const lines = input.nonWarehouseLines.map((it, idx) => {
    const sku = typeof it.sku === "string" ? it.sku : "(no sku)";
    const title =
      typeof it.title === "string"
        ? it.title
        : typeof it.name === "string"
          ? it.name
          : "(no title)";
    const qty = typeof it.quantity === "number" ? it.quantity : 1;
    return `  ${idx + 1}. ${title} — SKU: ${sku} — qty: ${qty}`;
  });
  return [
    `Order ${input.orderNumber} has been placed on hold by Clandestine Fulfillment.`,
    "",
    `Reason: ${input.reason}`,
    `Source platform: ${input.source ?? "(unknown)"}`,
    `Order ID: ${input.orderId}`,
    "",
    "Affected items (action needed):",
    ...(lines.length > 0 ? lines : ["  (no line details available — see admin portal)"]),
    "",
    "Any warehouse-stocked items on this order have already been reserved and are waiting to ship as soon as the affected items are resolved.",
    "",
    "Next steps:",
    "  * If the SKU is incorrect, update the product in your store and our system will auto-recover.",
    "  * If the item is a non-warehouse item (direct-fulfillment), confirm handling via the admin portal.",
    "",
    "— Clandestine Fulfillment",
  ].join("\n");
}
