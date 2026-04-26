/**
 * Unit tests — promoteIdentityMatchToAlias() + isPathReasonPairValid().
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Shadow-to-live promotion criteria" (Paths A/B/C) +
 *       release gate SKU-AUTO-8.
 *
 * These tests exercise the wrapper's client-side gates (pair
 * validation, emergency pause, flag check, stock-stability) before
 * the RPC, and the server-side error mapping + decision-row insert
 * after. They use a narrow structural mock of the supabase client
 * (`makeMockSupabase()`); no real DB is touched.
 *
 * Coverage map:
 *   * isPathReasonPairValid: full 3×6 matrix + unknown path.
 *   * Short-circuits: pair mismatch, workspace read failure, missing
 *     workspace row, emergency pause (Path A/B/C).
 *   * Flag gate: autonomy disabled on A/B, bypassed on C.
 *   * Stock-stability: missing evidence on A/B, unstable reading,
 *     Path C skip.
 *   * Happy paths: Path A + B with stable stock, Path C without stock.
 *   * RPC error mapping: state_version_drift, identity_match_not_found,
 *     identity_match_not_promotable, no_canonical_variant,
 *     connection_not_eligible, scope_mismatch, atp_not_positive,
 *     shopify_remote_item_missing, unknown → rpc_error.
 *   * Response shape: bare string, array of string, array-of-object,
 *     object with named property, null → unexpected_response_shape.
 *   * Decision-row insert failures: error propagates, missing data
 *     propagates, non-string id propagates.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPathReasonPairValid,
  type PromoteIdentityMatchToAliasInput,
  type PromotionPath,
  type PromotionReasonCode,
  type PromotionSupabaseClient,
  promoteIdentityMatchToAlias,
} from "@/lib/server/sku-alias-promotion";
import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";

// ──────────────────────────────────────────────────────────────────────
// Mock supabase client
// ──────────────────────────────────────────────────────────────────────

interface MockSetup {
  workspaceRow?: Record<string, unknown> | null;
  workspaceReadError?: { message: string } | null;
  rpcResult?: { data: unknown; error: { message: string } | null };
  decisionInsertResult?: {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  };
}

interface MockSupabaseWithSpies {
  client: PromotionSupabaseClient;
  rpc: ReturnType<typeof vi.fn>;
  workspaceMaybeSingle: ReturnType<typeof vi.fn>;
  decisionInsert: ReturnType<typeof vi.fn>;
  decisionSingle: ReturnType<typeof vi.fn>;
}

function makeMockSupabase(setup: MockSetup = {}): MockSupabaseWithSpies {
  const rpc = vi.fn(async () => setup.rpcResult ?? { data: null, error: null });

  const workspaceMaybeSingle = vi.fn(async () => ({
    data: setup.workspaceRow ?? null,
    error: setup.workspaceReadError ?? null,
  }));

  const decisionSingle = vi.fn(async () => {
    // Explicit presence check, not `??`. Tests that pass
    // `decisionInsertResult: { data: null, error: null }` rely on
    // the null being preserved rather than defaulted to a stub id.
    if (setup.decisionInsertResult !== undefined) {
      return {
        data: setup.decisionInsertResult.data,
        error: setup.decisionInsertResult.error,
      };
    }
    return { data: { id: "decision-1" }, error: null };
  });

  const decisionInsert = vi.fn(() => ({
    select: () => ({ single: decisionSingle }),
  }));

  const from = vi.fn((table: string) => {
    if (table === "workspaces") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: workspaceMaybeSingle }),
        }),
        // `.insert()` never called for workspaces in this module; include
        // a stub so the structural type is still satisfied if a future
        // change calls it.
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
        }),
      };
    }
    if (table === "sku_autonomous_decisions") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        insert: decisionInsert,
      };
    }
    throw new Error(`unexpected from(${table}) in test`);
  });

  const client = { rpc, from } as unknown as PromotionSupabaseClient;
  return { client, rpc, workspaceMaybeSingle, decisionInsert, decisionSingle };
}

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

/** Workspace row with autonomy enabled and not emergency-paused. */
const happyWorkspace = {
  flags: { sku_live_alias_autonomy_enabled: true },
  sku_autonomous_emergency_paused: false,
};

/** Build a stock signal that `isStockStableFor('promotion', …)` accepts. */
function stableStockEvidence(): { signal: StockSignal; history: StockHistoryReadings } {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  return {
    signal: {
      value: 5,
      observedAt: ts,
      observedAtLocal: ts,
      source: "warehouse_inventory_levels",
      tier: "authoritative",
    },
    history: {
      // Three readings, all value=5, covering the 6h promotion window.
      readings: [
        { observedAt: new Date(now - 60_000).toISOString(), value: 5 },
        { observedAt: new Date(now - 30 * 60_000).toISOString(), value: 5 },
        { observedAt: new Date(now - 60 * 60_000).toISOString(), value: 5 },
      ],
    },
  };
}

/** Build a stock signal that fails the stability gate (value changed). */
function unstableStockEvidence(): { signal: StockSignal; history: StockHistoryReadings } {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  return {
    signal: {
      value: 5,
      observedAt: ts,
      observedAtLocal: ts,
      source: "warehouse_inventory_levels",
      tier: "authoritative",
    },
    history: {
      readings: [
        { observedAt: new Date(now - 60_000).toISOString(), value: 3 },
        { observedAt: new Date(now - 30 * 60_000).toISOString(), value: 5 },
      ],
    },
  };
}

function pathAInput(
  overrides: Partial<PromoteIdentityMatchToAliasInput> = {},
): PromoteIdentityMatchToAliasInput {
  return {
    workspaceId: "ws-1",
    connectionId: "conn-1",
    runId: "run-1",
    identityMatchId: "id-1",
    variantId: "var-1",
    expectedStateVersion: 3,
    path: "A",
    reasonCode: "exact_sku_match",
    triggeredBy: "sku-shadow-promotion",
    evidenceSnapshot: { candidate_count: 1 },
    evidenceHash: "sha256:abc",
    stockEvidence: stableStockEvidence(),
    ...overrides,
  };
}

function pathBInput(
  overrides: Partial<PromoteIdentityMatchToAliasInput> = {},
): PromoteIdentityMatchToAliasInput {
  return pathAInput({
    path: "B",
    reasonCode: "shadow_stability_window_passed",
    ...overrides,
  });
}

function pathCInput(
  overrides: Partial<PromoteIdentityMatchToAliasInput> = {},
): PromoteIdentityMatchToAliasInput {
  return pathAInput({
    path: "C",
    reasonCode: "human_override",
    triggeredBy: "human:user-1",
    stockEvidence: undefined,
    ...overrides,
  });
}

// ──────────────────────────────────────────────────────────────────────
// isPathReasonPairValid — pure predicate
// ──────────────────────────────────────────────────────────────────────

describe("isPathReasonPairValid — path/reason acceptance matrix", () => {
  const matrix: Array<{ path: PromotionPath; reason: PromotionReasonCode; expected: boolean }> = [
    // Path A accepts four reason codes.
    { path: "A", reason: "exact_barcode_match", expected: true },
    { path: "A", reason: "exact_sku_match", expected: true },
    { path: "A", reason: "verified_bandcamp_option", expected: true },
    { path: "A", reason: "stock_positive_promotion", expected: true },
    { path: "A", reason: "shadow_stability_window_passed", expected: false },
    { path: "A", reason: "human_override", expected: false },

    // Path B accepts two reason codes.
    { path: "B", reason: "shadow_stability_window_passed", expected: true },
    { path: "B", reason: "stock_positive_promotion", expected: true },
    { path: "B", reason: "exact_barcode_match", expected: false },
    { path: "B", reason: "exact_sku_match", expected: false },
    { path: "B", reason: "verified_bandcamp_option", expected: false },
    { path: "B", reason: "human_override", expected: false },

    // Path C accepts exactly one reason code.
    { path: "C", reason: "human_override", expected: true },
    { path: "C", reason: "exact_sku_match", expected: false },
    { path: "C", reason: "exact_barcode_match", expected: false },
    { path: "C", reason: "verified_bandcamp_option", expected: false },
    { path: "C", reason: "stock_positive_promotion", expected: false },
    { path: "C", reason: "shadow_stability_window_passed", expected: false },
  ];

  for (const { path, reason, expected } of matrix) {
    it(`path=${path} reason=${reason} → ${expected}`, () => {
      expect(isPathReasonPairValid(path, reason)).toBe(expected);
    });
  }

  it("unknown path returns false", () => {
    expect(isPathReasonPairValid("Z" as PromotionPath, "human_override")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// promoteIdentityMatchToAlias — client-side gates
// ──────────────────────────────────────────────────────────────────────

describe("promoteIdentityMatchToAlias — client-side gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid path/reason pair WITHOUT touching DB", async () => {
    const { client, rpc, workspaceMaybeSingle, decisionInsert } = makeMockSupabase();
    const r = await promoteIdentityMatchToAlias(
      client,
      pathAInput({ reasonCode: "human_override" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_path_reason_pair");
    expect(rpc).not.toHaveBeenCalled();
    expect(workspaceMaybeSingle).not.toHaveBeenCalled();
    expect(decisionInsert).not.toHaveBeenCalled();
  });

  it("propagates workspace read error as workspace_read_failed", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceReadError: { message: "boom" },
    });
    const r = await promoteIdentityMatchToAlias(client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("workspace_read_failed");
      expect(r.detail).toBe("boom");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns workspace_read_failed when the workspace row is missing", async () => {
    const { client, rpc } = makeMockSupabase({ workspaceRow: null });
    const r = await promoteIdentityMatchToAlias(client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("workspace_read_failed");
      expect(r.detail).toBe("workspace_not_found");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("emergency pause blocks Path A", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: { sku_live_alias_autonomy_enabled: true },
        sku_autonomous_emergency_paused: true,
      },
    });
    const r = await promoteIdentityMatchToAlias(client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("emergency_paused");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("emergency pause blocks Path B", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: { sku_live_alias_autonomy_enabled: true },
        sku_autonomous_emergency_paused: true,
      },
    });
    const r = await promoteIdentityMatchToAlias(client, pathBInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("emergency_paused");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("emergency pause blocks Path C (hard kill switch)", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: { sku_live_alias_autonomy_enabled: true },
        sku_autonomous_emergency_paused: true,
      },
    });
    const r = await promoteIdentityMatchToAlias(client, pathCInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("emergency_paused");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path A requires sku_live_alias_autonomy_enabled=true", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: { sku_live_alias_autonomy_enabled: false },
        sku_autonomous_emergency_paused: false,
      },
    });
    const r = await promoteIdentityMatchToAlias(client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("autonomy_flag_disabled");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path A treats missing flag as disabled", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: {},
        sku_autonomous_emergency_paused: false,
      },
    });
    const r = await promoteIdentityMatchToAlias(client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("autonomy_flag_disabled");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path B requires sku_live_alias_autonomy_enabled=true", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: { sku_live_alias_autonomy_enabled: false },
        sku_autonomous_emergency_paused: false,
      },
    });
    const r = await promoteIdentityMatchToAlias(client, pathBInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("autonomy_flag_disabled");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path C bypasses the flag gate entirely (human override)", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: {
        flags: { sku_live_alias_autonomy_enabled: false },
        sku_autonomous_emergency_paused: false,
      },
      rpcResult: { data: "alias-c-1", error: null },
    });
    const r = await promoteIdentityMatchToAlias(client, pathCInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aliasId).toBe("alias-c-1");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("Path A without stockEvidence returns missing_stock_evidence", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: happyWorkspace,
    });
    const r = await promoteIdentityMatchToAlias(client, pathAInput({ stockEvidence: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_stock_evidence");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path B without stockEvidence returns missing_stock_evidence", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: happyWorkspace,
    });
    const r = await promoteIdentityMatchToAlias(client, pathBInput({ stockEvidence: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_stock_evidence");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path A with unstable stock returns stock_unstable", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: happyWorkspace,
    });
    const r = await promoteIdentityMatchToAlias(
      client,
      pathAInput({ stockEvidence: unstableStockEvidence() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stock_unstable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path B with unstable stock returns stock_unstable", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: happyWorkspace,
    });
    const r = await promoteIdentityMatchToAlias(
      client,
      pathBInput({ stockEvidence: unstableStockEvidence() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stock_unstable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Path C skips stock-stability even when stockEvidence is unstable", async () => {
    const { client, rpc } = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-c-2", error: null },
    });
    const r = await promoteIdentityMatchToAlias(
      client,
      pathCInput({ stockEvidence: unstableStockEvidence() }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aliasId).toBe("alias-c-2");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// promoteIdentityMatchToAlias — happy paths
// ──────────────────────────────────────────────────────────────────────

describe("promoteIdentityMatchToAlias — happy paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Path A writes the decision row with all expected fields", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-a-1", error: null },
    });
    const input = pathAInput();
    const r = await promoteIdentityMatchToAlias(mock.client, input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aliasId).toBe("alias-a-1");
      expect(r.decisionId).toBe("decision-1");
    }

    expect(mock.rpc).toHaveBeenCalledWith("promote_identity_match_to_alias", {
      p_identity_match_id: input.identityMatchId,
      p_expected_state_version: input.expectedStateVersion,
      p_reason_code: input.reasonCode,
      p_triggered_by: input.triggeredBy,
    });

    expect(mock.decisionInsert).toHaveBeenCalledTimes(1);
    const decisionRow = mock.decisionInsert.mock.calls[0]?.[0]?.[0] as Record<string, unknown>;
    expect(decisionRow).toMatchObject({
      run_id: input.runId,
      workspace_id: input.workspaceId,
      connection_id: input.connectionId,
      variant_id: input.variantId,
      outcome_state: "auto_live_inventory_alias",
      previous_outcome_state: "auto_database_identity_match",
      outcome_changed: true,
      reason_code: "exact_sku_match",
      evidence_snapshot: { candidate_count: 1 },
      evidence_hash: "sha256:abc",
      disqualifiers: [],
      top_candidates: [],
      alias_id: "alias-a-1",
      identity_match_id: "id-1",
    });
  });

  it("Path B success writes decision row with shadow_stability_window_passed", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-b-1", error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathBInput());
    expect(r.ok).toBe(true);
    const row = mock.decisionInsert.mock.calls[0]?.[0]?.[0] as Record<string, unknown>;
    expect(row.reason_code).toBe("shadow_stability_window_passed");
  });

  it("Path C success writes decision row with human_override and no stock eval", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-c-3", error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathCInput());
    expect(r.ok).toBe(true);
    const row = mock.decisionInsert.mock.calls[0]?.[0]?.[0] as Record<string, unknown>;
    expect(row.reason_code).toBe("human_override");
  });

  it("caller-supplied previousOutcomeState overrides the default", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-a-2", error: null },
    });
    const r = await promoteIdentityMatchToAlias(
      mock.client,
      pathAInput({ previousOutcomeState: "auto_database_identity_match" }),
    );
    expect(r.ok).toBe(true);
    const row = mock.decisionInsert.mock.calls[0]?.[0]?.[0] as Record<string, unknown>;
    expect(row.previous_outcome_state).toBe("auto_database_identity_match");
  });
});

// ──────────────────────────────────────────────────────────────────────
// promoteIdentityMatchToAlias — RPC error mapping
// ──────────────────────────────────────────────────────────────────────

describe("promoteIdentityMatchToAlias — RPC error → typed reason", () => {
  beforeEach(() => vi.clearAllMocks());

  const cases: Array<{ message: string; reason: string }> = [
    {
      message: "promote_identity_match_to_alias: state_version drift for x (expected 3, got 5)",
      reason: "state_version_drift",
    },
    {
      message: "promote_identity_match_to_alias: identity match abc not found",
      reason: "identity_match_not_found",
    },
    {
      message:
        "promote_identity_match_to_alias: identity match abc not in promotable state (state=client_stock_exception, active=true)",
      reason: "identity_match_not_promotable",
    },
    {
      message: "promote_identity_match_to_alias: identity match abc has no canonical variant",
      reason: "no_canonical_variant",
    },
    {
      message:
        "promote_identity_match_to_alias: connection xyz not eligible (status=disabled_auth_failure, do_not_fanout=true, cutover=legacy)",
      reason: "connection_not_eligible",
    },
    {
      message: "promote_identity_match_to_alias: scope mismatch for match abc",
      reason: "scope_mismatch",
    },
    {
      message:
        "promote_identity_match_to_alias: current warehouse ATP not positive for variant abc (available=0, committed=0)",
      reason: "atp_not_positive",
    },
    {
      message:
        "promote_identity_match_to_alias: Shopify match abc missing remote_inventory_item_id",
      reason: "shopify_remote_item_missing",
    },
    {
      message: "promote_identity_match_to_alias: some other failure",
      reason: "rpc_error",
    },
  ];

  for (const { message, reason } of cases) {
    it(`maps "${message.slice(0, 40)}..." → ${reason}`, async () => {
      const mock = makeMockSupabase({
        workspaceRow: happyWorkspace,
        rpcResult: { data: null, error: { message } },
      });
      const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        expect(r.detail).toBe(message);
      }
      expect(mock.decisionInsert).not.toHaveBeenCalled();
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// promoteIdentityMatchToAlias — RPC response shape variants
// ──────────────────────────────────────────────────────────────────────

describe("promoteIdentityMatchToAlias — extractAliasId shape tolerance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts bare-string RPC response", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-plain", error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aliasId).toBe("alias-plain");
  });

  it("accepts array-of-string RPC response", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: ["alias-from-array"], error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aliasId).toBe("alias-from-array");
  });

  it("accepts array-of-object with named property", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: {
        data: [{ promote_identity_match_to_alias: "alias-from-obj" }],
        error: null,
      },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aliasId).toBe("alias-from-obj");
  });

  it("accepts object with named property (no array wrap)", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: {
        data: { promote_identity_match_to_alias: "alias-from-scalar-obj" },
        error: null,
      },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aliasId).toBe("alias-from-scalar-obj");
  });

  it("null RPC response → unexpected_response_shape", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: null, error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
    expect(mock.decisionInsert).not.toHaveBeenCalled();
  });

  it("empty string → unexpected_response_shape", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "", error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("empty array → unexpected_response_shape", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: [], error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });
});

// ──────────────────────────────────────────────────────────────────────
// promoteIdentityMatchToAlias — decision-row insert failures
// ──────────────────────────────────────────────────────────────────────

describe("promoteIdentityMatchToAlias — decision-row insert failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insert error → decision_insert_failed AND preserves error detail", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-orphan", error: null },
      decisionInsertResult: {
        data: null,
        error: { message: "insert blew up" },
      },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("decision_insert_failed");
      expect(r.detail).toBe("insert blew up");
    }
  });

  it("insert success but missing data → decision_insert_failed", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-orphan-2", error: null },
      decisionInsertResult: { data: null, error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("decision_insert_failed");
  });

  it("insert success but non-string id → unexpected_response_shape", async () => {
    const mock = makeMockSupabase({
      workspaceRow: happyWorkspace,
      rpcResult: { data: "alias-orphan-3", error: null },
      decisionInsertResult: { data: { id: 12345 }, error: null },
    });
    const r = await promoteIdentityMatchToAlias(mock.client, pathAInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });
});
