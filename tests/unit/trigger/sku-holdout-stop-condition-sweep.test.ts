/**
 * Unit tests for the sku-holdout-stop-condition-sweep Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"sku-holdout-stop-condition-sweep".
 *
 * Coverage:
 *   * Age-based retirement: age_days >= 90 → reason
 *     `holdout_expired_90_days`.
 *   * Evaluation-count retirement: evaluation_count >= 10 →
 *     `holdout_expired_10_evaluations`.
 *   * Both conditions: age wins (harder guarantee).
 *   * Row selected by the `.or()` filter but neither cap met (defense
 *     in depth) → `skipped_not_stuck`, no transition call.
 *   * Transition RPC failure: error counted, outcome surfaced.
 *   * Per-workspace emergency pause short-circuits (no candidate
 *     read, no transition call).
 *   * Pause read error fails closed.
 *   * Candidate read error recorded as workspace-level error.
 *   * Run open failure surfaces; no transitions called.
 *   * Correct trigger + expected_state_version passed to the RPC.
 *   * workspaces list read failure does not throw.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ApplyOutcomeTransitionCallInput,
  ApplyOutcomeTransitionResult,
} from "@/lib/server/sku-outcome-transitions";
import { runSkuHoldoutStopConditionSweep } from "@/trigger/tasks/sku-holdout-stop-condition-sweep";

interface IdentityRowFixture {
  id: string;
  workspace_id: string;
  org_id: string;
  connection_id: string;
  variant_id: string | null;
  state_version: number;
  evaluation_count: number;
  created_at: string;
  evidence_snapshot: Record<string, unknown>;
  outcome_state: "auto_holdout_for_evidence";
  is_active: boolean;
}

interface WorkspaceFixture {
  id: string;
  paused?: boolean;
  emergencyReadError?: string;
  candidatesReadError?: string;
  candidates?: IdentityRowFixture[];
  runOpenFails?: boolean;
}

interface FakeState {
  workspaces: WorkspaceFixture[];
  workspacesReadError?: string;
  orFilterObserved?: string;
  insertedRuns: Array<Record<string, unknown>>;
  insertedDecisions: Array<Record<string, unknown>>;
  updatedRuns: Array<{ id: string; patch: Record<string, unknown> }>;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    workspaces: [],
    insertedRuns: [],
    insertedDecisions: [],
    updatedRuns: [],
    ...overrides,
  };
}

function makeFakeSupabase(state: FakeState): unknown {
  return {
    from(table: string) {
      if (table === "workspaces") {
        return {
          select(cols: string) {
            if (cols === "id") {
              if (state.workspacesReadError) {
                return Promise.resolve({
                  data: null,
                  error: { message: state.workspacesReadError },
                });
              }
              return Promise.resolve({
                data: state.workspaces.map((w) => ({ id: w.id })),
                error: null,
              });
            }
            return {
              eq(_col: string, value: string) {
                const ws = state.workspaces.find((w) => w.id === value);
                return {
                  maybeSingle: () => {
                    if (ws?.emergencyReadError) {
                      return Promise.resolve({
                        data: null,
                        error: { message: ws.emergencyReadError },
                      });
                    }
                    if (!ws) return Promise.resolve({ data: null, error: null });
                    return Promise.resolve({
                      data: { sku_autonomous_emergency_paused: ws.paused === true },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "client_store_product_identity_matches") {
        return {
          select(_cols: string) {
            const chain = {
              _workspaceId: "",
              eq(col: string, val: string | boolean) {
                if (col === "workspace_id") chain._workspaceId = val as string;
                return chain;
              },
              or(filter: string) {
                state.orFilterObserved = filter;
                return chain;
              },
              order(_c: string, _o: unknown) {
                return chain;
              },
              limit(_n: number) {
                const ws = state.workspaces.find((w) => w.id === chain._workspaceId);
                if (ws?.candidatesReadError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: ws.candidatesReadError },
                  });
                }
                return Promise.resolve({ data: ws?.candidates ?? [], error: null });
              },
            };
            return chain;
          },
        };
      }

      if (table === "sku_autonomous_runs") {
        return {
          insert(rows: Array<Record<string, unknown>>) {
            state.insertedRuns.push(rows[0]);
            return {
              select(_c: string) {
                return {
                  single: () => {
                    const wsId = rows[0].workspace_id as string;
                    const ws = state.workspaces.find((w) => w.id === wsId);
                    if (ws?.runOpenFails) {
                      return Promise.resolve({
                        data: null,
                        error: { message: "run open boom" },
                      });
                    }
                    return Promise.resolve({
                      data: { id: `run-${wsId}` },
                      error: null,
                    });
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq(_c: string, id: string) {
                state.updatedRuns.push({ id, patch });
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }

      if (table === "sku_autonomous_decisions") {
        return {
          insert(rows: Array<Record<string, unknown>>) {
            for (const row of rows) state.insertedDecisions.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      throw new Error(`Unexpected table read in holdout-sweep fake: ${table}`);
    },
  };
}

const NOW = new Date("2026-05-01T00:00:00.000Z");

function row(overrides: Partial<IdentityRowFixture> = {}): IdentityRowFixture {
  return {
    id: "id-1",
    workspace_id: "ws-1",
    org_id: "org-1",
    connection_id: "conn-1",
    variant_id: "v-1",
    state_version: 3,
    evaluation_count: 1,
    created_at: "2026-04-28T00:00:00.000Z",
    evidence_snapshot: { seed: true },
    outcome_state: "auto_holdout_for_evidence",
    is_active: true,
    ...overrides,
  };
}

function makeTransitionStub(
  response:
    | ApplyOutcomeTransitionResult
    | ((input: ApplyOutcomeTransitionCallInput) => ApplyOutcomeTransitionResult),
  spy?: (input: ApplyOutcomeTransitionCallInput) => void,
) {
  return (async (_supabase, input) => {
    spy?.(input);
    return typeof response === "function" ? response(input) : response;
  }) as typeof import("@/lib/server/sku-outcome-transitions").applyOutcomeTransition;
}

// ─────────────────────────────────────────────────────────────────────
// Retirement outcomes
// ─────────────────────────────────────────────────────────────────────

describe("runSkuHoldoutStopConditionSweep — age-based retirement", () => {
  it("retires rows older than 90 days with reason holdout_expired_90_days", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            row({
              id: "old-1",
              created_at: new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString(),
              evaluation_count: 2,
            }),
          ],
        },
      ],
    });

    const transitionSpy = vi.fn();
    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub(
        { ok: true, newStateVersion: 4, transitionId: "t-1" },
        transitionSpy,
      ),
    });

    expect(result.total_retired).toBe(1);
    expect(result.per_workspace[0].retired_age).toBe(1);
    expect(result.per_workspace[0].retired_evaluations).toBe(0);
    expect(transitionSpy).toHaveBeenCalledOnce();

    const input = transitionSpy.mock.calls[0][0] as ApplyOutcomeTransitionCallInput;
    expect(input.from).toBe("auto_holdout_for_evidence");
    expect(input.to).toBe("auto_reject_non_match");
    expect(input.trigger).toBe("periodic_revaluation");
    expect(input.reasonCode).toBe("holdout_expired_90_days");
    expect(input.expectedStateVersion).toBe(3);
  });
});

describe("runSkuHoldoutStopConditionSweep — evaluation-count retirement", () => {
  it("retires rows with evaluation_count >= 10 but age < 90", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            row({
              id: "busy-1",
              created_at: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
              evaluation_count: 12,
            }),
          ],
        },
      ],
    });

    const transitionSpy = vi.fn();
    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub(
        { ok: true, newStateVersion: 4, transitionId: "t-2" },
        transitionSpy,
      ),
    });

    expect(result.per_workspace[0].retired_evaluations).toBe(1);
    expect(result.per_workspace[0].retired_age).toBe(0);
    const input = transitionSpy.mock.calls[0][0] as ApplyOutcomeTransitionCallInput;
    expect(input.reasonCode).toBe("holdout_expired_10_evaluations");
  });

  it("prefers age-based reason when BOTH conditions are true", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            row({
              id: "both-1",
              created_at: new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString(),
              evaluation_count: 25,
            }),
          ],
        },
      ],
    });

    const transitionSpy = vi.fn();
    await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub(
        { ok: true, newStateVersion: 4, transitionId: "t-3" },
        transitionSpy,
      ),
    });

    const input = transitionSpy.mock.calls[0][0] as ApplyOutcomeTransitionCallInput;
    expect(input.reasonCode).toBe("holdout_expired_90_days");
  });
});

describe("runSkuHoldoutStopConditionSweep — defensive filtering", () => {
  it("skips a row that slipped through .or() but meets neither cap", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            row({
              id: "ghost-1",
              created_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
              evaluation_count: 4,
            }),
          ],
        },
      ],
    });

    const transitionSpy = vi.fn();
    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub(
        { ok: true, newStateVersion: 4, transitionId: "t-4" },
        transitionSpy,
      ),
    });

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(result.per_workspace[0].skipped).toBe(1);
    expect(result.per_workspace[0].per_candidate[0].outcome).toBe("skipped_not_stuck");
    expect(result.total_retired).toBe(0);
  });
});

describe("runSkuHoldoutStopConditionSweep — transition failure", () => {
  it("counts failure, records decision with disqualifier", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            row({
              id: "stale-1",
              created_at: new Date(NOW.getTime() - 150 * 24 * 60 * 60 * 1000).toISOString(),
              evaluation_count: 3,
            }),
          ],
        },
      ],
    });

    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub({
        ok: false,
        reason: "stale_state_version",
        detail: "got 2 expected 3",
      }),
    });

    expect(result.per_workspace[0].errors).toBe(1);
    expect(result.per_workspace[0].retired_age).toBe(0);
    expect(result.per_workspace[0].per_candidate[0]).toMatchObject({
      outcome: "transition_failed",
      reason_code: "holdout_expired_90_days",
    });

    expect(state.insertedDecisions).toHaveLength(1);
    expect(state.insertedDecisions[0]).toMatchObject({
      outcome_changed: false,
      disqualifiers: ["stale_state_version"],
      outcome_state: "auto_holdout_for_evidence",
      previous_outcome_state: "auto_holdout_for_evidence",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Workspace gates + errors
// ─────────────────────────────────────────────────────────────────────

describe("runSkuHoldoutStopConditionSweep — workspace gates", () => {
  it("emergency-paused workspace is skipped; no candidate read or transition", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-paused",
          paused: true,
          candidates: [row({ id: "old-x", evaluation_count: 50 })],
        },
      ],
    });

    const transitionSpy = vi.fn();
    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub(
        { ok: true, newStateVersion: 4, transitionId: "t" },
        transitionSpy,
      ),
    });

    expect(result.per_workspace[0].status).toBe("emergency_paused");
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(state.orFilterObserved).toBeUndefined();
    expect(state.insertedRuns).toHaveLength(0);
  });

  it("pause read error fails closed", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-1", emergencyReadError: "pg down" }],
    });

    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub({ ok: true, newStateVersion: 4, transitionId: "t" }),
    });

    expect(result.per_workspace[0]).toMatchObject({
      status: "pause_read_failed",
      detail: "pg down",
    });
  });

  it("candidate read error surfaces as workspace-level failure", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-1", candidatesReadError: "relation missing" }],
    });

    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub({ ok: true, newStateVersion: 4, transitionId: "t" }),
    });

    expect(result.per_workspace[0]).toMatchObject({
      status: "candidates_read_failed",
      detail: "relation missing",
    });
    expect(state.insertedRuns).toHaveLength(0);
  });

  it("workspaces-list read failure returns empty result", async () => {
    const state = freshState({ workspacesReadError: "pool exhausted" });
    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub({ ok: true, newStateVersion: 4, transitionId: "t" }),
    });

    expect(result.workspaces_scanned).toBe(0);
    expect(result.per_workspace).toEqual([]);
  });

  it("run open failure prevents any transition calls", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          runOpenFails: true,
          candidates: [
            row({
              id: "old-1",
              created_at: new Date(NOW.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString(),
            }),
          ],
        },
      ],
    });

    const transitionSpy = vi.fn();
    const result = await runSkuHoldoutStopConditionSweep({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      transition: makeTransitionStub(
        { ok: true, newStateVersion: 4, transitionId: "t" },
        transitionSpy,
      ),
    });

    expect(result.per_workspace[0].status).toBe("run_open_failed");
    expect(transitionSpy).not.toHaveBeenCalled();
  });
});
