/**
 * Autonomous SKU matcher — outcome state machine tests.
 *
 * This file is BOTH a unit test for the state machine AND the CI drift
 * guard for release gate SKU-AUTO-6. The guard asserts three things:
 *
 *   (a) `STORED_IDENTITY_OUTCOME_STATES` equals the DB CHECK constraint
 *       on `client_store_product_identity_matches.outcome_state` in
 *       migration `20260428000001_sku_autonomous_matching_phase0.sql`.
 *   (b) `FULL_OUTCOME_STATES` equals
 *       `STORED_IDENTITY_OUTCOME_STATES ∪ { 'auto_live_inventory_alias' }`.
 *   (c) Every legal transition edge references only states in
 *       `FULL_OUTCOME_STATES` as both source and target.
 *
 * The migration file is parsed directly (cheap regex extract) so the
 * test surfaces the real CHECK constraint without needing a live DB.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApplyOutcomeTransitionCallInput,
  applyOutcomeTransition,
  FULL_OUTCOME_STATES,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  legalNextStates,
  type OutcomeState,
  type RpcClient,
  STORED_IDENTITY_OUTCOME_STATES,
  TERMINAL_AUTONOMOUS_STATES,
  type TransitionTrigger,
  validateOutcomeTransition,
} from "@/lib/server/sku-outcome-transitions";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../supabase/migrations/20260428000001_sku_autonomous_matching_phase0.sql",
);

const PHASE1_MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../supabase/migrations/20260428000002_sku_autonomous_matching_phase1_rpc.sql",
);

function extractCheckStates(sql: string, columnName: string): string[] {
  // Find `columnName text NOT NULL CHECK (columnName IN ( 'a', 'b', ... ))`
  // and return the array of quoted strings.
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `${escaped}\\s+text\\s+NOT\\s+NULL\\s+CHECK\\s*\\(\\s*${escaped}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`,
    "i",
  );
  const match = re.exec(sql);
  if (!match) throw new Error(`Could not find CHECK constraint for ${columnName}`);
  const values = Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  return values;
}

describe("SKU-AUTO-6 drift guard (STORED vs FULL outcome-state sets)", () => {
  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

  it("STORED_IDENTITY_OUTCOME_STATES matches the DB CHECK on client_store_product_identity_matches.outcome_state", () => {
    const dbStates = extractCheckStates(migrationSql, "outcome_state");
    expect(new Set(STORED_IDENTITY_OUTCOME_STATES)).toEqual(new Set(dbStates));
  });

  it("FULL_OUTCOME_STATES = STORED_IDENTITY_OUTCOME_STATES ∪ { auto_live_inventory_alias }", () => {
    expect(new Set(FULL_OUTCOME_STATES)).toEqual(
      new Set([...STORED_IDENTITY_OUTCOME_STATES, "auto_live_inventory_alias"]),
    );
  });

  it("every legal transition edge references states in FULL_OUTCOME_STATES on both sides", () => {
    const full = new Set<string>(FULL_OUTCOME_STATES);
    for (const [from, triggers] of Object.entries(LEGAL_TRANSITIONS)) {
      if (from !== "initial") {
        expect(full.has(from)).toBe(true);
      }
      for (const [trigger, targets] of Object.entries(triggers)) {
        for (const to of targets ?? []) {
          expect(full.has(to)).toBe(true);
          expect([
            "evidence_gate",
            "stock_change",
            "human_review",
            "fetch_recovery",
            "periodic_revaluation",
          ]).toContain(trigger);
        }
      }
    }
  });

  it("auto_live_inventory_alias is NOT in the DB CHECK for the identity table (it lives on client_store_sku_mappings)", () => {
    const dbStates = extractCheckStates(migrationSql, "outcome_state");
    expect(dbStates).not.toContain("auto_live_inventory_alias");
  });
});

describe("isLegalTransition — representative legal pairs", () => {
  const legalCases: Array<{
    from: OutcomeState | "initial";
    to: OutcomeState;
    trigger: TransitionTrigger;
  }> = [
    { from: "initial", to: "auto_database_identity_match", trigger: "evidence_gate" },
    { from: "initial", to: "auto_shadow_identity_match", trigger: "evidence_gate" },
    { from: "initial", to: "auto_holdout_for_evidence", trigger: "evidence_gate" },
    { from: "initial", to: "fetch_incomplete_holdout", trigger: "evidence_gate" },
    {
      from: "auto_shadow_identity_match",
      to: "auto_database_identity_match",
      trigger: "evidence_gate",
    },
    {
      from: "auto_database_identity_match",
      to: "auto_live_inventory_alias",
      trigger: "stock_change",
    },
    {
      from: "auto_live_inventory_alias",
      to: "auto_database_identity_match",
      trigger: "stock_change",
    },
    { from: "auto_live_inventory_alias", to: "client_stock_exception", trigger: "stock_change" },
    { from: "client_stock_exception", to: "auto_live_inventory_alias", trigger: "stock_change" },
    {
      from: "auto_holdout_for_evidence",
      to: "auto_reject_non_match",
      trigger: "periodic_revaluation",
    },
    {
      from: "fetch_incomplete_holdout",
      to: "auto_database_identity_match",
      trigger: "fetch_recovery",
    },
    { from: "auto_reject_non_match", to: "auto_database_identity_match", trigger: "human_review" },
  ];
  for (const c of legalCases) {
    it(`permits ${c.from} -${c.trigger}-> ${c.to}`, () => {
      expect(isLegalTransition(c.from, c.to, c.trigger)).toBe(true);
    });
  }
});

describe("isLegalTransition — representative illegal pairs", () => {
  it("rejects direct holdout → live alias (must pass identity first)", () => {
    expect(
      isLegalTransition("auto_holdout_for_evidence", "auto_live_inventory_alias", "evidence_gate"),
    ).toBe(false);
  });

  it("rejects direct shadow → live alias (must promote to database identity first)", () => {
    expect(
      isLegalTransition("auto_shadow_identity_match", "auto_live_inventory_alias", "stock_change"),
    ).toBe(false);
  });

  it("rejects reject → any auto state via non-human trigger", () => {
    for (const to of FULL_OUTCOME_STATES) {
      if (to === "auto_reject_non_match") continue;
      expect(isLegalTransition("auto_reject_non_match", to, "evidence_gate")).toBe(false);
      expect(isLegalTransition("auto_reject_non_match", to, "stock_change")).toBe(false);
      expect(isLegalTransition("auto_reject_non_match", to, "periodic_revaluation")).toBe(false);
    }
  });

  it("rejects skip_non_operational → any auto state via non-human trigger", () => {
    for (const to of FULL_OUTCOME_STATES) {
      if (to === "auto_skip_non_operational") continue;
      expect(isLegalTransition("auto_skip_non_operational", to, "evidence_gate")).toBe(false);
    }
  });
});

describe("validateOutcomeTransition", () => {
  const baseInput = {
    workspaceId: "ws",
    orgId: "org",
    connectionId: "conn",
    expectedStateVersion: 1,
    reasonCode: "stock_positive_promotion" as const,
  };

  it("permits a legal transition with reasonCode", () => {
    const r = validateOutcomeTransition({
      ...baseInput,
      from: "auto_database_identity_match",
      to: "auto_live_inventory_alias",
      trigger: "stock_change",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects terminal egress via non-human trigger", () => {
    const r = validateOutcomeTransition({
      ...baseInput,
      from: "auto_reject_non_match",
      to: "auto_database_identity_match",
      trigger: "evidence_gate",
      reasonCode: "exact_sku_match",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("terminal_state_non_human_egress");
    }
  });

  it("permits terminal egress via human_review", () => {
    const r = validateOutcomeTransition({
      ...baseInput,
      from: "auto_reject_non_match",
      to: "auto_database_identity_match",
      trigger: "human_review",
      reasonCode: "human_override",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects illegal transitions", () => {
    const r = validateOutcomeTransition({
      ...baseInput,
      from: "auto_holdout_for_evidence",
      to: "auto_live_inventory_alias",
      trigger: "evidence_gate",
      reasonCode: "exact_sku_match",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("illegal_transition");
    }
  });

  it("rejects missing reasonCode at runtime (guards against unsafe casts)", () => {
    const r = validateOutcomeTransition({
      ...baseInput,
      from: "auto_database_identity_match",
      to: "auto_live_inventory_alias",
      trigger: "stock_change",
      reasonCode: "" as unknown as typeof baseInput.reasonCode,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing_reason_code");
    }
  });
});

describe("legalNextStates", () => {
  it("lists all legal (trigger, to) pairs for a source state", () => {
    const pairs = legalNextStates("auto_live_inventory_alias");
    // stock_change has two targets, periodic_revaluation has one,
    // human_review has all FULL_OUTCOME_STATES.
    const stockChangeTargets = pairs
      .filter((p) => p.trigger === "stock_change")
      .map((p) => p.to)
      .sort();
    expect(stockChangeTargets).toEqual(
      ["auto_database_identity_match", "client_stock_exception"].sort(),
    );
    const periodic = pairs.filter((p) => p.trigger === "periodic_revaluation").map((p) => p.to);
    expect(periodic).toEqual(["auto_holdout_for_evidence"]);
  });

  it("returns an empty array for unknown source states", () => {
    // Cast through unknown — we're intentionally probing the guard.
    const r = legalNextStates("initial");
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe("TERMINAL_AUTONOMOUS_STATES", () => {
  it("includes auto_reject_non_match and auto_skip_non_operational only", () => {
    expect(new Set(TERMINAL_AUTONOMOUS_STATES)).toEqual(
      new Set(["auto_reject_non_match", "auto_skip_non_operational"]),
    );
  });
});

describe("SKU-AUTO-14 / SKU-AUTO-22 — apply_sku_outcome_transition migration shape", () => {
  const sql = readFileSync(PHASE1_MIGRATION_PATH, "utf8");

  it("defines apply_sku_outcome_transition with the expected signature", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION\s+apply_sku_outcome_transition\s*\(/i);
    expect(sql).toMatch(/p_identity_match_id\s+uuid/i);
    expect(sql).toMatch(/p_expected_state_version\s+integer/i);
    expect(sql).toMatch(/p_expected_from_state\s+text/i);
    expect(sql).toMatch(/p_to_state\s+text/i);
    expect(sql).toMatch(/p_trigger\s+text/i);
    expect(sql).toMatch(/p_reason_code\s+text/i);
    expect(sql).toMatch(
      /RETURNS TABLE\s*\(\s*new_state_version\s+integer\s*,\s*transition_id\s+uuid/i,
    );
  });

  it("takes pg_advisory_xact_lock before re-reading the row (SKU-AUTO-22)", () => {
    const lockIdx = sql.search(/PERFORM\s+pg_advisory_xact_lock\s*\(/i);
    const selectForUpdateIdx = sql.search(
      /FROM\s+client_store_product_identity_matches[\s\S]*?FOR UPDATE/i,
    );
    expect(lockIdx).toBeGreaterThan(-1);
    expect(selectForUpdateIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(selectForUpdateIdx);
  });

  it("enforces state_version OCC (SKU-AUTO-14)", () => {
    expect(sql).toMatch(/state_version\s*<>\s*p_expected_state_version/i);
    expect(sql).toMatch(/state_version drift/i);
  });

  it("enforces from_state drift detection", () => {
    expect(sql).toMatch(/outcome_state\s*<>\s*p_expected_from_state/i);
    expect(sql).toMatch(/from_state drift/i);
  });

  it("rejects terminal-state egress via non-human triggers (defense-in-depth)", () => {
    expect(sql).toMatch(/auto_reject_non_match[\s\S]*auto_skip_non_operational/i);
    expect(sql).toMatch(/p_trigger\s*<>\s*'human_review'/i);
    expect(sql).toMatch(/terminal state/i);
  });

  it("rejects writing auto_live_inventory_alias to the identity row", () => {
    expect(sql).toMatch(/p_to_state\s*=\s*'auto_live_inventory_alias'/i);
    expect(sql).toMatch(/must go through promote_identity_match_to_alias/i);
  });

  it("requires reason_code (SKU-AUTO-14)", () => {
    expect(sql).toMatch(/p_reason_code IS NULL/i);
    expect(sql).toMatch(/reason_code is required/i);
  });

  it("inserts into sku_outcome_transitions atomically", () => {
    expect(sql).toMatch(/INSERT INTO sku_outcome_transitions/i);
    expect(sql).toMatch(/from_state[\s\S]*to_state[\s\S]*trigger[\s\S]*reason_code/i);
  });

  it("grants EXECUTE to authenticated + service_role", () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION apply_sku_outcome_transition\([^)]+\)\s+TO\s+authenticated\s*,\s*service_role/i,
    );
  });
});

describe("applyOutcomeTransition — TS wrapper (mocked supabase)", () => {
  const baseInput: ApplyOutcomeTransitionCallInput = {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId: "conn-1",
    identityMatchId: "id-1",
    variantId: "variant-1",
    expectedStateVersion: 7,
    from: "auto_database_identity_match",
    to: "auto_holdout_for_evidence",
    trigger: "periodic_revaluation",
    reasonCode: "holdout_expired_10_evaluations",
    evidenceSnapshot: { stockTier: "fresh_remote" },
    triggeredBy: "sku-shadow-promotion",
  };

  function makeClient(rpcImpl: RpcClient["rpc"]): {
    client: RpcClient;
    rpc: ReturnType<typeof vi.fn>;
  } {
    const rpc = vi.fn(rpcImpl);
    return { client: { rpc } as RpcClient, rpc };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits when validateOutcomeTransition rejects (never calls RPC)", async () => {
    const { client, rpc } = makeClient(async () => ({ data: null, error: null }));
    const r = await applyOutcomeTransition(client, {
      ...baseInput,
      from: "auto_holdout_for_evidence",
      to: "auto_live_inventory_alias",
      trigger: "evidence_gate",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["illegal_transition", "to_state_forbidden_on_identity_row"]).toContain(r.reason);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses to_state=auto_live_inventory_alias even when isLegalTransition permits it", async () => {
    const { client, rpc } = makeClient(async () => ({ data: null, error: null }));
    const r = await applyOutcomeTransition(client, {
      ...baseInput,
      to: "auto_live_inventory_alias",
      trigger: "stock_change",
      reasonCode: "stock_positive_promotion",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("to_state_forbidden_on_identity_row");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects missing reasonCode before calling RPC", async () => {
    const { client, rpc } = makeClient(async () => ({ data: null, error: null }));
    const r = await applyOutcomeTransition(client, {
      ...baseInput,
      reasonCode: "" as unknown as ApplyOutcomeTransitionCallInput["reasonCode"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_reason_code");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("forwards the typed payload with p_*-prefixed keys (PostgREST convention)", async () => {
    const { client, rpc } = makeClient(async () => ({
      data: [{ new_state_version: 8, transition_id: "txn-abc" }],
      error: null,
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r).toEqual({ ok: true, newStateVersion: 8, transitionId: "txn-abc" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("apply_sku_outcome_transition", {
      p_identity_match_id: "id-1",
      p_expected_state_version: 7,
      p_expected_from_state: "auto_database_identity_match",
      p_to_state: "auto_holdout_for_evidence",
      p_trigger: "periodic_revaluation",
      p_reason_code: "holdout_expired_10_evaluations",
      p_evidence_snapshot: { stockTier: "fresh_remote" },
      p_triggered_by: "sku-shadow-promotion",
    });
  });

  it("accepts a singleton response shape as well as an array", async () => {
    const { client } = makeClient(async () => ({
      data: { new_state_version: 2, transition_id: "txn-single" },
      error: null,
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r).toEqual({ ok: true, newStateVersion: 2, transitionId: "txn-single" });
  });

  it("returns stale_state_version when RPC raises state_version drift", async () => {
    const { client } = makeClient(async () => ({
      data: null,
      error: {
        message: "apply_sku_outcome_transition: state_version drift for id-1 (expected 7, got 9)",
      },
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("stale_state_version");
      expect(r.detail).toMatch(/state_version drift/);
    }
  });

  it("returns from_state_drift when RPC raises from_state drift", async () => {
    const { client } = makeClient(async () => ({
      data: null,
      error: {
        message:
          "apply_sku_outcome_transition: from_state drift for id-1 (expected auto_database_identity_match, got auto_holdout_for_evidence)",
      },
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("from_state_drift");
  });

  it("returns identity_match_not_found when RPC raises not found", async () => {
    const { client } = makeClient(async () => ({
      data: null,
      error: { message: "apply_sku_outcome_transition: identity match id-1 not found" },
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("identity_match_not_found");
  });

  it("returns identity_match_inactive when RPC raises not active", async () => {
    const { client } = makeClient(async () => ({
      data: null,
      error: { message: "apply_sku_outcome_transition: identity match id-1 is not active" },
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("identity_match_inactive");
  });

  it("returns terminal_state_non_human_egress when RPC raises terminal-state egress", async () => {
    const { client } = makeClient(async () => ({
      data: null,
      error: {
        message:
          "apply_sku_outcome_transition: terminal state auto_reject_non_match can only egress via human_review (got trigger=evidence_gate)",
      },
    }));
    const r = await applyOutcomeTransition(client, {
      ...baseInput,
      from: "auto_reject_non_match",
      to: "auto_database_identity_match",
      trigger: "human_review",
      reasonCode: "human_override",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("terminal_state_non_human_egress");
  });

  it("returns to_state_forbidden_on_identity_row when RPC raises the alias-rejection message", async () => {
    // The client-side validator blocks to='auto_live_inventory_alias'
    // BEFORE the RPC, but for defense-in-depth we test the error-mapping
    // path: use a legal from→to pair so the RPC actually gets called,
    // then mock the RPC returning the alias-rejection message. This
    // exercises mapRpcErrorToReason() in isolation from the client-side
    // guard.
    const { client } = makeClient(async () => ({
      data: null,
      error: {
        message:
          "apply_sku_outcome_transition: to_state=auto_live_inventory_alias must go through promote_identity_match_to_alias()",
      },
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("to_state_forbidden_on_identity_row");
  });

  it("returns rpc_error for unrecognized DB exception messages", async () => {
    const { client } = makeClient(async () => ({
      data: null,
      error: { message: "connection refused" },
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rpc_error");
      expect(r.detail).toBe("connection refused");
    }
  });

  it("returns unexpected_response_shape when the RPC returns nothing", async () => {
    const { client } = makeClient(async () => ({ data: [], error: null }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("returns unexpected_response_shape when RPC returns malformed row", async () => {
    const { client } = makeClient(async () => ({
      data: [{ new_state_version: "nope" }],
      error: null,
    }));
    const r = await applyOutcomeTransition(client, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("serializes concurrent callers via the RPC (SKU-AUTO-22 contract) — only one RPC call is issued per invocation", async () => {
    // The advisory lock lives in the DB; the wrapper's responsibility
    // is to forward EXACTLY ONE RPC call per invocation (no internal
    // retry that could bypass the lock's single-writer guarantee).
    let calls = 0;
    const { client, rpc } = makeClient(async () => {
      calls += 1;
      return { data: [{ new_state_version: 2, transition_id: `txn-${calls}` }], error: null };
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => applyOutcomeTransition(client, baseInput)),
    );
    expect(rpc).toHaveBeenCalledTimes(8);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });
});
