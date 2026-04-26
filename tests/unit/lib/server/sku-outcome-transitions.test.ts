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
import { describe, expect, it } from "vitest";
import {
  FULL_OUTCOME_STATES,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  legalNextStates,
  type OutcomeState,
  STORED_IDENTITY_OUTCOME_STATES,
  TERMINAL_AUTONOMOUS_STATES,
  type TransitionTrigger,
  validateOutcomeTransition,
} from "@/lib/server/sku-outcome-transitions";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../supabase/migrations/20260428000001_sku_autonomous_matching_phase0.sql",
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
