import { describe, expect, it } from "vitest";
import { computeBaselineAnomalies } from "@/trigger/tasks/bandcamp-baseline-audit";

/**
 * Phase 1 — `computeBaselineAnomalies` is the pure detector for
 * non-zero merchant baselines on Bandcamp products. It is the heart of
 * `bandcamp-baseline-audit` and runs entirely on already-stored API data
 * (no Bandcamp API call). These tests pin the SQL detector logic from
 * plan §5.2.3 to TS so a regression here can never silently corrupt the
 * `bandcamp_baseline_anomalies` table or the `push_mode` enum on
 * `bandcamp_product_mappings`.
 *
 * Suggest-don't-mutate contract: the detector must NEVER false-positive on
 * empty/missing origin data — a freshly synced mapping with `null` origins
 * must produce `[]`, not an anomaly.
 */

describe("computeBaselineAnomalies", () => {
  it("returns [] when raw_api_data is missing", () => {
    expect(computeBaselineAnomalies(null, [])).toEqual([]);
    expect(computeBaselineAnomalies(undefined, [])).toEqual([]);
  });

  it("returns [] when origin_quantities is null (mapping not yet hydrated)", () => {
    expect(computeBaselineAnomalies({ quantity_available: 100 }, null)).toEqual([]);
    expect(computeBaselineAnomalies({ quantity_available: 100 }, undefined)).toEqual([]);
  });

  it("returns [] when TOP equals sum of origin allocations (healthy package)", () => {
    const anomalies = computeBaselineAnomalies({ quantity_available: 50 }, [
      {
        origin_id: 1,
        option_quantities: [{ option_id: null, quantity_available: 50 }],
      },
    ]);
    expect(anomalies).toEqual([]);
  });

  it("flags a package-level baseline when TOP > sum(origins)", () => {
    // Lord Spikeheart's MOSH PIT POWER Tee shape but at the package level —
    // baseline 100, origin 0, TOP 100 ⇒ inferred baseline = 100.
    const anomalies = computeBaselineAnomalies({ quantity_available: 100 }, [
      {
        origin_id: 1,
        option_quantities: [{ option_id: null, quantity_available: 0 }],
      },
    ]);
    expect(anomalies).toEqual([{ option_id: null, baseline_qty: 100 }]);
  });

  it("flags option-level baselines and emits one row per option_id", () => {
    // 3 sizes (S/M/L), each baseline 100, origins all 0, TOP 300 ⇒
    // aggregate baseline 300 attributed to all three options.
    const anomalies = computeBaselineAnomalies({ quantity_available: 300 }, [
      {
        origin_id: 1,
        option_quantities: [
          { option_id: 1052499935, quantity_available: 0 },
          { option_id: 1052499936, quantity_available: 0 },
          { option_id: 1052499937, quantity_available: 0 },
        ],
      },
    ]);
    expect(anomalies).toEqual([
      { option_id: 1052499935, baseline_qty: 300 },
      { option_id: 1052499936, baseline_qty: 300 },
      { option_id: 1052499937, baseline_qty: 300 },
    ]);
  });

  it("aggregates option totals across multiple origins before flagging", () => {
    // Same option exists in two origins (multi-origin merchant). Sum is taken
    // across both before comparing to TOP.
    // option 1: origin1=10 + origin2=15 = 25
    // option 2: origin1=5  + origin2=20 = 25
    // sum total = 50; TOP = 50 ⇒ HEALTHY (no anomaly).
    const anomalies = computeBaselineAnomalies({ quantity_available: 50 }, [
      {
        origin_id: 1,
        option_quantities: [
          { option_id: 1, quantity_available: 10 },
          { option_id: 2, quantity_available: 5 },
        ],
      },
      {
        origin_id: 2,
        option_quantities: [
          { option_id: 1, quantity_available: 15 },
          { option_id: 2, quantity_available: 20 },
        ],
      },
    ]);
    expect(anomalies).toEqual([]);
  });

  it("detects an anomaly even when origin allocations are non-zero (partial baseline)", () => {
    // Merchant set baseline 50 and we control origins 0+25 = 25, so TOP = 75.
    // baseline_qty = 75 - 25 = 50. Both options should be flagged with the
    // aggregate baseline (50) so the operator runbook reads the full picture.
    const anomalies = computeBaselineAnomalies({ quantity_available: 75 }, [
      {
        origin_id: 1,
        option_quantities: [
          { option_id: 100, quantity_available: 0 },
          { option_id: 200, quantity_available: 25 },
        ],
      },
    ]);
    expect(anomalies).toEqual([
      { option_id: 100, baseline_qty: 50 },
      { option_id: 200, baseline_qty: 50 },
    ]);
  });

  it("does NOT false-positive when origin sum exceeds TOP (negative inferred baseline)", () => {
    // This shouldn't happen in practice (Bandcamp keeps TOP = baseline + origins),
    // but if a stale snapshot gets compared we must NOT flag the product —
    // baseline_qty must be > 0 to count.
    const anomalies = computeBaselineAnomalies({ quantity_available: 30 }, [
      {
        origin_id: 1,
        option_quantities: [{ option_id: null, quantity_available: 50 }],
      },
    ]);
    expect(anomalies).toEqual([]);
  });

  it("ignores non-numeric quantity_available values", () => {
    expect(
      computeBaselineAnomalies({ quantity_available: "abc" }, [
        {
          origin_id: 1,
          option_quantities: [{ option_id: null, quantity_available: 0 }],
        },
      ]),
    ).toEqual([]);
  });
});
