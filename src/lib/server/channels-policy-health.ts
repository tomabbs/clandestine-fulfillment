/**
 * Phase 0 / §9.1 D2 — Channels page health derivation for Shopify policy.
 *
 * The `shopify-policy-audit` Trigger task persists per-mapping
 * `last_inventory_policy` + `last_policy_check_at` on
 * `client_store_sku_mappings`. The Channels page derives ONE health
 * verdict per Shopify connection from those rows + the connection's
 * `connection_status`:
 *
 *   - `disconnected` if `connection_status` is auth-failed
 *   - `policy_drift` if any mapping has CONTINUE + !preorder_whitelist
 *   - `delayed` if no audit row in the last 48h (cron is daily; >48h
 *     means two consecutive runs missed)
 *   - `healthy` otherwise
 *
 * Pure derivation — no DB or network calls. The caller fetches the
 * minimal snapshot rows and feeds them in.
 *
 * Why a separate module from the existing channel health card:
 *   1. Phase 0 ships the AUDIT + remediation pieces only; the Channels
 *      page wiring is Phase 1+ scope. This helper gives Phase 1 a stable
 *      contract to import without re-deriving the rules.
 *   2. The pure shape makes the derivation trivially testable —
 *      see `tests/unit/lib/server/channels-policy-health.test.ts`.
 */

import type { IntegrationHealthState } from "@/lib/shared/types";

export interface ConnectionPolicyHealthInput {
  connectionStatus: "pending" | "active" | "disabled_auth_failure" | "error";
  /**
   * Per-mapping audit snapshot rows. Pass `null`/empty if the audit has
   * never run for this connection — derivation will treat as `delayed`.
   */
  mappings: Array<{
    last_inventory_policy: "DENY" | "CONTINUE" | null;
    preorder_whitelist: boolean;
    last_policy_check_at: string | null;
  }>;
  /**
   * Wall-clock anchor for staleness comparison. Pass an explicit value
   * in tests so derivation is deterministic.
   */
  now?: Date;
  /**
   * Audit cadence is daily (24h cron). >48h means two consecutive runs
   * missed — that's a genuine signal, not noise. Adjustable for tests.
   */
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface ConnectionPolicyHealthResult {
  state: IntegrationHealthState;
  driftCount: number;
  driftSkusSampled: never[]; // populated by callers that fetch `remote_sku`
  lastAuditAt: string | null;
  reason: string;
}

export function deriveConnectionPolicyHealth(
  input: ConnectionPolicyHealthInput,
): ConnectionPolicyHealthResult {
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  if (input.connectionStatus === "disabled_auth_failure") {
    return {
      state: "disconnected",
      driftCount: 0,
      driftSkusSampled: [],
      lastAuditAt: null,
      reason: "Connection auth failed; reconnect required.",
    };
  }

  // Newest audit timestamp across all mappings tells us when the cron last
  // walked this connection — even if every mapping was DENY (no drift).
  let lastAuditMs = 0;
  for (const m of input.mappings) {
    if (!m.last_policy_check_at) continue;
    const t = Date.parse(m.last_policy_check_at);
    if (Number.isFinite(t) && t > lastAuditMs) lastAuditMs = t;
  }
  const lastAuditAt = lastAuditMs > 0 ? new Date(lastAuditMs).toISOString() : null;

  // Drift definition mirrors `auditShopifyConnection`: CONTINUE on a SKU
  // that is NOT preorder-whitelisted. Preorder-whitelisted CONTINUE is
  // intentional and never raises.
  const driftCount = input.mappings.filter(
    (m) => m.last_inventory_policy === "CONTINUE" && m.preorder_whitelist === false,
  ).length;

  if (driftCount > 0) {
    return {
      state: "policy_drift",
      driftCount,
      driftSkusSampled: [],
      lastAuditAt,
      reason: `${driftCount} variant(s) have inventoryPolicy=CONTINUE without preorder whitelist; oversells possible.`,
    };
  }

  if (lastAuditMs === 0 || now.getTime() - lastAuditMs > staleAfterMs) {
    return {
      state: "delayed",
      driftCount: 0,
      driftSkusSampled: [],
      lastAuditAt,
      reason:
        lastAuditMs === 0
          ? "Policy audit has not run yet for this connection."
          : "Policy audit has not run in the last 48h (expected daily).",
    };
  }

  return {
    state: "healthy",
    driftCount: 0,
    driftSkusSampled: [],
    lastAuditAt,
    reason: "All mappings on DENY or pre-order whitelisted; audit fresh.",
  };
}
