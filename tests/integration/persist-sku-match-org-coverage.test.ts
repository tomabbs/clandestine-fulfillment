import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Live-DB contract tests for `persist_sku_match` + `client_store_connection_org_coverage`.
 *
 * Complements regex-only migration tests in:
 *   `tests/unit/migrations/client-store-connection-org-coverage.test.ts`
 *
 * Gated on INTEGRATION_TEST_SUPABASE_URL + INTEGRATION_TEST_SERVICE_ROLE_KEY.
 * Run: `pnpm test:integration tests/integration/persist-sku-match-org-coverage.test.ts`
 *
 * Release evidence: TRUTH_LAYER § Operational cutover + RELEASE_GATE_CRITERIA § Northern Spy / operational cutover.
 */

const url = process.env.INTEGRATION_TEST_SUPABASE_URL;
const serviceKey = process.env.INTEGRATION_TEST_SERVICE_ROLE_KEY;

const enabled = Boolean(url && serviceKey);
const describeOrSkip = enabled ? describe : describe.skip;

describeOrSkip("persist_sku_match org coverage (migration 20260428000008)", () => {
  if (!enabled) {
    it.skip("integration env vars not set — skipping", () => {});
    return;
  }

  const service = createClient(url as string, serviceKey as string, {
    auth: { persistSession: false },
  });

  let wsId: string;
  let orgPrimaryId: string;
  let orgUncoveredId: string;
  let connectionId: string;
  let uncoveredVariantId: string;

  beforeAll(async () => {
    const stamp = Date.now();

    const ws = await service
      .from("workspaces")
      .insert({ name: `cov-persist-${stamp}`, slug: `cov-persist-${stamp}` })
      .select("id")
      .single();
    if (ws.error) throw ws.error;
    wsId = ws.data.id;

    const orgPrimary = await service
      .from("organizations")
      .insert({ workspace_id: wsId, name: "Primary Org", slug: `prim-${stamp}` })
      .select("id")
      .single();
    if (orgPrimary.error) throw orgPrimary.error;
    orgPrimaryId = orgPrimary.data.id;

    const orgUncovered = await service
      .from("organizations")
      .insert({ workspace_id: wsId, name: "Uncovered Org", slug: `uncov-${stamp}` })
      .select("id")
      .single();
    if (orgUncovered.error) throw orgUncovered.error;
    orgUncoveredId = orgUncovered.data.id;

    const conn = await service
      .from("client_store_connections")
      .insert({
        workspace_id: wsId,
        org_id: orgPrimaryId,
        platform: "shopify",
        store_url: `https://cov-persist-${stamp}.myshopify.com`,
        connection_status: "active",
      })
      .select("id")
      .single();
    if (conn.error) throw conn.error;
    connectionId = conn.data.id;

    const { data: coverageRows, error: covErr } = await service
      .from("client_store_connection_org_coverage")
      .select("org_id, coverage_role")
      .eq("connection_id", connectionId)
      .eq("org_id", orgPrimaryId);
    if (covErr) throw covErr;
    expect(coverageRows?.length).toBeGreaterThanOrEqual(1);
    expect(coverageRows?.some((r) => r.coverage_role === "primary")).toBe(true);

    const product = await service
      .from("warehouse_products")
      .insert({
        workspace_id: wsId,
        org_id: orgUncoveredId,
        name: `uncovered-prod-${stamp}`,
        sku_prefix: `UNCOV-${stamp}`,
      })
      .select("id")
      .single();
    if (product.error) throw product.error;

    const variant = await service
      .from("warehouse_product_variants")
      .insert({
        workspace_id: wsId,
        product_id: product.data.id,
        sku: `UNCOV-${stamp}-V`,
        title: "uncovered variant",
      })
      .select("id")
      .single();
    if (variant.error) throw variant.error;
    uncoveredVariantId = variant.data.id;
  });

  afterAll(async () => {
    if (wsId) {
      await service.from("workspaces").delete().eq("id", wsId);
    }
  });

  it("RPC rejects persist_sku_match when variant product org is not in connection coverage", async () => {
    const { data, error } = await service.rpc("persist_sku_match", {
      p_workspace_id: wsId,
      p_connection_id: connectionId,
      p_variant_id: uncoveredVariantId,
      p_remote_product_id: "remote-p1",
      p_remote_variant_id: "remote-v1",
      p_remote_inventory_item_id: null,
      p_remote_sku: "REMOTE-SKU",
      p_actor_id: "00000000-0000-0000-0000-000000000001",
      p_match_method: "manual",
      p_match_confidence: "high",
      p_match_reasons: [],
      p_candidate_snapshot: {},
      p_candidate_fingerprint: "fp-integ",
      p_notes: "integration probe",
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/variant org not covered by connection/i);
  });

  it("cannot insert a second primary coverage row for the same connection", async () => {
    const dup = await service.from("client_store_connection_org_coverage").insert({
      workspace_id: wsId,
      connection_id: connectionId,
      org_id: orgUncoveredId,
      coverage_role: "primary",
    });

    expect(dup.error).not.toBeNull();
    const msg = `${dup.error?.message ?? ""} ${dup.error?.code ?? ""}`;
    expect(
      msg.includes("23505") ||
        /one_primary|duplicate|unique/i.test(msg) ||
        /primary org .* must equal connection org/i.test(msg),
    ).toBe(true);
  });
});
