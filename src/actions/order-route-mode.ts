"use server";

/**
 * Order Pages Transition Phase 0 — `/admin/orders` route-mode flip.
 *
 * Single-owner Server Action for setting `workspaces.flags.orders_route_mode`.
 * Allowed roles: `super_admin`, `warehouse_manager` (per the plan; see
 * `STAFF_ROLES` in `src/lib/shared/constants.ts`). Other staff roles can
 * read the flag but not flip it — this is a "break-glass" rollback control
 * and we don't want every label_staff user able to redirect the entire
 * orders surface during normal operation.
 *
 * Every flip writes an audit row into the existing `warehouse_review_queue`
 * (no new audit-log table). The row carries the actor, from/to mode, and a
 * required ≥8-char reason so an after-the-fact incident review can see why
 * the flip happened.
 *
 * Cache invalidation routes through the centralized `invalidateOrderSurfaces`
 * helper plus a manual `revalidatePath` on both order pages — this file is
 * one of the two whitelisted call sites for `revalidatePath('/admin/orders'`
 * (the other is `src/lib/server/invalidate-order-surfaces.ts` itself).
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { invalidateOrderSurfaces } from "@/lib/server/invalidate-order-surfaces";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  getWorkspaceFlags,
  invalidateWorkspaceFlags,
  parseWorkspaceFlags,
  type WorkspaceFlags,
} from "@/lib/server/workspace-flags";

const ROUTE_MODE_VALUES = ["direct", "shipstation_mirror"] as const;
export type OrdersRouteMode = (typeof ROUTE_MODE_VALUES)[number];

const ROUTE_MODE_WRITE_ROLES = new Set(["super_admin", "warehouse_manager"]);

const FlipInputSchema = z.object({
  mode: z.enum(ROUTE_MODE_VALUES),
  reason: z.string().trim().min(8, "reason must be at least 8 characters").max(500),
});

export interface FlipOrdersRouteModeResult {
  ok: true;
  workspaceId: string;
  fromMode: OrdersRouteMode | null;
  toMode: OrdersRouteMode;
}

/**
 * Read the current effective route mode for a workspace.
 *
 * Returns `null` when the flag is unset — callers must fall back to the
 * legacy `shipstation_unified_shipping` flag in that case (see
 * `/admin/orders/page.tsx` for the canonical fallback chain).
 */
export async function getOrdersRouteMode(
  workspaceId: string,
): Promise<{ routeMode: OrdersRouteMode | null; legacyShipstationUnifiedShipping: boolean }> {
  const flags = await getWorkspaceFlags(workspaceId);
  return {
    routeMode: flags.orders_route_mode ?? null,
    legacyShipstationUnifiedShipping: flags.shipstation_unified_shipping ?? false,
  };
}

/**
 * Flip the route mode for the caller's workspace. Staff-gated to
 * super_admin / warehouse_manager.
 */
export async function flipOrdersRouteMode(input: {
  mode: OrdersRouteMode;
  reason: string;
}): Promise<FlipOrdersRouteModeResult> {
  const parsed = FlipInputSchema.parse(input);

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Authentication required");

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, role, workspace_id, name, email")
    .eq("auth_user_id", user.id)
    .single();
  if (profileError || !profile) throw new Error("User profile not found");

  if (!ROUTE_MODE_WRITE_ROLES.has(profile.role)) {
    throw new Error(
      `Role '${profile.role}' is not allowed to flip orders_route_mode. Required: super_admin or warehouse_manager.`,
    );
  }

  const workspaceId = profile.workspace_id as string;

  const service = createServiceRoleClient();

  const { data: workspaceRow, error: workspaceError } = await service
    .from("workspaces")
    .select("flags")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError) {
    throw new Error(`Failed to read workspaces.flags: ${workspaceError.message}`);
  }

  const currentFlags: WorkspaceFlags = parseWorkspaceFlags(workspaceRow?.flags ?? {});
  const fromMode = currentFlags.orders_route_mode ?? null;

  if (fromMode === parsed.mode) {
    return {
      ok: true,
      workspaceId,
      fromMode,
      toMode: parsed.mode,
    };
  }

  const nextFlags: WorkspaceFlags = {
    ...currentFlags,
    orders_route_mode: parsed.mode,
  };

  const { error: writeError } = await service
    .from("workspaces")
    .update({ flags: nextFlags })
    .eq("id", workspaceId);
  if (writeError) {
    throw new Error(`Failed to write workspaces.flags: ${writeError.message}`);
  }

  invalidateWorkspaceFlags(workspaceId);

  const { error: queueError } = await service.from("warehouse_review_queue").insert({
    workspace_id: workspaceId,
    org_id: null,
    category: "order_route_mode_change",
    severity: "medium",
    title: `Orders route mode → ${parsed.mode}`,
    description: parsed.reason,
    status: "open",
    metadata: {
      actor_id: profile.id,
      actor_name: profile.name,
      actor_email: profile.email,
      from_mode: fromMode,
      to_mode: parsed.mode,
      reason: parsed.reason,
      flipped_at: new Date().toISOString(),
    },
    group_key: `order-route-mode-flip:${workspaceId}:${new Date().toISOString().slice(0, 10)}`,
  });
  // Audit-row failure must not block the flip; the next periodic
  // diagnostics scan will surface a missing audit row anyway.
  if (queueError) {
    console.error("[order-route-mode] audit insert failed", queueError.message);
  }

  await invalidateOrderSurfaces({
    workspaceId,
    kinds: [
      "direct.list",
      "direct.detail",
      "mirror.list",
      "mirror.detail",
      "transitionDiagnostics",
    ],
  });

  // Belt-and-braces: explicit revalidate on both surfaces so the next
  // navigation reads the new flag immediately. This is one of the two
  // whitelisted call sites for `revalidatePath('/admin/orders'` (the
  // other is `invalidate-order-surfaces.ts` itself).
  revalidatePath("/admin/orders");
  revalidatePath("/admin/orders/shipstation");

  return {
    ok: true,
    workspaceId,
    fromMode,
    toMode: parsed.mode,
  };
}
