/**
 * Phase 5b — platform fulfillment writeback ledger helper.
 *
 * Single owner for writes to `platform_fulfillment_writebacks` and
 * `platform_fulfillment_writeback_lines`. Order-level status is derived
 * from the line statuses (Rule §Phase 5b in the Order Pages Transition
 * plan) so multi-shipment direct orders cannot be falsely reported as
 * succeeded after only the first shipment writes back.
 *
 * Usage shape:
 *   const ledger = await openWriteback({ ... });
 *   try {
 *     await callPlatform(...);
 *     await ledger.recordSuccess({ lineKey, ... });
 *   } catch (e) {
 *     await ledger.recordFailure({ lineKey, ... });
 *   }
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@trigger.dev/sdk";

export type PlatformFulfillmentWritebackStatus =
  | "pending"
  | "in_progress"
  | "succeeded"
  | "partial_succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "not_required"
  | "blocked_missing_identity"
  | "blocked_bandcamp_generic_path";

export type PlatformFulfillmentWritebackLineStatus =
  | "pending"
  | "in_progress"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "not_required";

export interface OpenWritebackArgs {
  supabase: SupabaseClient;
  workspaceId: string;
  warehouseOrderId: string;
  shipmentId: string | null;
  platform: string;
  connectionId: string | null;
  externalOrderId: string | null;
  /** Per-line items being attempted in this writeback. */
  lines: Array<{
    warehouseOrderItemId: string;
    quantity: number;
    externalLineId?: string | null;
  }>;
  requestSummary?: Record<string, unknown>;
}

export interface WritebackLedger {
  writebackId: string;
  /** Mark a single line as succeeded or failed and recompute the order-level status. */
  recordLine: (args: {
    warehouseOrderItemId: string;
    status: PlatformFulfillmentWritebackLineStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    responseSummary?: Record<string, unknown>;
  }) => Promise<void>;
  /** Mark all lines with one terminal status — convenience for "all-or-nothing" platforms. */
  recordAll: (args: {
    status: PlatformFulfillmentWritebackLineStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    responseSummary?: Record<string, unknown>;
  }) => Promise<void>;
  /** Force the order-level status (e.g. blocked_*). Lines remain unchanged. */
  forceOrderStatus: (
    status: PlatformFulfillmentWritebackStatus,
    extra?: { errorCode?: string | null; errorMessage?: string | null },
  ) => Promise<void>;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export async function openWriteback(args: OpenWritebackArgs): Promise<WritebackLedger> {
  const { supabase } = args;

  const dedupShipment = args.shipmentId ?? ZERO_UUID;

  // Upsert the parent row on the dedup index (warehouse_order_id, shipment_id, platform).
  const { data: existing } = await supabase
    .from("platform_fulfillment_writebacks")
    .select("id, attempt_count")
    .eq("warehouse_order_id", args.warehouseOrderId)
    .eq("platform", args.platform)
    .eq("shipment_id", args.shipmentId as string)
    .maybeSingle();

  let writebackId: string;
  if (existing) {
    writebackId = existing.id as string;
    await supabase
      .from("platform_fulfillment_writebacks")
      .update({
        status: "in_progress",
        attempt_count: (existing.attempt_count as number) + 1,
        last_attempt_at: new Date().toISOString(),
        connection_id: args.connectionId,
        external_order_id: args.externalOrderId,
        request_summary: args.requestSummary ?? {},
        updated_at: new Date().toISOString(),
      })
      .eq("id", writebackId);
  } else {
    const { data: inserted, error } = await supabase
      .from("platform_fulfillment_writebacks")
      .insert({
        workspace_id: args.workspaceId,
        warehouse_order_id: args.warehouseOrderId,
        shipment_id: args.shipmentId,
        platform: args.platform,
        connection_id: args.connectionId,
        external_order_id: args.externalOrderId,
        status: "in_progress",
        attempt_count: 1,
        last_attempt_at: new Date().toISOString(),
        request_summary: args.requestSummary ?? {},
      })
      .select("id")
      .single();
    if (error || !inserted) {
      throw new Error(`Failed to open writeback ledger: ${error?.message ?? "no row"}`);
    }
    writebackId = inserted.id as string;
    void dedupShipment; // suppress unused — index uses coalesce(shipment_id, ZERO_UUID)
  }

  // Upsert all line rows as in_progress.
  if (args.lines.length > 0) {
    const lineRows = args.lines.map((l) => ({
      writeback_id: writebackId,
      warehouse_order_item_id: l.warehouseOrderItemId,
      quantity_fulfilled: l.quantity,
      external_line_id: l.externalLineId ?? null,
      status: "in_progress" as PlatformFulfillmentWritebackLineStatus,
      attempt_count: 1,
      last_attempt_at: new Date().toISOString(),
    }));
    const { error: linesErr } = await supabase
      .from("platform_fulfillment_writeback_lines")
      .upsert(lineRows, { onConflict: "writeback_id,warehouse_order_item_id" });
    if (linesErr) {
      logger.warn("openWriteback: line upsert failed", {
        writebackId,
        error: linesErr.message,
      });
    }
  }

  const recomputeOrderStatus = async () => {
    const { data: lineRows } = await supabase
      .from("platform_fulfillment_writeback_lines")
      .select("status")
      .eq("writeback_id", writebackId);
    const statuses = (lineRows ?? []).map(
      (r) => (r as { status: PlatformFulfillmentWritebackLineStatus }).status,
    );
    if (statuses.length === 0) return;
    const allSucceeded = statuses.every((s) => s === "succeeded" || s === "not_required");
    const anySucceeded = statuses.some((s) => s === "succeeded");
    const anyFailedTerminal = statuses.some((s) => s === "failed_terminal");
    const anyFailedRetryable = statuses.some((s) => s === "failed_retryable");
    const anyInProgress = statuses.some((s) => s === "in_progress");
    let orderStatus: PlatformFulfillmentWritebackStatus;
    let succeededAt: string | null = null;
    let failedAt: string | null = null;
    if (allSucceeded) {
      orderStatus = "succeeded";
      succeededAt = new Date().toISOString();
    } else if (anySucceeded && (anyFailedTerminal || anyFailedRetryable)) {
      orderStatus = "partial_succeeded";
    } else if (anyFailedTerminal && !anyInProgress) {
      orderStatus = "failed_terminal";
      failedAt = new Date().toISOString();
    } else if (anyFailedRetryable && !anyInProgress) {
      orderStatus = "failed_retryable";
    } else {
      orderStatus = "in_progress";
    }
    await supabase
      .from("platform_fulfillment_writebacks")
      .update({
        status: orderStatus,
        succeeded_at: succeededAt,
        failed_at: failedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", writebackId);
  };

  return {
    writebackId,
    async recordLine(line) {
      await supabase
        .from("platform_fulfillment_writeback_lines")
        .update({
          status: line.status,
          error_code: line.errorCode ?? null,
          error_message: line.errorMessage ?? null,
          response_summary: line.responseSummary ?? {},
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("writeback_id", writebackId)
        .eq("warehouse_order_item_id", line.warehouseOrderItemId);
      await recomputeOrderStatus();
    },
    async recordAll(line) {
      await supabase
        .from("platform_fulfillment_writeback_lines")
        .update({
          status: line.status,
          error_code: line.errorCode ?? null,
          error_message: line.errorMessage ?? null,
          response_summary: line.responseSummary ?? {},
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("writeback_id", writebackId);
      await recomputeOrderStatus();
    },
    async forceOrderStatus(status, extra) {
      await supabase
        .from("platform_fulfillment_writebacks")
        .update({
          status,
          error_code: extra?.errorCode ?? null,
          error_message: extra?.errorMessage ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", writebackId);
    },
  };
}

/**
 * Idempotent guard so callers can record a "blocked" writeback row without
 * pretending an attempt was made. Used by the Bandcamp generic-path
 * protection in mark-platform-fulfilled.
 */
export async function recordBlockedWriteback(args: {
  supabase: SupabaseClient;
  workspaceId: string;
  warehouseOrderId: string;
  shipmentId?: string | null;
  platform: string;
  status: Extract<
    PlatformFulfillmentWritebackStatus,
    "blocked_missing_identity" | "blocked_bandcamp_generic_path" | "not_required"
  >;
  reason?: string;
}): Promise<void> {
  const { data: existing } = await args.supabase
    .from("platform_fulfillment_writebacks")
    .select("id")
    .eq("warehouse_order_id", args.warehouseOrderId)
    .eq("platform", args.platform)
    .eq("shipment_id", (args.shipmentId ?? null) as string)
    .maybeSingle();
  if (existing) {
    await args.supabase
      .from("platform_fulfillment_writebacks")
      .update({
        status: args.status,
        error_message: args.reason ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id as string);
    return;
  }
  await args.supabase.from("platform_fulfillment_writebacks").insert({
    workspace_id: args.workspaceId,
    warehouse_order_id: args.warehouseOrderId,
    shipment_id: args.shipmentId ?? null,
    platform: args.platform,
    status: args.status,
    error_message: args.reason ?? null,
    attempt_count: 0,
  });
}
