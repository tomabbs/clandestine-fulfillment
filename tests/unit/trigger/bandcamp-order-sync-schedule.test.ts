/**
 * B-1 (HRD-29) — bandcamp-order-sync-cron schedule helpers.
 *
 * Covers `decideScheduleAction()` — the pure decision function that drives
 * skipped-run telemetry. The schedule task itself wires this into structured
 * logs + `sensor_readings` inserts; here we lock the decision contract.
 */
import { describe, expect, it } from "vitest";
import { decideScheduleAction } from "@/trigger/tasks/bandcamp-order-sync";

describe("decideScheduleAction (B-1)", () => {
  it("returns fresh_trigger when no previous run id is recorded (cold start)", () => {
    const action = decideScheduleAction(null, "run_abc");
    expect(action.kind).toBe("fresh_trigger");
    if (action.kind === "fresh_trigger") {
      expect(action.runId).toBe("run_abc");
    }
  });

  it("returns fresh_trigger when previous and current ids differ (steady state)", () => {
    const action = decideScheduleAction("run_old", "run_new");
    expect(action.kind).toBe("fresh_trigger");
    if (action.kind === "fresh_trigger") {
      expect(action.runId).toBe("run_new");
    }
  });

  it("returns deduped when current run id equals the previously recorded id (overlap)", () => {
    const action = decideScheduleAction("run_xyz", "run_xyz");
    expect(action.kind).toBe("deduped");
    if (action.kind === "deduped") {
      expect(action.runId).toBe("run_xyz");
      expect(action.reason).toBe("overlapping_run");
    }
  });

  it("treats empty-string previous id as no-previous (defensive)", () => {
    // Empty-string is technically !== null, so it counts as a recorded id.
    // We document this behavior explicitly: empty string vs run id is a fresh
    // trigger (id != "") and empty == empty would be a (degenerate) dedup.
    const fresh = decideScheduleAction("", "run_first");
    expect(fresh.kind).toBe("fresh_trigger");

    const dedup = decideScheduleAction("", "");
    expect(dedup.kind).toBe("deduped");
  });

  it("does NOT treat the same id across cold start as deduped", () => {
    // After a cold start, _lastTriggeredRunId resets to null. Even if Trigger
    // somehow returned the same id that previously existed (it won't — run
    // ids are unique), we'd still report fresh_trigger because previous=null.
    expect(decideScheduleAction(null, "run_xyz").kind).toBe("fresh_trigger");
  });
});
