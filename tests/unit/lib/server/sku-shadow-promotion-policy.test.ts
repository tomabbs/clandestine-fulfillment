/**
 * Unit tests for the pure shadow-promotion evaluator.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md → §"Promotion paths".
 *
 * Coverage matrix:
 *   * Path A — each evidence flag individually triggers promote.
 *   * Path B — age + decision count boundary conditions.
 *   * Warehouse gates — `warehouse_stock_at_match` + `warehouseAtpNow`.
 *   * Stability gate — promotion window + missing stock signal.
 *   * Non-promotable outcome state short-circuits immediately.
 *   * Audit disqualifiers — all gates that veto a bump record a code.
 */

import { describe, expect, it } from "vitest";
import {
  ageDaysBetween,
  SHADOW_DECISION_COUNT_MIN,
  SHADOW_STABILITY_DAYS_MIN,
  type ShadowPromotionCandidate,
  shouldPromoteShadow,
} from "@/lib/server/sku-shadow-promotion-policy";
import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-01T12:00:00Z");

/**
 * Build a stable stock signal + "identical last 6h" history so the
 * stability gate passes by default. Tests that want to fail the gate
 * override either `stockSignal` or `stabilityHistory`.
 */
function stableStockInputs(value: number = 5): {
  stockSignal: StockSignal;
  stabilityHistory: StockHistoryReadings;
} {
  return {
    stockSignal: {
      value,
      observedAt: NOW.toISOString(),
      observedAtLocal: NOW.toISOString(),
      source: "warehouse_inventory_levels",
      tier: "authoritative",
    },
    stabilityHistory: {
      readings: [
        { observedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(), value },
        { observedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), value },
        { observedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(), value },
        { observedAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1000).toISOString(), value },
        { observedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(), value },
        { observedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString(), value },
      ],
    },
  };
}

function baseCandidate(
  overrides: Partial<ShadowPromotionCandidate> = {},
): ShadowPromotionCandidate {
  const stock = stableStockInputs(5);
  return {
    identityMatchId: "id-1",
    workspaceId: "ws-1",
    connectionId: "conn-1",
    variantId: "var-1",
    outcomeState: "auto_database_identity_match",
    stateVersion: 3,
    createdAt: "2026-04-01T00:00:00Z",
    evaluationCount: 4,
    warehouseStockAtMatch: 5,
    pathAEvidence: {},
    priorDatabaseIdentityDecisionCount: 0,
    warehouseAtpNow: 5,
    stockSignal: stock.stockSignal,
    stabilityHistory: stock.stabilityHistory,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Path A
// ─────────────────────────────────────────────────────────────────────

describe("shouldPromoteShadow — Path A", () => {
  it("promotes on verified Bandcamp option", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        pathAEvidence: { verifiedBandcampOption: true },
      }),
      NOW,
    );
    expect(decision).toEqual({
      action: "promote",
      path: "A",
      reasonCode: "verified_bandcamp_option",
      disqualifiers: [],
    });
  });

  it("promotes on exact barcode match", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({ pathAEvidence: { exactBarcodeMatch: true } }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "promote",
      path: "A",
      reasonCode: "exact_barcode_match",
    });
  });

  it("promotes on exact SKU match (safe)", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({ pathAEvidence: { exactSkuMatchSafe: true } }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "promote",
      path: "A",
      reasonCode: "exact_sku_match",
    });
  });

  it("prioritizes Bandcamp > barcode > SKU when multiple flags set", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        pathAEvidence: {
          verifiedBandcampOption: true,
          exactBarcodeMatch: true,
          exactSkuMatchSafe: true,
        },
      }),
      NOW,
    );
    expect(decision).toMatchObject({ path: "A", reasonCode: "verified_bandcamp_option" });
  });

  it("falls through to Path B if Path A evidence is missing", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        pathAEvidence: {},
        createdAt: new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        priorDatabaseIdentityDecisionCount: 6,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "promote",
      path: "B",
      reasonCode: "shadow_stability_window_passed",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Path B
// ─────────────────────────────────────────────────────────────────────

describe("shouldPromoteShadow — Path B", () => {
  it("promotes exactly at the 14-day boundary with 5 decisions", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        createdAt: new Date(
          NOW.getTime() - SHADOW_STABILITY_DAYS_MIN * 24 * 60 * 60 * 1000,
        ).toISOString(),
        priorDatabaseIdentityDecisionCount: SHADOW_DECISION_COUNT_MIN,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "promote",
      path: "B",
      reasonCode: "shadow_stability_window_passed",
    });
  });

  it("bumps when age is one day short of the minimum", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        createdAt: new Date(
          NOW.getTime() - (SHADOW_STABILITY_DAYS_MIN - 1) * 24 * 60 * 60 * 1000,
        ).toISOString(),
        priorDatabaseIdentityDecisionCount: 10,
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("path_b_age_not_met");
    }
  });

  it("bumps when decision count is one short", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        createdAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        priorDatabaseIdentityDecisionCount: SHADOW_DECISION_COUNT_MIN - 1,
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("path_b_decision_count_not_met");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Operational gates
// ─────────────────────────────────────────────────────────────────────

describe("shouldPromoteShadow — operational gates", () => {
  it("bumps when warehouse_stock_at_match is zero", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        warehouseStockAtMatch: 0,
        pathAEvidence: { verifiedBandcampOption: true },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("warehouse_stock_at_match_not_positive");
    }
  });

  it("bumps when warehouseAtpNow is zero even if stock_at_match was positive", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        warehouseAtpNow: 0,
        pathAEvidence: { verifiedBandcampOption: true },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("warehouse_atp_not_positive");
    }
  });

  it("treats null warehouseAtpNow as zero (fails operational gate)", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        warehouseAtpNow: null,
        pathAEvidence: { exactBarcodeMatch: true },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("warehouse_atp_not_positive");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Stability gate
// ─────────────────────────────────────────────────────────────────────

describe("shouldPromoteShadow — stability gate", () => {
  it("bumps when the stability gate fails (stock_unstable)", () => {
    const stock = stableStockInputs(5);
    const unstableHistory: StockHistoryReadings = {
      readings: [
        { observedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(), value: 5 },
        { observedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), value: 6 }, // jiggle
      ],
    };
    const decision = shouldPromoteShadow(
      baseCandidate({
        stockSignal: stock.stockSignal,
        stabilityHistory: unstableHistory,
        pathAEvidence: { verifiedBandcampOption: true },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("stability_gate_failed");
    }
  });

  it("bumps when stockSignal is null (no reading available)", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        stockSignal: null,
        pathAEvidence: { exactBarcodeMatch: true },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toContain("missing_stock_signal");
      expect(decision.disqualifiers).toContain("stability_gate_failed");
    }
  });

  it("does not promote when gate fails even with Path A evidence", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        stockSignal: null,
        pathAEvidence: {
          verifiedBandcampOption: true,
          exactBarcodeMatch: true,
          exactSkuMatchSafe: true,
        },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Short-circuit on wrong outcome state
// ─────────────────────────────────────────────────────────────────────

describe("shouldPromoteShadow — outcome_state guard", () => {
  it.each([
    "auto_live_inventory_alias",
    "auto_shadow_identity_match",
    "auto_holdout_for_evidence",
    "auto_reject_non_match",
    "client_stock_exception",
    "manual_review_pending",
  ])("short-circuits when outcomeState is %s", (state) => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        outcomeState: state,
        pathAEvidence: { verifiedBandcampOption: true },
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      expect(decision.disqualifiers).toEqual(["outcome_state_not_promotable"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Disqualifier aggregation
// ─────────────────────────────────────────────────────────────────────

describe("shouldPromoteShadow — disqualifier dedup", () => {
  it("dedupes overlapping disqualifiers (e.g. both gate checks fail)", () => {
    const decision = shouldPromoteShadow(
      baseCandidate({
        warehouseStockAtMatch: 0,
        warehouseAtpNow: 0,
        stockSignal: null,
        createdAt: NOW.toISOString(),
        priorDatabaseIdentityDecisionCount: 0,
      }),
      NOW,
    );
    expect(decision.action).toBe("bump");
    if (decision.action === "bump") {
      const uniqueCount = new Set(decision.disqualifiers).size;
      expect(uniqueCount).toBe(decision.disqualifiers.length);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// ageDaysBetween
// ─────────────────────────────────────────────────────────────────────

describe("ageDaysBetween", () => {
  it("returns floor(days)", () => {
    expect(ageDaysBetween("2026-04-01T00:00:00Z", new Date("2026-04-15T00:00:00Z"))).toBe(14);
    expect(ageDaysBetween("2026-04-01T00:00:00Z", new Date("2026-04-14T23:59:59Z"))).toBe(13);
  });

  it("returns 0 for future-dated createdAt (clock skew guard)", () => {
    expect(ageDaysBetween("2030-01-01T00:00:00Z", new Date("2026-04-01T00:00:00Z"))).toBe(0);
  });

  it("returns 0 for invalid createdAt", () => {
    expect(ageDaysBetween("not-a-date", new Date("2026-04-01T00:00:00Z"))).toBe(0);
  });
});
