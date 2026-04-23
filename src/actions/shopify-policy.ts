"use server";

/**
 * Phase 0 / §9.1 D3 — `auditShopifyPolicy` Server Action.
 *
 * Staff-trigger of the same per-connection audit that the daily cron
 * (`shopify-policy-audit`) runs autonomously. Two modes:
 *
 *   - fixMode: 'audit_only' (default) — runs the read-only audit inline,
 *     persists `last_inventory_policy` + `last_policy_check_at` on every
 *     observed mapping, returns the report. NO Shopify writes. Bounded
 *     by Rule #41 — small estates fit comfortably under 60s; large estates
 *     surface a `requires_offload` flag in the response so the UI can
 *     prompt the operator to wait for the daily cron instead.
 *
 *   - fixMode: 'fix_drift' — enqueues a `shopify-policy-fix` Trigger task
 *     (Rule #48: never call Shopify mutations from a Server Action) that
 *     flips every drifted SKU's `inventoryPolicy` from CONTINUE back to
 *     DENY via `productVariantsBulkUpdate` (Rule #1 — productVariantsBulk
 *     for edits, NEVER productSet). Returns a Trigger run id for polling.
 *     Only fixes mappings with `preorder_whitelist=false` — whitelisted
 *     CONTINUE values are intentional and must not be auto-reverted.
 *
 * Authorization: staff-only (`requireAuth().isStaff`). Clients have no
 * surface for this — Channels page renders the report read-only for
 * clients (their `policy_drift` health badge is informational).
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import {
  type ConnectionPolicyHealthResult,
  deriveConnectionPolicyHealth,
} from "@/lib/server/channels-policy-health";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  auditShopifyConnection,
  type PolicyAuditConnectionReport,
} from "@/trigger/tasks/shopify-policy-audit";

const auditShopifyPolicySchema = z.object({
  connectionId: z.string().uuid(),
  fixMode: z.enum(["audit_only", "fix_drift"]).default("audit_only"),
});

export type AuditShopifyPolicyInput = z.input<typeof auditShopifyPolicySchema>;

export type AuditShopifyPolicyResult =
  | {
      mode: "audit_only";
      report: PolicyAuditConnectionReport;
    }
  | {
      mode: "fix_drift";
      enqueuedRunId: string;
      driftCount: number;
      report: PolicyAuditConnectionReport;
    };

export async function auditShopifyPolicy(
  input: AuditShopifyPolicyInput,
): Promise<AuditShopifyPolicyResult> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = auditShopifyPolicySchema.parse(input);

  const supabase = createServiceRoleClient();

  const { data: conn, error: connErr } = await supabase
    .from("client_store_connections")
    .select("id, workspace_id, store_url, platform, api_key")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
  if (!conn) throw new Error("Connection not found");
  if (conn.platform !== "shopify") {
    throw new Error("auditShopifyPolicy only applies to Shopify connections");
  }

  // Always run the read-only audit first — fix_drift mode needs a fresh
  // drift list to operate on, and the operator wants to see the report
  // either way. Reuses the same body the cron does, so the results are
  // identical.
  const report = await auditShopifyConnection(supabase, {
    id: conn.id,
    workspace_id: conn.workspace_id,
    store_url: conn.store_url,
    api_key: conn.api_key,
  });

  if (data.fixMode === "audit_only") {
    return { mode: "audit_only", report };
  }

  // fixMode === "fix_drift". Per Rule #48 + Rule #41, the actual Shopify
  // write happens inside a Trigger.dev task — never inline. We pass
  // `connectionId` only (Rule #12 — task payloads are IDs only); the task
  // re-loads the drift set from the persisted audit so the fix operates
  // on the latest snapshot, not a stale closure.
  if (report.status !== "ok" || report.driftCount === 0) {
    return { mode: "fix_drift", enqueuedRunId: "", driftCount: 0, report };
  }

  const handle = await tasks.trigger("shopify-policy-fix", {
    connectionId: conn.id,
    workspaceId: conn.workspace_id,
    triggeredBy: auth.userRecord.id,
  });

  return {
    mode: "fix_drift",
    enqueuedRunId: handle.id,
    driftCount: report.driftCount,
    report,
  };
}

// ─── Phase 0 follow-up — Channels page policy_drift readout ─────────────────
//
// The audit cron persists per-mapping `last_inventory_policy` +
// `last_policy_check_at`. The Channels page renders ONE badge per Shopify
// connection — this Server Action is the read-side that powers it.
//
// Pure derivation lives in `deriveConnectionPolicyHealth` (already shipped
// in Phase 0). This loader's job is the I/O — load connection status, load
// the minimal mapping snapshot, sample up to 5 drift SKUs for the badge
// tooltip, and hand the bundle to the pure helper.
//
// Authorization: staff-only. Clients see their own per-connection badge via
// a separate read path (Phase 5+ scope) — this loader is the staff-side
// surface.
const getConnectionPolicyHealthSchema = z.object({
  connectionId: z.string().uuid(),
});

export type GetConnectionPolicyHealthInput = z.input<typeof getConnectionPolicyHealthSchema>;

export type GetConnectionPolicyHealthResult = ConnectionPolicyHealthResult & {
  connectionId: string;
};

/**
 * Cap on `driftSkusSampled` size — operator badge tooltip, not a report.
 * Keeping this in code (not env) so the test pins the contract.
 */
export const POLICY_HEALTH_DRIFT_SAMPLE_LIMIT = 5;

export async function getConnectionPolicyHealth(
  input: GetConnectionPolicyHealthInput,
): Promise<GetConnectionPolicyHealthResult> {
  const auth = await requireAuth();
  if (!auth.isStaff) throw new Error("Forbidden — staff only");
  const data = getConnectionPolicyHealthSchema.parse(input);

  const supabase = createServiceRoleClient();

  const { data: conn, error: connErr } = await supabase
    .from("client_store_connections")
    .select("id, platform, connection_status")
    .eq("id", data.connectionId)
    .maybeSingle();
  if (connErr) throw new Error(`Connection lookup failed: ${connErr.message}`);
  if (!conn) throw new Error("Connection not found");
  if (conn.platform !== "shopify") {
    throw new Error("getConnectionPolicyHealth only applies to Shopify connections");
  }

  // We need the full snapshot of *active* mappings to compute drift count
  // and last-audit timestamp. The partial index
  // `idx_sku_mappings_policy_drift` only covers the drifted subset, which
  // is fine for the count but loses the "everything is DENY but audit is
  // fresh" healthy verdict — so we read all active mappings here.
  const { data: mappings, error: mapErr } = await supabase
    .from("client_store_sku_mappings")
    .select("last_inventory_policy, preorder_whitelist, last_policy_check_at, remote_sku")
    .eq("connection_id", data.connectionId)
    .eq("is_active", true);
  if (mapErr) throw new Error(`Mapping snapshot fetch failed: ${mapErr.message}`);

  const snapshot = (mappings ?? []).map((m) => ({
    last_inventory_policy: m.last_inventory_policy as "DENY" | "CONTINUE" | null,
    preorder_whitelist: Boolean(m.preorder_whitelist),
    last_policy_check_at: m.last_policy_check_at as string | null,
  }));

  const result = deriveConnectionPolicyHealth({
    connectionStatus: (conn.connection_status ?? "active") as
      | "pending"
      | "active"
      | "disabled_auth_failure"
      | "error",
    mappings: snapshot,
  });

  // Populate the SKU sample only when we'll actually render it (drift state).
  // The pure derivation can't do this because it doesn't have `remote_sku` in
  // its input shape — the loader owns the I/O contract.
  let driftSkusSampled: string[] = [];
  if (result.state === "policy_drift") {
    driftSkusSampled = (mappings ?? [])
      .filter(
        (m) => m.last_inventory_policy === "CONTINUE" && Boolean(m.preorder_whitelist) === false,
      )
      .map((m) => (m.remote_sku as string | null) ?? "")
      .filter((sku) => sku.length > 0)
      .slice(0, POLICY_HEALTH_DRIFT_SAMPLE_LIMIT);
  }

  return {
    ...result,
    driftSkusSampled,
    connectionId: conn.id,
  };
}
