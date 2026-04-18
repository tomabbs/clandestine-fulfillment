"use server";

/**
 * SKU sync conflicts — staff queue + client suggest UI.
 *
 * Plan §10.2 (rectify Server Action flow) + §10.3 (client suggest-only UX).
 *
 * - Staff sees the full queue across the workspace, can ignore/snooze, and
 *   can apply a resolution which fires `sku-rectify-via-alias`.
 * - Clients see only their org's open conflicts and can suggest a canonical
 *   SKU; staff approval is ALWAYS required to actually apply (auto-apply
 *   never fires for client suggestions per locked decision).
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireAuth, requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { SkuRectifyViaAliasPayload } from "@/trigger/tasks/sku-rectify-via-alias";

const STAFF_LIST_FILTER = z
  .object({
    status: z.enum(["open", "client_suggested", "resolved", "ignored"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    conflictType: z
      .enum([
        "mismatch",
        "orphan_shipstation",
        "orphan_bandcamp",
        "placeholder_squarespace",
        "casing",
        "ambiguous",
      ])
      .optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional();

export type StaffListFilter = z.infer<typeof STAFF_LIST_FILTER>;

export interface SkuConflictRow {
  id: string;
  workspace_id: string;
  org_id: string | null;
  variant_id: string | null;
  conflict_type: string;
  severity: string;
  our_sku: string | null;
  bandcamp_sku: string | null;
  shipstation_sku: string | null;
  shopify_sku: string | null;
  squarespace_sku: string | null;
  woocommerce_sku: string | null;
  example_product_title: string | null;
  status: string;
  suggested_canonical_sku: string | null;
  resolution_method: string | null;
  occurrence_count: number | null;
  detected_at: string;
  resolved_at: string | null;
}

/** Staff list — workspace-scoped, all conflict types. */
export async function listSkuConflicts(filter?: StaffListFilter): Promise<SkuConflictRow[]> {
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const parsed = STAFF_LIST_FILTER.parse(filter ?? {});
  const supabase = createServiceRoleClient();

  let query = supabase
    .from("sku_sync_conflicts")
    .select(
      "id, workspace_id, org_id, variant_id, conflict_type, severity, " +
        "our_sku, bandcamp_sku, shipstation_sku, shopify_sku, squarespace_sku, " +
        "woocommerce_sku, example_product_title, status, suggested_canonical_sku, " +
        "resolution_method, occurrence_count, detected_at, resolved_at",
    )
    .eq("workspace_id", ctx.userRecord.workspace_id)
    .order("severity", { ascending: false })
    .order("detected_at", { ascending: false });

  if (parsed?.status) query = query.eq("status", parsed.status);
  if (parsed?.severity) query = query.eq("severity", parsed.severity);
  if (parsed?.conflictType) query = query.eq("conflict_type", parsed.conflictType);
  query = query.limit(parsed?.limit ?? 200);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SkuConflictRow[];
}

/** Staff detail — single row by id. */
export async function getSkuConflict(id: string): Promise<SkuConflictRow | null> {
  z.string().uuid().parse(id);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("sku_sync_conflicts")
    .select(
      "id, workspace_id, org_id, variant_id, conflict_type, severity, " +
        "our_sku, bandcamp_sku, shipstation_sku, shopify_sku, squarespace_sku, " +
        "woocommerce_sku, example_product_title, status, suggested_canonical_sku, " +
        "resolution_method, occurrence_count, detected_at, resolved_at",
    )
    .eq("id", id)
    .eq("workspace_id", ctx.userRecord.workspace_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as SkuConflictRow | null;
}

const APPLY_INPUT = z.object({
  conflictId: z.string().uuid(),
  /** ShipStation v1 master SKU (the SKU that owns inventory). */
  masterSku: z.string().min(1).max(120),
  /** Channel/store SKU to add as alias on the master. */
  aliasSku: z.string().min(1).max(120),
  storeName: z.string().max(120).optional(),
  storeId: z.number().int().positive().optional(),
});

export interface ApplyResolutionResult {
  status: "queued";
  taskRunId: string;
  conflictId: string;
}

/**
 * Staff applies an alias-add resolution. Validates input, ensures the
 * conflict belongs to the staff member's workspace, then enqueues
 * `sku-rectify-via-alias` (NEVER calls ShipStation directly per Rule #48).
 */
export async function applyAliasResolution(
  input: z.input<typeof APPLY_INPUT>,
): Promise<ApplyResolutionResult> {
  const parsed = APPLY_INPUT.parse(input);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  const { data: conflict, error } = await supabase
    .from("sku_sync_conflicts")
    .select("id, workspace_id, status")
    .eq("id", parsed.conflictId)
    .single();
  if (error || !conflict) throw new Error("Conflict not found");
  if (conflict.workspace_id !== ctx.userRecord.workspace_id) {
    throw new Error("Conflict belongs to another workspace");
  }
  if (conflict.status === "resolved") {
    throw new Error("Conflict is already resolved");
  }

  const payload: SkuRectifyViaAliasPayload = {
    conflict_id: parsed.conflictId,
    master_sku: parsed.masterSku,
    alias_sku: parsed.aliasSku,
    store_name: parsed.storeName,
    store_id: parsed.storeId,
    approved_by_user_id: ctx.userRecord.id,
  };

  const handle = await tasks.trigger("sku-rectify-via-alias", payload);
  return { status: "queued", taskRunId: handle.id, conflictId: parsed.conflictId };
}

/** Staff explicitly ignores a conflict (won't reopen on re-detection until reset). */
export async function ignoreSkuConflict(conflictId: string): Promise<{ status: "ok" }> {
  z.string().uuid().parse(conflictId);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("sku_sync_conflicts")
    .update({
      status: "ignored",
      resolved_at: new Date().toISOString(),
      resolved_by: ctx.userRecord.id,
      resolution_method: "ignored_by_staff",
    })
    .eq("id", conflictId)
    .eq("workspace_id", ctx.userRecord.workspace_id);
  if (error) throw new Error(error.message);
  return { status: "ok" };
}

// ─── Client portal ─────────────────────────────────────────────────────────

/**
 * Client view: their org's open + suggested conflicts only. RLS enforces the
 * org scope, but we also filter explicitly for defense in depth.
 */
export async function listClientSkuMismatches(): Promise<SkuConflictRow[]> {
  const { orgId, workspaceId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("sku_sync_conflicts")
    .select(
      "id, workspace_id, org_id, variant_id, conflict_type, severity, " +
        "our_sku, bandcamp_sku, shipstation_sku, shopify_sku, squarespace_sku, " +
        "woocommerce_sku, example_product_title, status, suggested_canonical_sku, " +
        "resolution_method, occurrence_count, detected_at, resolved_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("org_id", orgId)
    .in("status", ["open", "client_suggested"])
    .order("severity", { ascending: false })
    .order("detected_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SkuConflictRow[];
}

const SUGGEST_INPUT = z.object({
  conflictId: z.string().uuid(),
  suggestedCanonicalSku: z.string().min(1).max(120),
});

/**
 * Client suggests a canonical SKU. Writes via service role after
 * validating the conflict belongs to the client's org (mirrors the
 * `submitClientStoreCredentials` pattern, CLAUDE.md Rule #19). Status is
 * flipped to `client_suggested`; staff approval is still required to
 * actually apply.
 */
export async function suggestCanonicalSku(
  input: z.input<typeof SUGGEST_INPUT>,
): Promise<{ status: "ok" }> {
  const parsed = SUGGEST_INPUT.parse(input);
  const { orgId, workspaceId } = await requireClient();

  const supabase = createServiceRoleClient();
  const { data: conflict, error: fetchErr } = await supabase
    .from("sku_sync_conflicts")
    .select("id, workspace_id, org_id, status")
    .eq("id", parsed.conflictId)
    .single();
  if (fetchErr || !conflict) throw new Error("Conflict not found");
  if (conflict.workspace_id !== workspaceId || conflict.org_id !== orgId) {
    throw new Error("Conflict does not belong to your organization");
  }
  if (conflict.status === "resolved" || conflict.status === "ignored") {
    throw new Error("Conflict is no longer open");
  }

  const { error } = await supabase
    .from("sku_sync_conflicts")
    .update({
      status: "client_suggested",
      suggested_canonical_sku: parsed.suggestedCanonicalSku,
    })
    .eq("id", parsed.conflictId);
  if (error) throw new Error(error.message);
  return { status: "ok" };
}
