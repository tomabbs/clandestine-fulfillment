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
