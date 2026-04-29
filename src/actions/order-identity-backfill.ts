"use server";

/**
 * Order Pages Transition Phase 1 — Server Actions for the Identity v2
 * backfill.
 *
 * Per Rule #41 + #48, Server Actions stay bounded — heavy work fires a
 * Trigger.dev task. These actions only:
 *   1. enqueue the resumable `order-identity-backfill` task,
 *   2. read the latest run row for the diagnostics surface,
 *   3. resolve a single open review queue row when staff picks a winner.
 *
 * Restricted to staff per the plan; the manual-resolution path further
 * narrows to `super_admin` / `warehouse_manager` because flipping a row's
 * `connection_id` after the fact has downstream fanout implications.
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { requireStaff } from "@/lib/server/auth-context";
import { invalidateOrderSurfaces } from "@/lib/server/invalidate-order-surfaces";
import { buildIdempotencyKeyV2 } from "@/lib/server/order-identity-v2";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

const ENQUEUE_BACKFILL_ROLES = new Set([
  "admin",
  "super_admin",
  "warehouse_manager",
  "label_management",
]);

const RESOLVE_REVIEW_ROLES = new Set(["super_admin", "warehouse_manager"]);

const EnqueueBackfillSchema = z.object({
  scopeConnectionId: z.string().uuid().nullable().optional(),
  batchSize: z.number().int().positive().max(2000).optional(),
});

export interface EnqueueIdentityBackfillResult {
  ok: true;
  runId: string;
  workspaceId: string;
}

export async function enqueueIdentityBackfill(input: {
  scopeConnectionId?: string | null;
  batchSize?: number;
}): Promise<EnqueueIdentityBackfillResult> {
  const parsed = EnqueueBackfillSchema.parse(input);
  const { workspaceId, userId } = await requireStaff();

  const supabase = await createServerSupabaseClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", userId).single();
  if (!profile || !ENQUEUE_BACKFILL_ROLES.has(profile.role)) {
    throw new Error(
      `Role '${profile?.role ?? "unknown"}' is not allowed to enqueue identity backfill.`,
    );
  }

  const handle = await tasks.trigger("order-identity-backfill", {
    workspaceId,
    scopeConnectionId: parsed.scopeConnectionId ?? null,
    batchSize: parsed.batchSize,
  });

  await invalidateOrderSurfaces({
    workspaceId,
    kinds: ["transitionDiagnostics"],
  });

  return { ok: true, runId: handle.id, workspaceId };
}

const ResolveReviewSchema = z.object({
  reviewQueueId: z.string().uuid(),
  resolvedConnectionId: z.string().uuid(),
  notes: z.string().trim().min(8).max(1000).optional(),
});

export interface ResolveIdentityReviewResult {
  ok: true;
  warehouseOrderId: string;
}

export async function resolveIdentityReview(input: {
  reviewQueueId: string;
  resolvedConnectionId: string;
  notes?: string;
}): Promise<ResolveIdentityReviewResult> {
  const parsed = ResolveReviewSchema.parse(input);
  const { workspaceId, userId } = await requireStaff();

  const supabase = await createServerSupabaseClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", userId).single();
  if (!profile || !RESOLVE_REVIEW_ROLES.has(profile.role)) {
    throw new Error(
      `Role '${profile?.role ?? "unknown"}' is not allowed to resolve identity reviews.`,
    );
  }

  const service = createServiceRoleClient();

  const { data: review, error: reviewErr } = await service
    .from("warehouse_order_identity_review_queue")
    .select(
      "id, workspace_id, warehouse_order_id, candidate_connection_ids, status, resolution_notes",
    )
    .eq("id", parsed.reviewQueueId)
    .maybeSingle();
  if (reviewErr || !review) {
    throw new Error(`Review row not found: ${reviewErr?.message ?? "no row"}`);
  }
  if ((review as { workspace_id: string }).workspace_id !== workspaceId) {
    throw new Error("Cross-workspace review resolution refused");
  }
  if (
    !((review as { candidate_connection_ids: string[] }).candidate_connection_ids ?? []).includes(
      parsed.resolvedConnectionId,
    )
  ) {
    throw new Error(
      "resolvedConnectionId is not in the candidate set for this review row. Re-run the backfill to widen candidates if needed.",
    );
  }

  const warehouseOrderId = (review as { warehouse_order_id: string }).warehouse_order_id;

  // Look up the order so we can compute the v2 idempotency key for the
  // canonical platform identifier.
  const { data: orderRow, error: orderErr } = await service
    .from("warehouse_orders")
    .select("id, source, external_order_id, shopify_order_id, order_number, bandcamp_payment_id")
    .eq("id", warehouseOrderId)
    .maybeSingle();
  if (orderErr || !orderRow) {
    throw new Error(`Order not found: ${orderErr?.message ?? "no row"}`);
  }
  const r = orderRow as {
    id: string;
    source: string | null;
    external_order_id: string | null;
    shopify_order_id: string | null;
    order_number: string | null;
    bandcamp_payment_id: number | null;
  };
  const platform = (r.source ?? "shopify") as
    | "shopify"
    | "woocommerce"
    | "squarespace"
    | "bandcamp"
    | "manual";
  const externalOrderId =
    r.external_order_id ??
    (platform === "shopify" ? r.shopify_order_id : r.order_number) ??
    String(r.bandcamp_payment_id ?? "");
  if (!externalOrderId) {
    throw new Error("Order has no external_order_id / legacy id; cannot stamp identity v2.");
  }
  const ingestionIdempotencyKeyV2 = buildIdempotencyKeyV2({
    platform,
    connectionId: parsed.resolvedConnectionId,
    externalOrderId,
  });

  const { error: updateErr } = await service
    .from("warehouse_orders")
    .update({
      connection_id: parsed.resolvedConnectionId,
      external_order_id: externalOrderId,
      ingestion_idempotency_key_v2: ingestionIdempotencyKeyV2,
      identity_resolution_status: "manual",
      identity_resolution_notes: {
        ...((review as { resolution_notes: Record<string, unknown> }).resolution_notes ?? {}),
        manual_resolution: {
          resolved_by: userId,
          resolved_at: new Date().toISOString(),
          notes: parsed.notes ?? null,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", warehouseOrderId);
  if (updateErr) {
    throw new Error(`Failed to stamp identity v2: ${updateErr.message}`);
  }

  await service
    .from("warehouse_order_identity_review_queue")
    .update({
      status: "resolved_manual",
      resolved_connection_id: parsed.resolvedConnectionId,
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.reviewQueueId);

  await invalidateOrderSurfaces({
    workspaceId,
    warehouseOrderId,
    kinds: ["transitionDiagnostics", "direct.detail", "direct.list"],
  });

  return { ok: true, warehouseOrderId };
}
