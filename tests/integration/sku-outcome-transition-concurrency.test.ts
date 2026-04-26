import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApplyOutcomeTransitionCallInput,
  applyOutcomeTransition,
} from "@/lib/server/sku-outcome-transitions";

/**
 * SKU-AUTO-14 + SKU-AUTO-22 concurrency evidence test.
 *
 * Verifies that when N parallel callers try to transition the SAME
 * `client_store_product_identity_matches` row with the SAME
 * `expectedStateVersion`:
 *
 *   (1) Exactly ONE call returns ok=true.
 *   (2) The other N-1 return ok=false with reason='stale_state_version'.
 *   (3) The identity row's state_version is bumped exactly once
 *       (from 1 to 2).
 *   (4) Exactly ONE row is written to `sku_outcome_transitions`.
 *   (5) The pg_advisory_xact_lock (SKU-AUTO-22) means callers queue
 *       per-row instead of all racing and aborting; we observe this as
 *       a clean (1 success + N-1 OCC rejections) pattern with no
 *       deadlock / serialization_failure surfacing to the caller.
 *
 * Like `tenant-isolation.test.ts`, the suite is gated on
 * `INTEGRATION_TEST_SUPABASE_URL` + `INTEGRATION_TEST_SERVICE_ROLE_KEY`
 * and skipped when the env is absent. Run via `pnpm test:integration`.
 */

const url = process.env.INTEGRATION_TEST_SUPABASE_URL;
const serviceKey = process.env.INTEGRATION_TEST_SERVICE_ROLE_KEY;

const enabled = Boolean(url && serviceKey);
const describeOrSkip = enabled ? describe : describe.skip;

describeOrSkip("applyOutcomeTransition concurrency (SKU-AUTO-14 / SKU-AUTO-22)", () => {
  if (!enabled) {
    it.skip("integration env vars not set — skipping", () => {});
    return;
  }

  const service = createClient(url as string, serviceKey as string, {
    auth: { persistSession: false },
  });

  let wsId: string;
  let orgId: string;
  let connectionId: string;
  let productId: string;
  let variantId: string;
  let identityMatchId: string;

  beforeAll(async () => {
    const stamp = Date.now();

    const ws = await service
      .from("workspaces")
      .insert({ name: `txn-concurrency-${stamp}`, slug: `txn-conc-${stamp}` })
      .select("id")
      .single();
    if (ws.error) throw ws.error;
    wsId = ws.data.id;

    const org = await service
      .from("organizations")
      .insert({ workspace_id: wsId, name: "Org", slug: `org-txn-${stamp}` })
      .select("id")
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id;

    const conn = await service
      .from("client_store_connections")
      .insert({
        workspace_id: wsId,
        org_id: orgId,
        platform: "shopify",
        store_url: `https://txn-concurrency-${stamp}.myshopify.com`,
        connection_status: "active",
      })
      .select("id")
      .single();
    if (conn.error) throw conn.error;
    connectionId = conn.data.id;

    const product = await service
      .from("warehouse_products")
      .insert({
        workspace_id: wsId,
        org_id: orgId,
        name: `txn-concurrency-${stamp}`,
        sku_prefix: `TXN-${stamp}`,
      })
      .select("id")
      .single();
    if (product.error) throw product.error;
    productId = product.data.id;

    const variant = await service
      .from("warehouse_product_variants")
      .insert({
        workspace_id: wsId,
        product_id: productId,
        sku: `TXN-${stamp}-V`,
        title: "concurrency variant",
      })
      .select("id")
      .single();
    if (variant.error) throw variant.error;
    variantId = variant.data.id;

    const identity = await service
      .from("client_store_product_identity_matches")
      .insert({
        workspace_id: wsId,
        org_id: orgId,
        connection_id: connectionId,
        platform: "shopify",
        variant_id: variantId,
        outcome_state: "auto_database_identity_match",
        canonical_resolution_state: "resolved_to_variant",
        match_method: "exact_sku_match",
        match_confidence: "deterministic",
        evidence_snapshot: {},
        evidence_hash: `hash-${stamp}`,
      })
      .select("id, state_version")
      .single();
    if (identity.error) throw identity.error;
    identityMatchId = identity.data.id;
    expect(identity.data.state_version).toBe(1);
  });

  afterAll(async () => {
    if (wsId) {
      await service.from("workspaces").delete().eq("id", wsId);
    }
  });

  it("exactly one of N concurrent callers wins; others see stale_state_version", async () => {
    const N = 8;
    const base: ApplyOutcomeTransitionCallInput = {
      workspaceId: wsId,
      orgId: orgId,
      connectionId: connectionId,
      identityMatchId: identityMatchId,
      variantId: variantId,
      expectedStateVersion: 1,
      from: "auto_database_identity_match",
      to: "auto_holdout_for_evidence",
      trigger: "periodic_revaluation",
      reasonCode: "holdout_expired_10_evaluations",
      evidenceSnapshot: { concurrencyProbe: true },
      triggeredBy: "sku-autonomous-phase1-concurrency-probe",
    };

    const results = await Promise.all(
      Array.from({ length: N }, () => applyOutcomeTransition(service, base)),
    );

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(N - 1);

    for (const f of failures) {
      if (f.ok) continue;
      expect(f.reason).toBe("stale_state_version");
    }

    const after = await service
      .from("client_store_product_identity_matches")
      .select("state_version, outcome_state, evaluation_count")
      .eq("id", identityMatchId)
      .single();
    expect(after.error).toBeNull();
    expect(after.data?.state_version).toBe(2);
    expect(after.data?.outcome_state).toBe("auto_holdout_for_evidence");
    expect(after.data?.evaluation_count).toBe(2);

    const transitions = await service
      .from("sku_outcome_transitions")
      .select("id, from_state, to_state, trigger, reason_code")
      .eq("identity_match_id", identityMatchId);
    expect(transitions.error).toBeNull();
    expect(transitions.data ?? []).toHaveLength(1);
    expect(transitions.data?.[0]?.from_state).toBe("auto_database_identity_match");
    expect(transitions.data?.[0]?.to_state).toBe("auto_holdout_for_evidence");
    expect(transitions.data?.[0]?.trigger).toBe("periodic_revaluation");
    expect(transitions.data?.[0]?.reason_code).toBe("holdout_expired_10_evaluations");
  });

  it("rejects writing auto_live_inventory_alias to the identity row", async () => {
    const r = await applyOutcomeTransition(service, {
      workspaceId: wsId,
      orgId: orgId,
      connectionId: connectionId,
      identityMatchId: identityMatchId,
      variantId: variantId,
      expectedStateVersion: 2,
      from: "auto_holdout_for_evidence",
      to: "auto_live_inventory_alias",
      trigger: "stock_change",
      reasonCode: "stock_positive_promotion",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("to_state_forbidden_on_identity_row");
  });

  it("enforces terminal-state egress rule (rejects non-human trigger)", async () => {
    // First, transition to auto_reject_non_match via human_review so we
    // have a terminal row to try to egress.
    const before = await service
      .from("client_store_product_identity_matches")
      .select("state_version")
      .eq("id", identityMatchId)
      .single();
    expect(before.error).toBeNull();
    const v = before.data?.state_version as number;

    const entered = await applyOutcomeTransition(service, {
      workspaceId: wsId,
      orgId: orgId,
      connectionId: connectionId,
      identityMatchId: identityMatchId,
      expectedStateVersion: v,
      from: "auto_holdout_for_evidence",
      to: "auto_reject_non_match",
      trigger: "periodic_revaluation",
      reasonCode: "holdout_expired_90_days",
    });
    expect(entered.ok).toBe(true);

    const egress = await applyOutcomeTransition(service, {
      workspaceId: wsId,
      orgId: orgId,
      connectionId: connectionId,
      identityMatchId: identityMatchId,
      expectedStateVersion: v + 1,
      from: "auto_reject_non_match",
      to: "auto_database_identity_match",
      trigger: "evidence_gate",
      reasonCode: "exact_sku_match",
    });
    expect(egress.ok).toBe(false);
    if (!egress.ok) {
      // Client-side validator short-circuits before the RPC — the
      // legal-transition table has no edge reject→identity except
      // via human_review.
      expect(["illegal_transition", "terminal_state_non_human_egress"]).toContain(egress.reason);
    }
  });
});
