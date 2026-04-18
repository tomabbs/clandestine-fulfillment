/**
 * Per-integration kill switches + percentage rollout helper.
 *
 * Tier 1 hardening (Part 14.7) items #1 and #13.
 *
 * Pattern:
 *   const guard = await loadFanoutGuard(supabase, workspaceId);
 *   if (!guard.shouldFanout("bandcamp", correlationId)) return;
 *   await pushBandcamp(...);
 *
 * Why a single helper:
 *   - One PK lookup per fanout call (cached on the helper instance).
 *   - Single source of truth for "is this integration paused for this
 *     workspace AND is this correlation_id inside the rollout window".
 *   - Deterministic correlation_id hashing — replays + retries always
 *     land in the same bucket, so a graduated rollout never accidentally
 *     fans out for a correlation_id that was previously skipped.
 *
 * Hashing:
 *   We use a simple FNV-1a 32-bit hash on the correlation_id string and
 *   bucket it into 0-99. FNV-1a is overkill for distribution but trivially
 *   pure (no platform-dependent bigint/digest variability) — important
 *   because workers in different environments must agree on the bucket
 *   for the same correlation_id, otherwise a retry on a different worker
 *   could flip from "skip" to "fanout" mid-flight.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationKillSwitchKey } from "@/lib/shared/types";

interface WorkspaceGuardRow {
  shipstation_sync_paused: boolean;
  bandcamp_sync_paused: boolean;
  clandestine_shopify_sync_paused: boolean;
  client_store_sync_paused: boolean;
  inventory_sync_paused: boolean;
  fanout_rollout_percent: number;
}

const FANOUT_GUARD_COLUMNS =
  "shipstation_sync_paused, bandcamp_sync_paused, clandestine_shopify_sync_paused, client_store_sync_paused, inventory_sync_paused, fanout_rollout_percent" as const;

export type FanoutGuardSkipReason = "global_paused" | "integration_paused" | "rollout_excluded";

export interface FanoutGuard {
  /** Read-through to the row used for diagnostics */
  readonly row: WorkspaceGuardRow;

  /**
   * Returns true if the fanout for `integration` should run for the given
   * correlation_id; false if any kill switch or rollout filter blocks it.
   */
  shouldFanout(integration: IntegrationKillSwitchKey, correlationId: string): boolean;

  /**
   * Same as shouldFanout but returns a tagged reason so callers can log /
   * structured-emit why a skip happened.
   */
  evaluate(
    integration: IntegrationKillSwitchKey,
    correlationId: string,
  ): { allow: true } | { allow: false; reason: FanoutGuardSkipReason };
}

const PAUSE_COLUMN: Record<IntegrationKillSwitchKey, keyof WorkspaceGuardRow> = {
  shipstation: "shipstation_sync_paused",
  bandcamp: "bandcamp_sync_paused",
  clandestine_shopify: "clandestine_shopify_sync_paused",
  client_store: "client_store_sync_paused",
};

export async function loadFanoutGuard(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<FanoutGuard> {
  const { data, error } = await supabase
    .from("workspaces")
    .select(FANOUT_GUARD_COLUMNS)
    .eq("id", workspaceId)
    .single();

  if (error || !data) {
    // Defensive default: if we cannot read the workspace, deny everything.
    // A missing row means we cannot prove the operator hasn't paused fanout.
    return makeGuard({
      shipstation_sync_paused: true,
      bandcamp_sync_paused: true,
      clandestine_shopify_sync_paused: true,
      client_store_sync_paused: true,
      inventory_sync_paused: true,
      fanout_rollout_percent: 0,
    });
  }

  return makeGuard(data as WorkspaceGuardRow);
}

export function makeGuard(row: WorkspaceGuardRow): FanoutGuard {
  return {
    row,
    shouldFanout(integration, correlationId) {
      return this.evaluate(integration, correlationId).allow;
    },
    evaluate(integration, correlationId) {
      if (row.inventory_sync_paused) return { allow: false, reason: "global_paused" };
      const pauseCol = PAUSE_COLUMN[integration];
      if (row[pauseCol]) return { allow: false, reason: "integration_paused" };
      if (!isInRolloutBucket(correlationId, row.fanout_rollout_percent)) {
        return { allow: false, reason: "rollout_excluded" };
      }
      return { allow: true };
    },
  };
}

/**
 * FNV-1a 32-bit hash. Returns the bucket (0-99) for a correlation_id.
 * Pure function — same input always produces the same bucket regardless
 * of platform / worker.
 */
export function correlationIdBucket(correlationId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < correlationId.length; i++) {
    hash ^= correlationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function isInRolloutBucket(correlationId: string, rolloutPercent: number): boolean {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  return correlationIdBucket(correlationId) < rolloutPercent;
}
