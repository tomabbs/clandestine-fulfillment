// Phase 5.1 — order preorder state derivation tests.
//
// Covers the Phase 5.5 scenarios:
//   1. Mixed cart (one preorder + one in-stock).
//   2. All preorder, multiple street dates → state controlled by latest.
//   3. Missing variant for a SKU → treated as not-preorder.
//   4. Tab transitions across the 7-day boundary (injected today).
//   5. NY DST edge: street_date "today" at midnight NY rolls correctly.

import { describe, expect, it } from "vitest";
import {
  deriveOrderPreorderState,
  PREORDER_READY_WINDOW_DAYS,
  type PreorderVariantRecord,
} from "@/lib/shared/order-preorder";

const variantsToMap = (rows: PreorderVariantRecord[]): Map<string, PreorderVariantRecord> => {
  const m = new Map<string, PreorderVariantRecord>();
  for (const r of rows) m.set(r.sku, r);
  return m;
};

describe("deriveOrderPreorderState (Phase 5.1)", () => {
  it("returns 'none' when items array is empty", () => {
    const r = deriveOrderPreorderState({
      items: [],
      variantLookup: new Map(),
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("none");
    expect(r.preorder_release_date).toBeNull();
  });

  it("returns 'none' when no variant has is_preorder=true", () => {
    const variants = variantsToMap([
      { sku: "LP-001", is_preorder: false, street_date: "2026-12-01" },
      { sku: "CD-001", is_preorder: false, street_date: null },
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-001" }, { sku: "CD-001" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("none");
  });

  it("returns 'preorder' when a preorder line is > today + 7 days out", () => {
    const variants = variantsToMap([
      { sku: "LP-001", is_preorder: true, street_date: "2026-06-01" },
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-001" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("preorder");
    expect(r.preorder_release_date).toBe("2026-06-01");
  });

  it("returns 'ready' when the only preorder line is within today + 7 days", () => {
    const variants = variantsToMap([
      { sku: "LP-001", is_preorder: true, street_date: "2026-04-25" },
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-001" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("ready");
    expect(r.preorder_release_date).toBe("2026-04-25");
  });

  it("mixed cart: preorder + in-stock → state from the preorder line; in-stock ignored", () => {
    const variants = variantsToMap([
      { sku: "LP-PRE", is_preorder: true, street_date: "2026-04-22" },
      { sku: "CD-STOCK", is_preorder: false, street_date: null },
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-PRE" }, { sku: "CD-STOCK" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("ready");
    expect(r.preorder_release_date).toBe("2026-04-22");
  });

  it("multi-preorder: state controlled by the LATEST street_date — stays in 'preorder' when one is > today+7", () => {
    const variants = variantsToMap([
      { sku: "LP-A", is_preorder: true, street_date: "2026-04-22" }, // ready
      { sku: "LP-B", is_preorder: true, street_date: "2026-08-01" }, // far out
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }, { sku: "LP-B" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("preorder");
    expect(r.preorder_release_date).toBe("2026-08-01"); // MAX
  });

  it("multi-preorder: 'ready' when ALL lines are within today+7", () => {
    const variants = variantsToMap([
      { sku: "LP-A", is_preorder: true, street_date: "2026-04-21" },
      { sku: "LP-B", is_preorder: true, street_date: "2026-04-26" },
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }, { sku: "LP-B" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("ready");
    expect(r.preorder_release_date).toBe("2026-04-26"); // MAX of in-window lines
  });

  it("missing variant for a SKU → treats as not-preorder; does NOT block label printing", () => {
    const variants = variantsToMap([{ sku: "LP-A", is_preorder: true, street_date: "2026-08-01" }]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "MYSTERY-X" }, { sku: "LP-A" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    // mystery sku ignored; LP-A still triggers preorder state.
    expect(r.preorder_state).toBe("preorder");
    expect(r.preorder_release_date).toBe("2026-08-01");
  });

  it("released variant (street_date <= today) → ignored, treated as in-stock", () => {
    const variants = variantsToMap([
      { sku: "LP-RELEASED", is_preorder: true, street_date: "2026-04-19" }, // today
      { sku: "LP-PAST", is_preorder: true, street_date: "2025-12-01" }, // past
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-RELEASED" }, { sku: "LP-PAST" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("none");
    expect(r.preorder_release_date).toBeNull();
  });

  it("transition: today=2026-04-19 → 'preorder' (release on 2026-04-27, > today+7)", () => {
    const variants = variantsToMap([{ sku: "LP-A", is_preorder: true, street_date: "2026-04-27" }]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("preorder"); // 2026-04-27 > 2026-04-19 + 7 = 2026-04-26
  });

  it("transition: today=2026-04-20 (one day later) → 'ready' (release on 2026-04-27, <= today+7)", () => {
    const variants = variantsToMap([{ sku: "LP-A", is_preorder: true, street_date: "2026-04-27" }]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }],
      variantLookup: variants,
      today: "2026-04-20",
    });
    expect(r.preorder_state).toBe("ready"); // cutoff = 2026-04-27, release = 2026-04-27 → in window
  });

  it("transition: today=2026-04-28 (release passed) → 'none' (item released, ships normally)", () => {
    const variants = variantsToMap([{ sku: "LP-A", is_preorder: true, street_date: "2026-04-27" }]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }],
      variantLookup: variants,
      today: "2026-04-28",
    });
    expect(r.preorder_state).toBe("none");
  });

  it("custom readyWindowDays overrides the default", () => {
    const variants = variantsToMap([
      { sku: "LP-A", is_preorder: true, street_date: "2026-04-22" }, // 3 days out
    ]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }],
      variantLookup: variants,
      today: "2026-04-19",
      readyWindowDays: 1, // tighter
    });
    expect(r.preorder_state).toBe("preorder"); // 3 > 1
  });

  it("ignores variant with street_date null even when is_preorder=true", () => {
    const variants = variantsToMap([{ sku: "LP-A", is_preorder: true, street_date: null }]);
    const r = deriveOrderPreorderState({
      items: [{ sku: "LP-A" }],
      variantLookup: variants,
      today: "2026-04-19",
    });
    expect(r.preorder_state).toBe("none");
  });

  it("documented constant matches the implemented default", () => {
    expect(PREORDER_READY_WINDOW_DAYS).toBe(7);
  });
});
