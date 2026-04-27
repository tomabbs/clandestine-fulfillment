"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import {
  type HoldRpcClient,
  type ReleaseOrderFulfillmentHoldResult,
  type ReleaseResolutionCode,
  releaseOrderFulfillmentHold,
} from "@/lib/server/order-hold-rpcs";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// Phase 6 Slice 6.C — Staff Server Actions for the /admin/orders/holds
// surface. Wraps the Phase 3 `release_order_fulfillment_hold` RPC via
// the TS wrapper at `src/lib/server/order-hold-rpcs.ts` so we keep the
// single entry point for hold state mutations (Rule-64 style audit).
//
// Contract:
//   * STAFF-ONLY. `requireStaff()` gates every action. RLS on
//     `warehouse_orders` restricts staff reads; we add the
//     `workspace_id=:caller` predicate for defense-in-depth so a
//     leaked service-role grant cannot fan a query across workspaces.
//   * READ + RELEASE ONLY. We never APPLY holds here — holds are only
//     created by the webhook ingress / hold evaluator. Staff can only
//     release what the system has already applied.
//   * BULK RELEASE is a sequential-for-loop wrapper around
//     `releaseOrderFulfillmentHold()`. It collects per-order results and
//     never aborts early on a single failure, which mirrors the
//     sku-hold-recovery-recheck task's behavior and lets the UI render
//     a partial-success report. The wrapper enforces the same
//     resolution-code + note invariants as the single release path
//     (`staff_override` requires a non-empty note).
//   * WORKSPACE-SCOPED. Every read query filters by `workspaceId`
//     BEFORE reaching the RPC so a mis-routed Server Action can never
//     mutate an out-of-workspace order.

const LIST_MAX_LIMIT = 200;
const BULK_MAX_ORDERS = 100;

const HOLD_REASONS = [
  "unknown_remote_sku",
  "placeholder_remote_sku",
  "non_warehouse_match",
  "fetch_incomplete_at_match",
] as const;

// STAFF-FACING release resolution codes only. `fetch_recovered_evaluator_passed`
// is intentionally excluded — per SKU-AUTO-32 that code is reserved for the
// `sku-hold-recovery-recheck` Trigger task and MUST NOT be accepted from a
// staff-initiated release. The broader `ReleaseResolutionCode` enum in
// `src/lib/server/order-hold-rpcs.ts` still allows it at the RPC layer for the
// recovery task's direct `releaseOrderFulfillmentHold()` call path.
const RESOLUTION_CODES = [
  "staff_override",
  "alias_learned",
  "manual_sku_fix",
  "order_cancelled",
] as const;

const listOrderHoldsInputSchema = z.object({
  reason: z.enum(HOLD_REASONS).optional(),
  connectionId: z.string().uuid().optional(),
  heldAfter: z.string().datetime().optional(),
  heldBefore: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  offset: z.number().int().min(0).default(0),
});

export type ListOrderHoldsInput = z.input<typeof listOrderHoldsInputSchema>;

export interface OrderHoldListRow {
  id: string;
  workspace_id: string;
  connection_id: string | null;
  external_order_id: string | null;
  order_number: string | null;
  fulfillment_hold: "no_hold" | "on_hold" | "released" | "cancelled";
  fulfillment_hold_reason: string | null;
  fulfillment_hold_at: string | null;
  fulfillment_hold_cycle_id: string | null;
  fulfillment_hold_metadata: Record<string, unknown> | null;
  fulfillment_hold_client_alerted_at: string | null;
  created_at: string;
}

export interface ListOrderHoldsResult {
  rows: OrderHoldListRow[];
  total: number;
  limit: number;
  offset: number;
  groupedByReason: Record<string, number>;
}

/**
 * List `warehouse_orders` currently in `fulfillment_hold='on_hold'` state,
 * filtered by reason / connection / date window. Returns both the rows
 * themselves and a per-reason count so the UI can render a grouped
 * summary without a second round-trip.
 */
export async function listOrderHolds(
  rawInput: ListOrderHoldsInput = {},
): Promise<ListOrderHoldsResult> {
  const { workspaceId } = await requireStaff();
  const input = listOrderHoldsInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_orders")
    .select(
      "id, workspace_id, connection_id, external_order_id, order_number, fulfillment_hold, fulfillment_hold_reason, fulfillment_hold_at, fulfillment_hold_cycle_id, fulfillment_hold_metadata, fulfillment_hold_client_alerted_at, created_at",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .eq("fulfillment_hold", "on_hold");

  if (input.reason !== undefined) {
    query = query.eq("fulfillment_hold_reason", input.reason);
  }
  if (input.connectionId !== undefined) {
    query = query.eq("connection_id", input.connectionId);
  }
  if (input.heldAfter !== undefined) {
    query = query.gte("fulfillment_hold_at", input.heldAfter);
  }
  if (input.heldBefore !== undefined) {
    query = query.lte("fulfillment_hold_at", input.heldBefore);
  }

  const { data, count, error } = await query
    .order("fulfillment_hold_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw new Error(`listOrderHolds failed: ${error.message}`);
  }

  const rows = (data ?? []) as OrderHoldListRow[];

  // Compute per-reason grouping across the PAGE. The UI treats this as
  // a summary of the current view; a true workspace-wide count per
  // reason is a separate aggregation (not exposed yet).
  const groupedByReason: Record<string, number> = {};
  for (const row of rows) {
    const key = row.fulfillment_hold_reason ?? "unknown";
    groupedByReason[key] = (groupedByReason[key] ?? 0) + 1;
  }

  return {
    rows,
    total: count ?? 0,
    limit: input.limit,
    offset: input.offset,
    groupedByReason,
  };
}

const releaseOrderHoldInputSchema = z
  .object({
    orderId: z.string().uuid(),
    resolutionCode: z.enum(RESOLUTION_CODES),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.resolutionCode === "staff_override") {
      const note = val.note?.trim() ?? "";
      if (note.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "staff_override requires a non-empty note",
          path: ["note"],
        });
      }
    }
  });

export type ReleaseOrderHoldInput = z.input<typeof releaseOrderHoldInputSchema>;

export type ReleaseOrderHoldActionResult =
  | { ok: true; orderId: string; holdEventId: string; idempotent: boolean }
  | {
      ok: false;
      orderId: string;
      reason: string;
      detail?: string;
    };

/**
 * Release a single order hold. Gates the target order to the caller's
 * workspace before delegating to the RPC wrapper so a leaked
 * service-role grant cannot release an out-of-workspace order via this
 * action.
 */
export async function releaseOrderHold(
  rawInput: ReleaseOrderHoldInput,
): Promise<ReleaseOrderHoldActionResult> {
  const { workspaceId, userId } = await requireStaff();
  const input = releaseOrderHoldInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  // Defense-in-depth: confirm the order belongs to the caller's
  // workspace and is actually on_hold BEFORE touching the RPC.
  const { data: orderRow, error: orderErr } = await supabase
    .from("warehouse_orders")
    .select("id, workspace_id, fulfillment_hold")
    .eq("id", input.orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (orderErr) {
    return {
      ok: false,
      orderId: input.orderId,
      reason: "read_failed",
      detail: orderErr.message,
    };
  }
  if (!orderRow) {
    return { ok: false, orderId: input.orderId, reason: "order_not_in_workspace" };
  }
  if (orderRow.fulfillment_hold !== "on_hold") {
    return {
      ok: false,
      orderId: input.orderId,
      reason: "order_not_on_hold",
      detail: `current state: ${orderRow.fulfillment_hold}`,
    };
  }

  const result: ReleaseOrderFulfillmentHoldResult = await releaseOrderFulfillmentHold(
    supabase as unknown as HoldRpcClient,
    {
      orderId: input.orderId,
      resolutionCode: input.resolutionCode as ReleaseResolutionCode,
      note: input.note ?? null,
      actorKind: "user",
      actorId: userId,
      metadata: {
        workspace_id: workspaceId,
        entry_point: "admin.releaseOrderHold",
      },
    },
  );

  if (!result.ok) {
    return {
      ok: false,
      orderId: input.orderId,
      reason: result.reason,
      detail: "detail" in result ? result.detail : undefined,
    };
  }

  revalidatePath("/admin/orders/holds");

  return {
    ok: true,
    orderId: input.orderId,
    holdEventId: result.holdEventId,
    idempotent: result.idempotent,
  };
}

const releaseOrderHoldsBulkInputSchema = z
  .object({
    orderIds: z.array(z.string().uuid()).min(1).max(BULK_MAX_ORDERS),
    resolutionCode: z.enum(RESOLUTION_CODES),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.resolutionCode === "staff_override") {
      const note = val.note?.trim() ?? "";
      if (note.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "staff_override requires a non-empty note",
          path: ["note"],
        });
      }
    }
  });

export type ReleaseOrderHoldsBulkInput = z.input<typeof releaseOrderHoldsBulkInputSchema>;

export interface ReleaseOrderHoldsBulkResult {
  succeeded: Array<{ orderId: string; holdEventId: string; idempotent: boolean }>;
  failed: Array<{ orderId: string; reason: string; detail?: string }>;
}

/**
 * Release several order holds in a single invocation. Runs releases
 * sequentially so the surrounding transaction boundary stays predictable
 * and so one bad order never stalls the rest. Returns a full per-order
 * outcome so the UI can render a partial-success report.
 */
export async function releaseOrderHoldsBulk(
  rawInput: ReleaseOrderHoldsBulkInput,
): Promise<ReleaseOrderHoldsBulkResult> {
  const { workspaceId, userId } = await requireStaff();
  const input = releaseOrderHoldsBulkInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  // Pre-fetch eligibility — every ID must belong to the caller's
  // workspace and be currently on_hold, or it's dropped to `failed`
  // without even calling the RPC.
  const { data: orderRows, error: orderErr } = await supabase
    .from("warehouse_orders")
    .select("id, workspace_id, fulfillment_hold")
    .in("id", input.orderIds)
    .eq("workspace_id", workspaceId);

  if (orderErr) {
    throw new Error(`releaseOrderHoldsBulk read failed: ${orderErr.message}`);
  }

  const eligibleById = new Map<string, "on_hold" | "no_hold" | "released" | "cancelled">();
  for (const row of orderRows ?? []) {
    const r = row as { id: string; fulfillment_hold: string };
    eligibleById.set(r.id, r.fulfillment_hold as "on_hold" | "no_hold" | "released" | "cancelled");
  }

  const succeeded: ReleaseOrderHoldsBulkResult["succeeded"] = [];
  const failed: ReleaseOrderHoldsBulkResult["failed"] = [];

  for (const orderId of input.orderIds) {
    const state = eligibleById.get(orderId);
    if (state === undefined) {
      failed.push({ orderId, reason: "order_not_in_workspace" });
      continue;
    }
    if (state !== "on_hold") {
      failed.push({
        orderId,
        reason: "order_not_on_hold",
        detail: `current state: ${state}`,
      });
      continue;
    }

    const result: ReleaseOrderFulfillmentHoldResult = await releaseOrderFulfillmentHold(
      supabase as unknown as HoldRpcClient,
      {
        orderId,
        resolutionCode: input.resolutionCode as ReleaseResolutionCode,
        note: input.note ?? null,
        actorKind: "user",
        actorId: userId,
        metadata: {
          workspace_id: workspaceId,
          entry_point: "admin.releaseOrderHoldsBulk",
          bulk_size: input.orderIds.length,
        },
      },
    );

    if (!result.ok) {
      failed.push({
        orderId,
        reason: result.reason,
        detail: "detail" in result ? result.detail : undefined,
      });
    } else {
      succeeded.push({
        orderId,
        holdEventId: result.holdEventId,
        idempotent: result.idempotent,
      });
    }
  }

  revalidatePath("/admin/orders/holds");

  return { succeeded, failed };
}
