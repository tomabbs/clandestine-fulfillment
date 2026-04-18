/**
 * Phase 6 — ramp-halt-criteria evaluator tests.
 *
 * Covers each halt criterion (H-1 .. H-5), the §5.3 two-consecutive-runs
 * persistence requirement, the warn-vs-halt distinction, and the
 * halt_and_page escalation for v2 5xx.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateRampHaltCriteria,
  type HaltEvaluatorReading,
} from "@/trigger/lib/ramp-halt-evaluator";

function reading(
  name: string,
  status: HaltEvaluatorReading["status"],
  value?: Record<string, unknown>,
): HaltEvaluatorReading {
  return { sensorName: name, status, value, ts: new Date().toISOString() };
}

describe("evaluateRampHaltCriteria", () => {
  it("returns hold when nothing tripped", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [reading("inv.redis_postgres_drift", "healthy")],
      priorRunSpotCheckTriggered: null,
      spotCheckDriftMajorFraction: 0.01,
      shipstationV2_5xxRate: 0.005,
    });
    expect(r.action.kind).toBe("hold");
    expect(r.spotCheckTrippedThisRun).toBe(false);
  });

  it("H-1: halts on inv.redis_postgres_drift critical", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [reading("inv.redis_postgres_drift", "critical")],
      spotCheckDriftMajorFraction: null,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("halt");
    if (r.action.kind === "halt") {
      expect(r.action.trippedCriteria).toContain("H-1");
    }
  });

  it("H-2: halts on inv.propagation_lag critical", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [reading("inv.propagation_lag", "critical")],
      spotCheckDriftMajorFraction: null,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("halt");
    if (r.action.kind === "halt") {
      expect(r.action.trippedCriteria).toContain("H-2");
    }
  });

  it("H-3: warn-only on first spot-check trip (one run)", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: false,
      spotCheckDriftMajorFraction: 0.07,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("warn");
    expect(r.spotCheckTrippedThisRun).toBe(true);
  });

  it("H-3: halts on second consecutive spot-check trip (§5.3)", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: true,
      spotCheckDriftMajorFraction: 0.06,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("halt");
    if (r.action.kind === "halt") {
      expect(r.action.trippedCriteria).toContain("H-3");
    }
  });

  it("H-3: clears trip state when fraction returns to within threshold", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: true,
      spotCheckDriftMajorFraction: 0.02,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("hold");
    expect(r.spotCheckTrippedThisRun).toBe(false);
  });

  it("H-3: bucket flap (trip → recover → trip) does NOT halt", () => {
    const flap1 = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: false,
      spotCheckDriftMajorFraction: 0.08,
      shipstationV2_5xxRate: null,
    });
    expect(flap1.action.kind).toBe("warn");

    const recover = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: flap1.spotCheckTrippedThisRun,
      spotCheckDriftMajorFraction: 0.01,
      shipstationV2_5xxRate: null,
    });
    expect(recover.action.kind).toBe("hold");
    expect(recover.spotCheckTrippedThisRun).toBe(false);

    const flap2 = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: recover.spotCheckTrippedThisRun,
      spotCheckDriftMajorFraction: 0.08,
      shipstationV2_5xxRate: null,
    });
    expect(flap2.action.kind).toBe("warn");
  });

  it("H-3: at threshold boundary (5.00%) does NOT trip (must be > 5%)", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: true,
      spotCheckDriftMajorFraction: 0.05,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("hold");
    expect(r.spotCheckTrippedThisRun).toBe(false);
  });

  it("H-4: halt_and_page on shipstation v2 5xx > 2%", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      spotCheckDriftMajorFraction: null,
      shipstationV2_5xxRate: 0.025,
    });
    expect(r.action.kind).toBe("halt_and_page");
    if (r.action.kind === "halt_and_page") {
      expect(r.action.trippedCriteria).toContain("H-4");
    }
  });

  it("H-4: at threshold boundary (2.00%) does NOT trip", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      spotCheckDriftMajorFraction: null,
      shipstationV2_5xxRate: 0.02,
    });
    expect(r.action.kind).toBe("hold");
  });

  it("H-5: webhook silence is warn-only (does not halt)", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [reading("webhook.silence", "warning")],
      spotCheckDriftMajorFraction: 0.01,
      shipstationV2_5xxRate: 0.001,
    });
    expect(r.action.kind).toBe("warn");
    if (r.action.kind === "warn") {
      expect(r.action.sensors).toContain("H-5");
    }
  });

  it("multiple criteria: H-4 escalates whole result to halt_and_page", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [reading("inv.redis_postgres_drift", "critical")],
      priorRunSpotCheckTriggered: true,
      spotCheckDriftMajorFraction: 0.1,
      shipstationV2_5xxRate: 0.05,
    });
    expect(r.action.kind).toBe("halt_and_page");
    if (r.action.kind === "halt_and_page") {
      expect(r.action.trippedCriteria.sort()).toEqual(["H-1", "H-3", "H-4"]);
    }
  });

  it("findings array is always populated with all 5 criteria", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      spotCheckDriftMajorFraction: null,
      shipstationV2_5xxRate: null,
    });
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(["H-1", "H-2", "H-3", "H-4", "H-5"]);
  });

  it("null spot-check fraction is treated as no-data, not as 0", () => {
    const r = evaluateRampHaltCriteria({
      recentReadings: [],
      priorRunSpotCheckTriggered: true,
      spotCheckDriftMajorFraction: null,
      shipstationV2_5xxRate: null,
    });
    expect(r.action.kind).toBe("hold");
    expect(r.spotCheckTrippedThisRun).toBe(false);
    expect(r.findings.find((f) => f.id === "H-3")?.detail).toContain("no spot-check data");
  });
});
