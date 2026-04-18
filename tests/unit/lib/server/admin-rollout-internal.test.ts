/**
 * Phase 6 — setFanoutRolloutPercentInternal tests.
 *
 * Verifies:
 *  - Input validation (range, integer)
 *  - Audit row shape per actor type (staff / sensor / script)
 *  - sensor_run is set ONLY for actor.kind === "sensor"
 *  - Append (not overwrite) of audit JSONB
 *  - Workspace-not-found and write-error returns success=false (no throw)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
const eqUpdateMock = vi.fn();
const singleMock = vi.fn();
const eqSelectMock = vi.fn(() => ({ single: singleMock }));
const selectMock = vi.fn(() => ({ eq: eqSelectMock }));
const fromMock = vi.fn((_table: string) => ({
  select: selectMock,
  update: updateMock,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: fromMock }),
}));

import {
  type RolloutActor,
  setFanoutRolloutPercentInternal,
} from "@/lib/server/admin-rollout-internal";

beforeEach(() => {
  fromMock.mockClear();
  selectMock.mockClear();
  eqSelectMock.mockClear();
  singleMock.mockReset();
  updateMock.mockReset();
  eqUpdateMock.mockReset();

  updateMock.mockImplementation(() => ({ eq: eqUpdateMock }));
  eqUpdateMock.mockResolvedValue({ error: null });
});

const STAFF_ACTOR: RolloutActor = { kind: "staff", userId: "user-1" };
const SENSOR_ACTOR: RolloutActor = { kind: "sensor", sensorRun: "run_abc" };
const SCRIPT_ACTOR: RolloutActor = { kind: "script", scriptName: "rollback.ts" };

describe("setFanoutRolloutPercentInternal", () => {
  it("rejects non-integer percent", async () => {
    const r = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 12.5,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/integer 0..100/);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-range percent", async () => {
    const r1 = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: -1,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    const r2 = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 101,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

  it("returns success=false (not throw) when workspace not found", async () => {
    singleMock.mockResolvedValue({ data: null, error: { message: "no rows" } });
    const r = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-missing",
      percent: 50,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("workspace lookup failed");
  });

  it("appends to existing audit (does not overwrite)", async () => {
    const existing = [
      {
        ts: "2026-04-13T10:00:00Z",
        percent_before: 0,
        percent_after: 10,
        reason: "ramp 0→10",
        actor: { kind: "staff", userId: "u-old" },
      },
    ];
    singleMock.mockResolvedValue({
      data: { fanout_rollout_percent: 10, fanout_rollout_audit: existing },
      error: null,
    });

    const r = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 50,
      reason: "ramp 10→50",
      actor: STAFF_ACTOR,
    });
    expect(r.success).toBe(true);
    expect(r.percentBefore).toBe(10);
    expect(r.percentAfter).toBe(50);

    const updateCall = updateMock.mock.calls[0][0];
    expect(updateCall.fanout_rollout_percent).toBe(50);
    expect(updateCall.fanout_rollout_audit).toHaveLength(2);
    expect(updateCall.fanout_rollout_audit[0]).toEqual(existing[0]);
    expect(updateCall.fanout_rollout_audit[1].reason).toBe("ramp 10→50");
  });

  it("sets sensor_run only for actor.kind === sensor", async () => {
    singleMock.mockResolvedValue({
      data: { fanout_rollout_percent: 100, fanout_rollout_audit: [] },
      error: null,
    });

    const sensorRes = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 0,
      reason: "auto-halt",
      actor: SENSOR_ACTOR,
    });
    expect(sensorRes.auditEntry.sensor_run).toBe("run_abc");

    const staffRes = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 50,
      reason: "ramp",
      actor: STAFF_ACTOR,
    });
    expect(staffRes.auditEntry.sensor_run).toBeUndefined();

    const scriptRes = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 25,
      reason: "rollback script",
      actor: SCRIPT_ACTOR,
    });
    expect(scriptRes.auditEntry.sensor_run).toBeUndefined();
  });

  it("handles non-array existing audit gracefully (treats as empty)", async () => {
    singleMock.mockResolvedValue({
      data: { fanout_rollout_percent: 50, fanout_rollout_audit: null },
      error: null,
    });
    const r = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 100,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    expect(r.success).toBe(true);
    const updateCall = updateMock.mock.calls[0][0];
    expect(updateCall.fanout_rollout_audit).toHaveLength(1);
  });

  it("returns success=false on update error", async () => {
    singleMock.mockResolvedValue({
      data: { fanout_rollout_percent: 0, fanout_rollout_audit: [] },
      error: null,
    });
    eqUpdateMock.mockResolvedValueOnce({ error: { message: "boom" } });
    const r = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 10,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("boom");
  });

  it("audit entry timestamp is ISO 8601", async () => {
    singleMock.mockResolvedValue({
      data: { fanout_rollout_percent: 0, fanout_rollout_audit: [] },
      error: null,
    });
    const r = await setFanoutRolloutPercentInternal({
      workspaceId: "ws-1",
      percent: 10,
      reason: "test",
      actor: STAFF_ACTOR,
    });
    expect(r.auditEntry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
