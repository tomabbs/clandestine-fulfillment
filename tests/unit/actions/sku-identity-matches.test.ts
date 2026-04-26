import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 Slice 6.E — tests for the identity-matches read surface.
// Covers: requireStaff gate, filter pass-through, workspace-scoping
// defense, bounded page sizes, grouped-by-outcome aggregation, and
// transition history ordering.

const mockFrom = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ from: mockFrom }),
}));

import { getIdentityMatchDetail, listIdentityMatches } from "@/actions/sku-identity-matches";
import { requireStaff } from "@/lib/server/auth-context";

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase query builder — mirrors `sku-autonomous-runs.test.ts`. Records
// every method call so assertions can verify filter pass-through, and lets a
// test programmatically set the terminal resolve value.
// ─────────────────────────────────────────────────────────────────────────────

type TerminalShape = {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
};

function makeQueryBuilder(terminal: TerminalShape | Promise<TerminalShape>) {
  const resolved = Promise.resolve(terminal);
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  const builder: Record<string, unknown> = {
    select: rec("select"),
    eq: rec("eq"),
    gte: rec("gte"),
    lte: rec("lte"),
    order: rec("order"),
    limit: (n: number) => {
      calls.push({ method: "limit", args: [n] });
      return resolved;
    },
    range: (from: number, to: number) => {
      calls.push({ method: "range", args: [from, to] });
      return resolved;
    },
    maybeSingle: () => {
      calls.push({ method: "maybeSingle", args: [] });
      return resolved;
    },
  };

  return { builder, calls };
}

// RFC 4122 version-4 UUIDs for predictable assertions.
const CONN_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_ID = "22222222-2222-4222-8222-222222222222";
const MATCH_ID = "33333333-3333-4333-8333-333333333333";

describe("listIdentityMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("requires staff and returns workspace-scoped rows with total + grouping", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: [
        {
          id: MATCH_ID,
          workspace_id: "ws-1",
          org_id: "org-1",
          connection_id: CONN_ID,
          platform: "shopify",
          variant_id: VARIANT_ID,
          remote_product_id: "rp-1",
          remote_variant_id: "rv-1",
          remote_inventory_item_id: null,
          remote_sku: "SKU-1",
          remote_fingerprint: "fp-abc",
          outcome_state: "auto_database_identity_match",
          canonical_resolution_state: "resolved_to_variant",
          remote_listing_state: "sellable_product",
          match_method: "exact_sku",
          match_confidence: "high",
          evidence_hash: "hash-1",
          warehouse_stock_at_match: 5,
          remote_stock_at_match: 5,
          remote_stock_listed_at_match: true,
          state_version: 1,
          is_active: true,
          created_at: "2026-04-20T00:00:00Z",
          updated_at: "2026-04-26T00:00:00Z",
          last_evaluated_at: "2026-04-26T00:00:00Z",
          evaluation_count: 3,
          promoted_to_alias_at: null,
          promoted_alias_id: null,
          created_by_method: "autonomous_initial",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          workspace_id: "ws-1",
          org_id: "org-1",
          connection_id: CONN_ID,
          platform: "shopify",
          variant_id: null,
          remote_product_id: "rp-2",
          remote_variant_id: "rv-2",
          remote_inventory_item_id: null,
          remote_sku: "SKU-2",
          remote_fingerprint: "fp-def",
          outcome_state: "auto_holdout_for_evidence",
          canonical_resolution_state: "unresolved",
          remote_listing_state: "sellable_product",
          match_method: "evidence_gate",
          match_confidence: "low",
          evidence_hash: "hash-2",
          warehouse_stock_at_match: null,
          remote_stock_at_match: 2,
          remote_stock_listed_at_match: true,
          state_version: 2,
          is_active: true,
          created_at: "2026-04-20T00:00:00Z",
          updated_at: "2026-04-26T00:00:00Z",
          last_evaluated_at: "2026-04-26T00:00:00Z",
          evaluation_count: 1,
          promoted_to_alias_at: null,
          promoted_alias_id: null,
          created_by_method: "autonomous_periodic",
        },
      ],
      count: 42,
      error: null,
    });

    mockFrom.mockReturnValueOnce(builder);

    const result = await listIdentityMatches({ limit: 25, offset: 0 });

    expect(requireStaff).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledWith("client_store_product_identity_matches");
    const workspaceFilter = calls.find((c) => c.method === "eq" && c.args[0] === "workspace_id");
    expect(workspaceFilter).toMatchObject({ args: ["workspace_id", "ws-1"] });
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [0, 24] });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(42);
    expect(result.groupedByOutcomeState).toEqual({
      auto_database_identity_match: 1,
      auto_holdout_for_evidence: 1,
    });
  });

  it("applies every supported filter to the query", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], count: 0, error: null });
    mockFrom.mockReturnValueOnce(builder);

    await listIdentityMatches({
      connectionId: CONN_ID,
      variantId: VARIANT_ID,
      outcomeState: "auto_shadow_identity_match",
      canonicalResolutionState: "remote_only_unresolved",
      remoteListingState: "placeholder_sku",
      platform: "shopify",
      isActive: true,
      evaluatedAfter: "2026-04-20T00:00:00.000Z",
      evaluatedBefore: "2026-04-26T00:00:00.000Z",
      limit: 10,
      offset: 5,
    });

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["workspace_id", "ws-1"] },
        { method: "eq", args: ["connection_id", CONN_ID] },
        { method: "eq", args: ["variant_id", VARIANT_ID] },
        { method: "eq", args: ["outcome_state", "auto_shadow_identity_match"] },
        { method: "eq", args: ["canonical_resolution_state", "remote_only_unresolved"] },
        { method: "eq", args: ["remote_listing_state", "placeholder_sku"] },
        { method: "eq", args: ["platform", "shopify"] },
        { method: "eq", args: ["is_active", true] },
      ]),
    );
    expect(calls.find((c) => c.method === "gte")).toMatchObject({
      args: ["last_evaluated_at", "2026-04-20T00:00:00.000Z"],
    });
    expect(calls.find((c) => c.method === "lte")).toMatchObject({
      args: ["last_evaluated_at", "2026-04-26T00:00:00.000Z"],
    });
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [5, 14] });
  });

  it("caps limit to LIST_MAX_LIMIT via zod refinement (rejects 201)", async () => {
    const { builder } = makeQueryBuilder({ data: [], count: 0, error: null });
    mockFrom.mockReturnValue(builder);
    await expect(listIdentityMatches({ limit: 201 })).rejects.toThrow();
  });

  it("propagates supabase errors as thrown", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      count: null,
      error: { message: "db broke" },
    });
    mockFrom.mockReturnValueOnce(builder);
    await expect(listIdentityMatches({})).rejects.toThrow(/listIdentityMatches failed: db broke/);
  });
});

describe("getIdentityMatchDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("returns the match row plus transition history ordered desc by triggered_at", async () => {
    const matchBuilder = makeQueryBuilder({
      data: {
        id: MATCH_ID,
        workspace_id: "ws-1",
        org_id: "org-1",
        connection_id: CONN_ID,
        platform: "shopify",
        variant_id: VARIANT_ID,
        remote_product_id: "rp-1",
        remote_variant_id: "rv-1",
        remote_inventory_item_id: null,
        remote_sku: "SKU-1",
        remote_fingerprint: "fp-abc",
        outcome_state: "auto_database_identity_match",
        canonical_resolution_state: "resolved_to_variant",
        remote_listing_state: "sellable_product",
        match_method: "exact_sku",
        match_confidence: "high",
        evidence_snapshot: { signals: ["exact_sku"] },
        evidence_hash: "hash-1",
        warehouse_stock_at_match: 5,
        remote_stock_at_match: 5,
        remote_stock_listed_at_match: true,
        state_version: 3,
        is_active: true,
        created_at: "2026-04-20T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
        last_evaluated_at: "2026-04-26T00:00:00Z",
        evaluation_count: 4,
        promoted_to_alias_at: null,
        promoted_alias_id: null,
        created_by_method: "autonomous_initial",
      },
      error: null,
    });
    const transitionsBuilder = makeQueryBuilder({
      data: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          workspace_id: "ws-1",
          connection_id: CONN_ID,
          variant_id: VARIANT_ID,
          from_state: "auto_shadow_identity_match",
          to_state: "auto_database_identity_match",
          trigger: "evidence_gate",
          reason_code: "exact_sku_match",
          evidence_snapshot: {},
          identity_match_id: MATCH_ID,
          alias_id: null,
          triggered_by: "task:sku-shadow-promotion",
          triggered_at: "2026-04-26T00:05:00Z",
        },
      ],
      count: 1,
      error: null,
    });

    mockFrom
      .mockReturnValueOnce(matchBuilder.builder)
      .mockReturnValueOnce(transitionsBuilder.builder);

    const result = await getIdentityMatchDetail({ identityMatchId: MATCH_ID });

    expect(requireStaff).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenNthCalledWith(1, "client_store_product_identity_matches");
    expect(mockFrom).toHaveBeenNthCalledWith(2, "sku_outcome_transitions");

    const matchEqCalls = matchBuilder.calls.filter((c) => c.method === "eq");
    expect(matchEqCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["id", MATCH_ID] },
        { method: "eq", args: ["workspace_id", "ws-1"] },
      ]),
    );

    const txEqCalls = transitionsBuilder.calls.filter((c) => c.method === "eq");
    expect(txEqCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["identity_match_id", MATCH_ID] },
        { method: "eq", args: ["workspace_id", "ws-1"] },
      ]),
    );
    expect(transitionsBuilder.calls.find((c) => c.method === "order")).toMatchObject({
      args: ["triggered_at", { ascending: false }],
    });
    expect(transitionsBuilder.calls.find((c) => c.method === "limit")).toMatchObject({
      args: [50],
    });

    expect(result.match.id).toBe(MATCH_ID);
    expect(result.match.evidence_snapshot).toEqual({ signals: ["exact_sku"] });
    expect(result.transitions).toHaveLength(1);
    expect(result.transitionsTotal).toBe(1);
    expect(result.transitionsLimit).toBe(50);
  });

  it("throws 'Identity match not found' when the row does not belong to the workspace", async () => {
    const matchBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(matchBuilder.builder);

    await expect(getIdentityMatchDetail({ identityMatchId: MATCH_ID })).rejects.toThrow(
      /Identity match not found/,
    );
  });

  it("propagates supabase errors from the match read", async () => {
    const matchBuilder = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    mockFrom.mockReturnValueOnce(matchBuilder.builder);

    await expect(getIdentityMatchDetail({ identityMatchId: MATCH_ID })).rejects.toThrow(
      /getIdentityMatchDetail read failed: boom/,
    );
  });

  it("propagates supabase errors from the transitions read", async () => {
    const matchBuilder = makeQueryBuilder({
      data: {
        id: MATCH_ID,
        workspace_id: "ws-1",
        org_id: "org-1",
        connection_id: CONN_ID,
        platform: "shopify",
        variant_id: VARIANT_ID,
        remote_product_id: "rp-1",
        remote_variant_id: "rv-1",
        remote_inventory_item_id: null,
        remote_sku: "SKU-1",
        remote_fingerprint: "fp-abc",
        outcome_state: "auto_database_identity_match",
        canonical_resolution_state: "resolved_to_variant",
        remote_listing_state: "sellable_product",
        match_method: "exact_sku",
        match_confidence: "high",
        evidence_snapshot: {},
        evidence_hash: "hash-1",
        warehouse_stock_at_match: 5,
        remote_stock_at_match: 5,
        remote_stock_listed_at_match: true,
        state_version: 3,
        is_active: true,
        created_at: "2026-04-20T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
        last_evaluated_at: "2026-04-26T00:00:00Z",
        evaluation_count: 4,
        promoted_to_alias_at: null,
        promoted_alias_id: null,
        created_by_method: "autonomous_initial",
      },
      error: null,
    });
    const transitionsBuilder = makeQueryBuilder({
      data: null,
      count: null,
      error: { message: "tx boom" },
    });
    mockFrom
      .mockReturnValueOnce(matchBuilder.builder)
      .mockReturnValueOnce(transitionsBuilder.builder);

    await expect(getIdentityMatchDetail({ identityMatchId: MATCH_ID })).rejects.toThrow(
      /getIdentityMatchDetail transitions read failed: tx boom/,
    );
  });
});

describe("requireStaff gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listIdentityMatches surfaces requireStaff rejection", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("not staff"));
    await expect(listIdentityMatches({})).rejects.toThrow(/not staff/);
  });

  it("getIdentityMatchDetail surfaces requireStaff rejection", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("not staff"));
    await expect(getIdentityMatchDetail({ identityMatchId: MATCH_ID })).rejects.toThrow(
      /not staff/,
    );
  });
});
