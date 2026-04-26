/**
 * Unit tests for the sku-shadow-promotion Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Shadow-to-live promotion criteria" +
 *       §"sku-shadow-promotion" rollout (Phase 7).
 *
 * These tests exercise the observable contract of the whole
 * workspace-level routine using a small structural Supabase fake
 * plus a fake `promoter` override so we never round-trip through the
 * real `promoteIdentityMatchToAlias()`. Pure evaluator edge cases
 * live in `tests/unit/lib/server/sku-shadow-promotion-policy.test.ts`.
 *
 * Coverage:
 *   * Path A promotion with verified Bandcamp option evidence.
 *   * Path B promotion after the 14-day stability window with ≥5 decisions.
 *   * Bump path when no Path A evidence AND Path B age gate fails.
 *   * Promotion-blocked path → bump written + count incremented.
 *   * Per-workspace emergency pause short-circuit.
 *   * Candidate read error recorded.
 *   * Run open failure recorded.
 *   * Multi-workspace iteration.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  PromoteIdentityMatchResult,
  PromoteIdentityMatchToAliasInput,
  PromotionSupabaseClient,
} from "@/lib/server/sku-alias-promotion";
import {
  type RunSkuShadowPromotionOptions,
  runSkuShadowPromotion,
} from "@/trigger/tasks/sku-shadow-promotion";

type Rows = Record<string, unknown>[];

interface CandidateFixture {
  id: string;
  connection_id: string;
  variant_id: string;
  state_version: number;
  evaluation_count: number;
  created_at: string;
  warehouse_stock_at_match: number;
  evidence_snapshot: Record<string, unknown>;
  /** COUNT(*) of prior auto_database_identity_match decisions returned for this row. */
  prior_decision_count?: number;
}

interface WorkspaceFixture {
  id: string;
  paused?: boolean;
  emergencyReadError?: string;
  candidatesReadError?: string;
  runOpenError?: string;
  candidates?: CandidateFixture[];
  warehouseLevels?: Record<
    string,
    { available: number | null; committed_quantity: number | null } | null
  >;
  stabilityHistory?: Record<string, Array<{ observed_at: string; available: number | null }>>;
}

interface FakeState {
  workspaces: WorkspaceFixture[];
  workspacesReadError?: string;
  // Observable side-effects:
  decisionRowsByWorkspace: Map<string, Rows>;
  identityUpdatesByRow: Map<string, Rows>;
  runsOpenedByWorkspace: Map<string, Rows>;
  runsClosedByRunId: Map<string, Rows>;
  // Issued by the fake when a run is opened.
  nextRunId: number;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    workspaces: [],
    decisionRowsByWorkspace: new Map(),
    identityUpdatesByRow: new Map(),
    runsOpenedByWorkspace: new Map(),
    runsClosedByRunId: new Map(),
    nextRunId: 1,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Structural fake of the supabase-js client surface this task uses.
// ─────────────────────────────────────────────────────────────────────

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
            // Emergency-pause probe.
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
                    if (!ws) {
                      return Promise.resolve({ data: null, error: null });
                    }
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
            // Candidate query chain: .eq × 3 → .gt → .order → .limit (awaited).
            const chain = {
              _workspaceId: "",
              eq(col: string, val: unknown) {
                if (col === "workspace_id") chain._workspaceId = val as string;
                return chain;
              },
              gt(_col: string, _val: unknown) {
                return chain;
              },
              order(_col: string, _opts: unknown) {
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
                const rows = (ws?.candidates ?? []).map((c) => ({
                  id: c.id,
                  workspace_id: ws?.id,
                  connection_id: c.connection_id,
                  variant_id: c.variant_id,
                  outcome_state: "auto_database_identity_match",
                  state_version: c.state_version,
                  evaluation_count: c.evaluation_count,
                  evidence_snapshot: c.evidence_snapshot,
                  warehouse_stock_at_match: c.warehouse_stock_at_match,
                  created_at: c.created_at,
                  is_active: true,
                }));
                return Promise.resolve({ data: rows, error: null });
              },
            };
            return chain;
          },
          // Identity-row OCC update path.
          update(payload: Record<string, unknown>) {
            return {
              eq(col1: string, val1: string) {
                return {
                  eq(_col2: string, _val2: number) {
                    const id = col1 === "id" ? val1 : "";
                    const bucket = state.identityUpdatesByRow.get(id) ?? [];
                    bucket.push(payload);
                    state.identityUpdatesByRow.set(id, bucket);
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "sku_autonomous_runs") {
        return {
          insert(rows: Rows) {
            return {
              select(_cols: string) {
                return {
                  single: () => {
                    const payload = rows[0] as { workspace_id: string };
                    const ws = state.workspaces.find((w) => w.id === payload.workspace_id);
                    if (ws?.runOpenError) {
                      return Promise.resolve({
                        data: null,
                        error: { message: ws.runOpenError },
                      });
                    }
                    const id = `run-${state.nextRunId++}`;
                    const bucket = state.runsOpenedByWorkspace.get(payload.workspace_id) ?? [];
                    bucket.push({ ...payload, id });
                    state.runsOpenedByWorkspace.set(payload.workspace_id, bucket);
                    return Promise.resolve({ data: { id }, error: null });
                  },
                };
              },
            };
          },
          update(payload: Record<string, unknown>) {
            return {
              eq(_col: string, runId: string) {
                const bucket = state.runsClosedByRunId.get(runId) ?? [];
                bucket.push(payload);
                state.runsClosedByRunId.set(runId, bucket);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }

      if (table === "sku_autonomous_decisions") {
        return {
          insert(rows: Rows) {
            for (const row of rows) {
              const wsId = (row as { workspace_id?: string }).workspace_id ?? "__unknown__";
              const bucket = state.decisionRowsByWorkspace.get(wsId) ?? [];
              bucket.push(row);
              state.decisionRowsByWorkspace.set(wsId, bucket);
            }
            return Promise.resolve({ error: null });
          },
          // Prior-decision count head query.
          select(_cols: string, opts?: { count?: string; head?: boolean }) {
            if (opts?.head === true) {
              // The task awaits after the 2nd .eq() call — wrap via a
              // proxy that returns a Promise on the final .eq call.
              const makeFinalEq = (identityMatchId: string) => (_c: string, _v: string) => {
                const ws = state.workspaces.find((w) =>
                  (w.candidates ?? []).some((c) => c.id === identityMatchId),
                );
                const candidate = ws?.candidates?.find((c) => c.id === identityMatchId);
                const count = candidate?.prior_decision_count ?? 0;
                return Promise.resolve({ count, error: null });
              };
              return {
                eq(col: string, val: string) {
                  const matchId = col === "identity_match_id" ? val : "";
                  return { eq: makeFinalEq(matchId) };
                },
              };
            }
            return { eq: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) };
          },
        };
      }

      if (table === "warehouse_inventory_levels") {
        return {
          select(_cols: string) {
            return {
              eq(_col: string, variantId: string) {
                return {
                  maybeSingle: () => {
                    const allLevels = Object.assign(
                      {},
                      ...state.workspaces.map((w) => w.warehouseLevels ?? {}),
                    ) as Record<
                      string,
                      { available: number | null; committed_quantity: number | null } | null
                    >;
                    const row = allLevels[variantId] ?? null;
                    return Promise.resolve({ data: row, error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "stock_stability_readings") {
        return {
          select(_cols: string) {
            const chain = {
              _workspaceId: "",
              _variantId: "",
              eq(col: string, val: string) {
                if (col === "workspace_id") chain._workspaceId = val;
                if (col === "variant_id") chain._variantId = val;
                return chain;
              },
              order(_col: string, _opts: unknown) {
                return chain;
              },
              limit(_n: number) {
                const ws = state.workspaces.find((w) => w.id === chain._workspaceId);
                const readings = ws?.stabilityHistory?.[chain._variantId] ?? [];
                return Promise.resolve({ data: readings, error: null });
              },
            };
            return chain;
          },
        };
      }

      throw new Error(`Unexpected table read in shadow-promotion fake: ${table}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeStablyZeroHistory(
  now: Date,
  value: number,
): Array<{ observed_at: string; available: number | null }> {
  return Array.from({ length: 24 }, (_, i) => ({
    observed_at: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000).toISOString(),
    available: value,
  }));
}

function makePromoter(
  response: PromoteIdentityMatchResult,
  spy: ((input: PromoteIdentityMatchToAliasInput) => void) | null = null,
): (
  supabase: PromotionSupabaseClient,
  input: PromoteIdentityMatchToAliasInput,
) => Promise<PromoteIdentityMatchResult> {
  return async (_supabase, input) => {
    spy?.(input);
    return response;
  };
}

function runTask(state: FakeState, now: Date, promoter: RunSkuShadowPromotionOptions["promoter"]) {
  return runSkuShadowPromotion({
    supabase: makeFakeSupabase(state) as never,
    now,
    promoter,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-01T12:00:00Z");

describe("runSkuShadowPromotion — promotion paths", () => {
  it("Path A: verified Bandcamp option → promoter called, no bump decision", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 5,
              evaluation_count: 2,
              created_at: "2026-04-28T00:00:00Z",
              warehouse_stock_at_match: 10,
              evidence_snapshot: {
                identity: { verifiedBandcampOption: true },
              },
              prior_decision_count: 2,
            },
          ],
          warehouseLevels: { "var-1": { available: 10, committed_quantity: 2 } },
          stabilityHistory: { "var-1": makeStablyZeroHistory(NOW, 8) },
        },
      ],
    });

    const promoterSpy = vi.fn();
    const promoter = makePromoter(
      { ok: true, aliasId: "alias-1", decisionId: "dec-1" },
      promoterSpy,
    );

    const result = await runTask(state, NOW, promoter);

    expect(result.total_candidates_evaluated).toBe(1);
    expect(result.total_promoted).toBe(1);
    expect(result.total_bumped).toBe(0);
    expect(result.total_promotion_blocked).toBe(0);
    expect(promoterSpy).toHaveBeenCalledOnce();

    const input = promoterSpy.mock.calls[0][0] as PromoteIdentityMatchToAliasInput;
    expect(input).toMatchObject({
      path: "A",
      reasonCode: "verified_bandcamp_option",
      identityMatchId: "im-1",
      expectedStateVersion: 5,
      triggeredBy: "sku-shadow-promotion",
      variantId: "var-1",
      previousOutcomeState: "auto_database_identity_match",
    });
    expect(input.stockEvidence?.signal.value).toBe(8);
    expect(input.stockEvidence?.signal.source).toBe("warehouse_inventory_levels");

    // Promoter path writes its own decision row; our task does NOT
    // write a bump decision when promotion succeeds.
    expect(state.decisionRowsByWorkspace.get("ws-1") ?? []).toEqual([]);
  });

  it("Path B: age ≥ 14d and decision count ≥ 5 → promoter called with shadow_stability_window_passed", async () => {
    const createdAt = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 12,
              evaluation_count: 6,
              created_at: createdAt,
              warehouse_stock_at_match: 5,
              evidence_snapshot: {},
              prior_decision_count: 7,
            },
          ],
          warehouseLevels: { "var-1": { available: 5, committed_quantity: 0 } },
          stabilityHistory: { "var-1": makeStablyZeroHistory(NOW, 5) },
        },
      ],
    });

    const spy = vi.fn();
    const promoter = makePromoter({ ok: true, aliasId: "alias-2", decisionId: "dec-2" }, spy);

    const result = await runTask(state, NOW, promoter);

    expect(result.total_promoted).toBe(1);
    expect(result.total_bumped).toBe(0);
    const input = spy.mock.calls[0][0] as PromoteIdentityMatchToAliasInput;
    expect(input).toMatchObject({
      path: "B",
      reasonCode: "shadow_stability_window_passed",
      expectedStateVersion: 12,
    });
  });
});

describe("runSkuShadowPromotion — bump path", () => {
  it("No Path A evidence + age < 14d → bump written, state_version incremented, promoter not called", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 3,
              evaluation_count: 1,
              created_at: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
              warehouse_stock_at_match: 5,
              evidence_snapshot: {},
              prior_decision_count: 1,
            },
          ],
          warehouseLevels: { "var-1": { available: 5, committed_quantity: 0 } },
          stabilityHistory: { "var-1": makeStablyZeroHistory(NOW, 5) },
        },
      ],
    });

    const spy = vi.fn();
    const promoter = makePromoter({ ok: true, aliasId: "alias-x", decisionId: "dec-x" }, spy);

    const result = await runTask(state, NOW, promoter);

    expect(result.total_bumped).toBe(1);
    expect(result.total_promoted).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    // Identity-row OCC bump happened against the expected state_version.
    const updates = state.identityUpdatesByRow.get("im-1") ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      evaluation_count: 2,
      state_version: 4,
    });

    // A decision row with disqualifiers was persisted.
    const decisions = state.decisionRowsByWorkspace.get("ws-1") ?? [];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome_state: "auto_database_identity_match",
      previous_outcome_state: "auto_database_identity_match",
      outcome_changed: false,
      reason_code: null,
      identity_match_id: "im-1",
    });
    const dqs = (decisions[0] as { disqualifiers: string[] }).disqualifiers;
    expect(dqs.length).toBeGreaterThan(0);
  });
});

describe("runSkuShadowPromotion — promotion blocked", () => {
  it("Path A eligible but promoter returns stock_unstable → bump written and promotion_blocked counted", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 9,
              evaluation_count: 4,
              created_at: "2026-04-25T00:00:00Z",
              warehouse_stock_at_match: 10,
              evidence_snapshot: {
                identity: { exactBarcode: true },
              },
              prior_decision_count: 3,
            },
          ],
          warehouseLevels: { "var-1": { available: 10, committed_quantity: 0 } },
          stabilityHistory: { "var-1": makeStablyZeroHistory(NOW, 10) },
        },
      ],
    });

    const promoter = makePromoter({ ok: false, reason: "stock_unstable" });
    const result = await runTask(state, NOW, promoter);

    expect(result.total_promoted).toBe(0);
    expect(result.total_promotion_blocked).toBe(1);
    expect(result.total_bumped).toBe(0);

    const decisions = state.decisionRowsByWorkspace.get("ws-1") ?? [];
    expect(decisions).toHaveLength(1);
    const dqs = (decisions[0] as { disqualifiers: string[] }).disqualifiers;
    expect(dqs).toContain("promotion_blocked_stock_unstable");

    // Identity row was also bumped so the next cycle can retry.
    const updates = state.identityUpdatesByRow.get("im-1") ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ state_version: 10 });
  });
});

describe("runSkuShadowPromotion — workspace gates", () => {
  it("Emergency-paused workspace is skipped entirely (no run opened)", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-paused",
          paused: true,
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 3,
              evaluation_count: 1,
              created_at: "2026-04-15T00:00:00Z",
              warehouse_stock_at_match: 5,
              evidence_snapshot: { identity: { verifiedBandcampOption: true } },
              prior_decision_count: 5,
            },
          ],
        },
      ],
    });

    const spy = vi.fn();
    const promoter = makePromoter({ ok: true, aliasId: "a", decisionId: "d" }, spy);

    const result = await runTask(state, NOW, promoter);

    expect(result.per_workspace[0]).toMatchObject({
      workspace_id: "ws-paused",
      status: "emergency_paused",
      candidates_evaluated: 0,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(state.runsOpenedByWorkspace.get("ws-paused") ?? []).toEqual([]);
  });

  it("Emergency-pause READ failure skips the workspace (fail-closed)", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-boom", emergencyReadError: "db connection refused" }],
    });

    const promoter = makePromoter({ ok: true, aliasId: "a", decisionId: "d" });
    const result = await runTask(state, NOW, promoter);

    expect(result.per_workspace[0]).toMatchObject({
      status: "pause_read_failed",
      detail: "db connection refused",
    });
    expect(state.runsOpenedByWorkspace.size).toBe(0);
  });

  it("Candidates read failure is recorded and the run is not opened", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-1", candidatesReadError: "relation missing" }],
    });

    const result = await runTask(state, NOW, makePromoter({ ok: false, reason: "rpc_error" }));

    expect(result.per_workspace[0]).toMatchObject({
      status: "candidates_read_failed",
      detail: "relation missing",
    });
    expect(state.runsOpenedByWorkspace.size).toBe(0);
  });

  it("Run open failure is recorded and no candidates are evaluated", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          runOpenError: "insert violates check",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 1,
              evaluation_count: 0,
              created_at: "2026-04-29T00:00:00Z",
              warehouse_stock_at_match: 5,
              evidence_snapshot: { identity: { verifiedBandcampOption: true } },
              prior_decision_count: 1,
            },
          ],
        },
      ],
    });

    const spy = vi.fn();
    const promoter = makePromoter({ ok: true, aliasId: "a", decisionId: "d" }, spy);

    const result = await runTask(state, NOW, promoter);

    expect(result.per_workspace[0]).toMatchObject({ status: "run_open_failed" });
    expect(spy).not.toHaveBeenCalled();
    expect(state.decisionRowsByWorkspace.get("ws-1") ?? []).toEqual([]);
  });

  it("Workspaces-list read failure returns empty result without throwing", async () => {
    const state = freshState({ workspacesReadError: "cold pool" });
    const result = await runTask(
      state,
      NOW,
      makePromoter({ ok: true, aliasId: "a", decisionId: "d" }),
    );
    expect(result.workspaces_scanned).toBe(0);
    expect(result.per_workspace).toEqual([]);
  });

  it("Iterates multiple workspaces; mixed outcomes across them", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-A",
          candidates: [
            {
              id: "im-A",
              connection_id: "conn-A",
              variant_id: "var-A",
              state_version: 4,
              evaluation_count: 1,
              created_at: "2026-04-29T00:00:00Z",
              warehouse_stock_at_match: 5,
              evidence_snapshot: { identity: { verifiedBandcampOption: true } },
              prior_decision_count: 1,
            },
          ],
          warehouseLevels: { "var-A": { available: 5, committed_quantity: 0 } },
          stabilityHistory: { "var-A": makeStablyZeroHistory(NOW, 5) },
        },
        {
          id: "ws-B",
          paused: true,
        },
        {
          id: "ws-C",
          candidates: [
            {
              id: "im-C",
              connection_id: "conn-C",
              variant_id: "var-C",
              state_version: 2,
              evaluation_count: 0,
              created_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
              warehouse_stock_at_match: 5,
              evidence_snapshot: {},
              prior_decision_count: 0,
            },
          ],
          warehouseLevels: { "var-C": { available: 5, committed_quantity: 0 } },
          stabilityHistory: { "var-C": makeStablyZeroHistory(NOW, 5) },
        },
      ],
    });

    const promoter = makePromoter({ ok: true, aliasId: "alias-A", decisionId: "dec-A" });
    const result = await runTask(state, NOW, promoter);

    expect(result.workspaces_scanned).toBe(3);
    expect(result.total_promoted).toBe(1);
    expect(result.total_bumped).toBe(1);
    expect(result.per_workspace.find((w) => w.workspace_id === "ws-B")?.status).toBe(
      "emergency_paused",
    );
  });
});

describe("runSkuShadowPromotion — Path A evidence derivation", () => {
  it("exactBarcode → promotes on Path A with reason 'exact_barcode_match'", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 3,
              evaluation_count: 0,
              created_at: "2026-04-30T00:00:00Z",
              warehouse_stock_at_match: 5,
              evidence_snapshot: { identity: { exactBarcode: true } },
              prior_decision_count: 0,
            },
          ],
          warehouseLevels: { "var-1": { available: 5, committed_quantity: 0 } },
          stabilityHistory: { "var-1": makeStablyZeroHistory(NOW, 5) },
        },
      ],
    });

    const spy = vi.fn();
    const promoter = makePromoter({ ok: true, aliasId: "a", decisionId: "d" }, spy);
    await runTask(state, NOW, promoter);
    expect((spy.mock.calls[0][0] as PromoteIdentityMatchToAliasInput).reasonCode).toBe(
      "exact_barcode_match",
    );
  });

  it("exactSku without exactSkuSafe → no Path A promotion (bump)", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          candidates: [
            {
              id: "im-1",
              connection_id: "conn-1",
              variant_id: "var-1",
              state_version: 3,
              evaluation_count: 0,
              created_at: "2026-04-30T00:00:00Z",
              warehouse_stock_at_match: 5,
              evidence_snapshot: { identity: { exactSku: true, exactSkuSafe: false } },
              prior_decision_count: 0,
            },
          ],
          warehouseLevels: { "var-1": { available: 5, committed_quantity: 0 } },
          stabilityHistory: { "var-1": makeStablyZeroHistory(NOW, 5) },
        },
      ],
    });

    const spy = vi.fn();
    const promoter = makePromoter({ ok: true, aliasId: "a", decisionId: "d" }, spy);
    const result = await runTask(state, NOW, promoter);
    expect(result.total_bumped).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
