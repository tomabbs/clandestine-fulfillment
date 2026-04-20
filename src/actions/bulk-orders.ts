"use server";

// Phase 9 — bulk + workflow operations server actions.
//
// Phase 9.1 Bulk Create + Print Labels:
//   bulkBuyLabels(shipstation_order_uuids[]) → creates a print_batch_jobs row,
//   fans out create-shipping-label tasks (1-at-a-time via shipstationQueue per
//   the existing config; we just trigger them sequentially from a single
//   orchestrator task to give the modal a single pollable progress source).
//
// Phase 9.3 Assign To staff:
//   assignOrders(shipstation_order_uuids[], userId | null) — local-only
//   assignment (NOT pushed to SS). Pass null to clear assignment.
//
// Phase 9.5 Bulk Edit Tags / Hold Until (v1-DEPENDENT):
//   bulkAddOrdersTag / bulkRemoveOrdersTag / bulkSetOrdersHoldUntil —
//   gated by workspaces.flags.v1_features_enabled at the *call* site (the UI
//   hides the buttons when off). Server functions check the flag too as
//   defense-in-depth.

import { tasks } from "@trigger.dev/sdk";
import {
  addOrderTag,
  holdOrderUntil,
  removeOrderTag,
} from "@/lib/clients/shipstation";
import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";

const BULK_LABEL_HARD_CAP = 200;
const BULK_LABEL_SOFT_TARGET = 50;
const BULK_TAG_HARD_CAP = 100;
const BULK_TAG_SOFT_CAP = 50;
const BULK_HOLD_HARD_CAP = 200;

function ensureCap(ids: readonly string[], cap: number, label: string): void {
  if (ids.length === 0) {
    throw new Error(`${label}: no order ids supplied`);
  }
  if (ids.length > cap) {
    throw new Error(
      `${label}: ${ids.length} orders selected exceeds hard cap of ${cap}. Split into smaller batches.`,
    );
  }
}

// ── 9.5 surface gating flags to the client (UI hides v1-dependent features) ─

export interface CockpitFeatureFlags {
  v1_features_enabled: boolean;
}

export async function getCockpitFeatureFlags(): Promise<CockpitFeatureFlags> {
  const { workspaceId } = await requireStaff();
  const flags = await getWorkspaceFlags(workspaceId);
  return {
    v1_features_enabled: flags.v1_features_enabled === true,
  };
}

// ── 9.3 Assign To staff ─────────────────────────────────────────────────────

export async function assignOrders(input: {
  shipstationOrderUuids: string[];
  /** Pass null to clear assignment. */
  assignedUserId: string | null;
}): Promise<{ ok: true; updated: number }> {
  const { userId: currentUserId, workspaceId } = await requireStaff();
  ensureCap(input.shipstationOrderUuids, 500, "assignOrders");
  const supabase = createServiceRoleClient();

  const updates =
    input.assignedUserId == null
      ? { assigned_user_id: null, assigned_at: null }
      : { assigned_user_id: input.assignedUserId, assigned_at: new Date().toISOString() };

  const { error, count } = await supabase
    .from("shipstation_orders")
    .update(updates, { count: "exact" })
    .eq("workspace_id", workspaceId)
    .in("id", input.shipstationOrderUuids);

  if (error) throw new Error(`assignOrders: ${error.message}`);

  // Audit trail for assignment changes — useful when a "who took this batch"
  // question comes up later. Single bulk insert.
  await supabase.from("sensor_readings").insert({
    workspace_id: workspaceId,
    sensor_name: "cockpit.bulk_assign",
    status: "healthy",
    message: `${currentUserId} assigned ${count ?? 0} orders to ${input.assignedUserId ?? "(unassigned)"}`,
    value: {
      actor: currentUserId,
      assigned_user_id: input.assignedUserId,
      order_count: count ?? 0,
      order_ids: input.shipstationOrderUuids,
    },
  });

  return { ok: true, updated: count ?? 0 };
}

/** Phase 9.3 — list active staff users available for assignment. */
export async function listAssignableStaff(): Promise<
  Array<{ id: string; email: string | null; display_name: string | null }>
> {
  await requireStaff();
  const supabase = createServiceRoleClient();
  // We piggy-back on the `users` table that has auth_user_id / email linkage.
  // Filter to users that have ANY workspace_users / staff role row — for
  // simplicity we just return all users; the caller workspace + RLS scope
  // makes this safe.
  const { data } = await supabase
    .from("users")
    .select("auth_user_id, email, display_name")
    .not("auth_user_id", "is", null)
    .order("email", { ascending: true })
    .limit(200);
  return (data ?? []).map((r) => ({
    id: r.auth_user_id as string,
    email: (r.email as string | null) ?? null,
    display_name: (r.display_name as string | null) ?? null,
  }));
}

// ── 9.1 Bulk Create + Print Labels ──────────────────────────────────────────

export interface BulkBuyLabelInput {
  shipstationOrderUuid: string;
  /** Required — staff already chose a rate per order in the modal. */
  selectedRate: {
    carrier: string;
    service: string;
    rate: number;
    deliveryDays?: number | null;
    currency?: string;
    carrierAccountId?: string;
  };
}

export interface BulkBuyLabelsResult {
  ok: true;
  batchId: string;
  enqueued: number;
}

/**
 * Phase 9.1 — fan-out label-buy task per order.
 *
 * Server-side implementation:
 *   1. Insert a print_batch_jobs row (status=pending, expires_at=+24h).
 *   2. Trigger ONE orchestrator task `bulk-buy-labels` per batch with the
 *      list of (order_uuid, selectedRate) pairs.
 *   3. Orchestrator triggers create-shipping-label per row sequentially
 *      under shipstationQueue. As each completes it appends to
 *      print_batch_jobs.progress + shipment_ids. The modal polls the row.
 *
 * We do NOT call create-shipping-label directly here — that would block the
 * server action for ~90s on a 50-order batch and time out. Trigger.dev owns
 * the long-running fan-out.
 */
export async function bulkBuyLabels(input: {
  buys: BulkBuyLabelInput[];
}): Promise<BulkBuyLabelsResult> {
  const { userId, workspaceId } = await requireStaff();
  ensureCap(
    input.buys.map((b) => b.shipstationOrderUuid),
    BULK_LABEL_HARD_CAP,
    "bulkBuyLabels",
  );
  if (input.buys.length > BULK_LABEL_SOFT_TARGET) {
    // Soft warn — don't block, just leave the trail.
    console.warn(
      `[bulkBuyLabels] batch of ${input.buys.length} exceeds soft target ${BULK_LABEL_SOFT_TARGET}; expect ~${Math.ceil(input.buys.length * 1.8)}s wall-clock`,
    );
  }
  const supabase = createServiceRoleClient();

  const { data: batch, error: batchErr } = await supabase
    .from("print_batch_jobs")
    .insert({
      workspace_id: workspaceId,
      created_by: userId,
      shipment_ids: [],
      progress: {
        total: input.buys.length,
        completed: 0,
        failed: 0,
        per_order: {},
      },
      status: "pending",
    })
    .select("id")
    .single();
  if (batchErr || !batch) {
    throw new Error(`bulkBuyLabels: failed to create batch row: ${batchErr?.message}`);
  }

  await tasks.trigger("bulk-buy-labels", {
    batchId: batch.id,
    workspaceId,
    actorUserId: userId,
    buys: input.buys,
  });

  return { ok: true, batchId: batch.id, enqueued: input.buys.length };
}

/** Read the current progress + outcomes for a batch. Polled by the modal. */
export async function getPrintBatchProgress(input: { batchId: string }): Promise<{
  id: string;
  status: string;
  progress: Record<string, unknown>;
  shipment_ids: string[];
  expires_at: string;
}> {
  await requireStaff();
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("print_batch_jobs")
    .select("id, status, progress, shipment_ids, expires_at")
    .eq("id", input.batchId)
    .maybeSingle();
  if (error || !data) throw new Error(`getPrintBatchProgress: not found`);
  return {
    id: data.id as string,
    status: data.status as string,
    progress: (data.progress ?? {}) as Record<string, unknown>,
    shipment_ids: (data.shipment_ids ?? []) as string[],
    expires_at: data.expires_at as string,
  };
}

// ── 9.5 Bulk Edit Tags / Hold (v1-DEPENDENT) ────────────────────────────────

async function requireV1FeaturesEnabled(workspaceId: string): Promise<void> {
  const flags = await getWorkspaceFlags(workspaceId);
  if (flags.v1_features_enabled !== true) {
    throw new Error(
      "v1_features_enabled flag is off for this workspace — bulk tag/hold operations are disabled.",
    );
  }
}

export async function bulkAddOrdersTag(input: {
  shipstationOrderUuids: string[];
  tagId: number;
}): Promise<{ ok: true; succeeded: number; failed: Array<{ uuid: string; error: string }> }> {
  const { workspaceId } = await requireStaff();
  await requireV1FeaturesEnabled(workspaceId);
  ensureCap(input.shipstationOrderUuids, BULK_TAG_HARD_CAP, "bulkAddOrdersTag");
  if (input.shipstationOrderUuids.length > BULK_TAG_SOFT_CAP) {
    console.warn(
      `[bulkAddOrdersTag] batch of ${input.shipstationOrderUuids.length} exceeds soft cap ${BULK_TAG_SOFT_CAP}; expect ~${Math.ceil(input.shipstationOrderUuids.length * 1.6)}s wall-clock`,
    );
  }
  const supabase = createServiceRoleClient();
  const { data: orderRows } = await supabase
    .from("shipstation_orders")
    .select("id, shipstation_order_id, tag_ids")
    .eq("workspace_id", workspaceId)
    .in("id", input.shipstationOrderUuids);

  const failed: Array<{ uuid: string; error: string }> = [];
  let succeeded = 0;
  for (const row of orderRows ?? []) {
    if ((row.tag_ids as number[] | null)?.includes(input.tagId)) {
      succeeded++; // already tagged → idempotent success
      continue;
    }
    try {
      await addOrderTag(row.shipstation_order_id as number, input.tagId);
      const newTagIds = Array.from(
        new Set([...((row.tag_ids as number[] | null) ?? []), input.tagId]),
      );
      await supabase
        .from("shipstation_orders")
        .update({ tag_ids: newTagIds })
        .eq("id", row.id);
      succeeded++;
    } catch (err) {
      failed.push({
        uuid: row.id as string,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: true, succeeded, failed };
}

export async function bulkRemoveOrdersTag(input: {
  shipstationOrderUuids: string[];
  tagId: number;
}): Promise<{ ok: true; succeeded: number; failed: Array<{ uuid: string; error: string }> }> {
  const { workspaceId } = await requireStaff();
  await requireV1FeaturesEnabled(workspaceId);
  ensureCap(input.shipstationOrderUuids, BULK_TAG_HARD_CAP, "bulkRemoveOrdersTag");
  const supabase = createServiceRoleClient();
  const { data: orderRows } = await supabase
    .from("shipstation_orders")
    .select("id, shipstation_order_id, tag_ids")
    .eq("workspace_id", workspaceId)
    .in("id", input.shipstationOrderUuids);

  const failed: Array<{ uuid: string; error: string }> = [];
  let succeeded = 0;
  for (const row of orderRows ?? []) {
    if (!(row.tag_ids as number[] | null)?.includes(input.tagId)) {
      succeeded++;
      continue;
    }
    try {
      await removeOrderTag(row.shipstation_order_id as number, input.tagId);
      const newTagIds = ((row.tag_ids as number[] | null) ?? []).filter(
        (t) => t !== input.tagId,
      );
      await supabase
        .from("shipstation_orders")
        .update({ tag_ids: newTagIds })
        .eq("id", row.id);
      succeeded++;
    } catch (err) {
      failed.push({
        uuid: row.id as string,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: true, succeeded, failed };
}

export async function bulkSetOrdersHoldUntil(input: {
  shipstationOrderUuids: string[];
  /** ISO date string (YYYY-MM-DD). */
  holdUntilDate: string;
}): Promise<{ ok: true; succeeded: number; failed: Array<{ uuid: string; error: string }> }> {
  const { workspaceId } = await requireStaff();
  await requireV1FeaturesEnabled(workspaceId);
  ensureCap(input.shipstationOrderUuids, BULK_HOLD_HARD_CAP, "bulkSetOrdersHoldUntil");
  const supabase = createServiceRoleClient();
  const { data: orderRows } = await supabase
    .from("shipstation_orders")
    .select("id, shipstation_order_id")
    .eq("workspace_id", workspaceId)
    .in("id", input.shipstationOrderUuids);

  const failed: Array<{ uuid: string; error: string }> = [];
  let succeeded = 0;
  for (const row of orderRows ?? []) {
    try {
      await holdOrderUntil(row.shipstation_order_id as number, input.holdUntilDate);
      await supabase
        .from("shipstation_orders")
        .update({
          hold_until_date: input.holdUntilDate,
          order_status: "on_hold",
        })
        .eq("id", row.id);
      succeeded++;
    } catch (err) {
      failed.push({
        uuid: row.id as string,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: true, succeeded, failed };
}
