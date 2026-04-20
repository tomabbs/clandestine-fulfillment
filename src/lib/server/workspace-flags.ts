/**
 * Phase 2.4 (drift-pulled from Phase 7.3) — per-workspace feature flags.
 *
 * Read from workspaces.flags JSONB column. Server-only because reads use
 * the service role and the result is cached per request.
 *
 * Documented flag keys (additive — Phase 7.3 will formalize a Zod schema):
 *
 *   shipstation_unified_shipping (boolean) — gates the new SS cockpit at
 *     /admin/orders. When false, /admin/orders renders the legacy multi-
 *     source view via an import shim. Default: false (opt-in rollout).
 *
 *   rate_delta_thresholds ({ warn: number, halt: number }) — overrides the
 *     RATE_DELTA_DEFAULTS in create-shipping-label.ts. Default: { warn: 0.5,
 *     halt: 2.0 }.
 *
 *   email_ownership (enum) — Phase 10.4 placeholder.
 *   shipstation_writeback_enabled (bool) — Phase 4 kill switch.
 *   easypost_buy_enabled (bool) — Phase 0.3 kill switch.
 */

import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface WorkspaceFlags {
  shipstation_unified_shipping?: boolean;
  rate_delta_thresholds?: { warn?: number; halt?: number };
  email_ownership?: string;
  shipstation_writeback_enabled?: boolean;
  easypost_buy_enabled?: boolean;
  /**
   * Phase 6.3 — when TRUE, the legacy orders view at /admin/orders-legacy
   * still renders the per-row CreateLabelPanel even AFTER cutover (when
   * shipstation_unified_shipping = true). Lets ops use the legacy surface
   * for diagnostic label printing during the rollback window. Default false.
   */
  staff_diagnostics?: boolean;
  /**
   * Phase 9.5 — gate for v1-API-dependent bulk operations (bulk tag edit,
   * bulk hold-until). When ShipStation v1 sunsets, flip this off to hide
   * the bulk-tag/bulk-hold UI; the rest of the cockpit keeps working.
   */
  v1_features_enabled?: boolean;
}

const cache = new Map<string, { flags: WorkspaceFlags; expiresAt: number }>();
const TTL_MS = 30_000; // 30s — flags change rarely; cockpit reads them on every request.

export async function getWorkspaceFlags(workspaceId: string): Promise<WorkspaceFlags> {
  const cached = cache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.flags;

  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("workspaces")
    .select("flags")
    .eq("id", workspaceId)
    .maybeSingle();
  const flags = (data?.flags ?? {}) as WorkspaceFlags;
  cache.set(workspaceId, { flags, expiresAt: Date.now() + TTL_MS });
  return flags;
}

/** Force the cache to drop on next read (e.g. after a flag write). */
export function invalidateWorkspaceFlags(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}
