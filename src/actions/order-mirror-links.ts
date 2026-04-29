"use server";

/**
 * Order Pages Transition Phase 2 — Server Actions for the order
 * mirror-links bridge.
 *
 * Per Rule #41 + #48, the heavy work runs in the
 * `order-mirror-links-bridge` Trigger task. These actions only
 * enqueue + (later phases) accept manual link / unlink requests.
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { requireStaff } from "@/lib/server/auth-context";
import { invalidateOrderSurfaces } from "@/lib/server/invalidate-order-surfaces";

const ENQUEUE_ROLES = new Set(["admin", "super_admin", "warehouse_manager", "label_management"]);

const EnqueueSchema = z.object({
  batchSize: z.number().int().positive().max(2000).optional(),
  cursorOrderId: z.string().uuid().nullable().optional(),
  dryRun: z.boolean().optional(),
});

export interface EnqueueMirrorBridgeResult {
  ok: true;
  runId: string;
  workspaceId: string;
}

export async function enqueueMirrorLinksBridge(input: {
  batchSize?: number;
  cursorOrderId?: string | null;
  dryRun?: boolean;
}): Promise<EnqueueMirrorBridgeResult> {
  const parsed = EnqueueSchema.parse(input);
  const { workspaceId, userId } = await requireStaff();

  const { createServerSupabaseClient } = await import("@/lib/server/supabase-server");
  const supabase = await createServerSupabaseClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", userId).single();
  if (!profile || !ENQUEUE_ROLES.has(profile.role)) {
    throw new Error(
      `Role '${profile?.role ?? "unknown"}' is not allowed to enqueue mirror-links bridge.`,
    );
  }

  const handle = await tasks.trigger("order-mirror-links-bridge", {
    workspaceId,
    batchSize: parsed.batchSize,
    cursorOrderId: parsed.cursorOrderId ?? null,
    dryRun: parsed.dryRun ?? false,
  });

  await invalidateOrderSurfaces({
    workspaceId,
    kinds: ["transitionDiagnostics", "mirrorLinks"],
  });

  return { ok: true, runId: handle.id, workspaceId };
}
