/**
 * Unit tests for the `sku-autonomous-telemetry` Trigger task
 * (Phase 7.B).
 *
 * The summarizer's behavior is pinned by
 * `tests/unit/lib/server/sku-autonomous-telemetry.test.ts`. These
 * tests exercise the ORCHESTRATOR contract around it:
 *
 *   - sensor_readings is written on every workspace (including
 *     paused ones) — observability is non-negotiable.
 *   - warehouse_review_queue upserts fire per reason code, keyed
 *     by ISO-week group_key, with the right severity and title.
 *   - Emergency pause suppresses review-queue writes but not the
 *     sensor write.
 *   - Every per-fetch error produces a typed failure mode without
 *     taking down the pass.
 *   - Multi-workspace iteration continues past a single failed
 *     workspace.
 *   - The `workspaceIds` filter override short-circuits the
 *     workspaces read.
 *   - Decisions pagination correctly accumulates across pages.
 *   - `isoWeekKey` handles the ISO-8601 edge cases
 *     (late-December / early-January year-crossing).
 */

import { describe, expect, it, vi } from "vitest";
import { isoWeekKey, runSkuAutonomousTelemetry } from "@/trigger/tasks/sku-autonomous-telemetry";

// ─────────────────────────────────────────────────────────────────────
// Fixtures + helpers
// ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface WorkspaceFixture {
  id: string;
  paused?: boolean;
  emergencyReadError?: string;
  runsReadError?: string;
  decisionsReadError?: string;
  transitionsReadError?: string;
  holdEventsReadError?: string;
  identityCountsReadError?: string;
  runs?: Row[];
  decisions?: Row[];
  transitions?: Row[];
  holdEvents?: Row[];
  identityCounts?: {
    auto_database_identity_match?: number;
    client_stock_exception?: number;
    auto_holdout_for_evidence?: number;
  };
}

interface FakeState {
  workspaces: WorkspaceFixture[];
  workspacesReadError?: string;
  sensorWriteError?: string;
  // Observable side-effects:
  sensorInserts: Row[];
  reviewUpserts: Array<{ row: Row; onConflict: string | undefined }>;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    workspaces: [],
    sensorInserts: [],
    reviewUpserts: [],
    ...overrides,
  };
}

/**
 * Minimal structural Supabase fake. Supports just the query shapes
 * exercised by `runSkuAutonomousTelemetry`. Every builder method
 * returns a thenable so `await`-ing at any point resolves with the
 * configured payload.
 */
function makeFakeSupabase(state: FakeState): unknown {
  const ws = (wid: string) => state.workspaces.find((w) => w.id === wid);

  return {
    from(table: string) {
      // ── workspaces ────────────────────────────────────────────────
      if (table === "workspaces") {
        return {
          select(cols: string) {
            // Full-list read for workspaceIds.
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
                return {
                  maybeSingle: () => {
                    const w = ws(value);
                    if (w?.emergencyReadError) {
                      return Promise.resolve({
                        data: null,
                        error: { message: w.emergencyReadError },
                      });
                    }
                    if (!w) {
                      return Promise.resolve({ data: null, error: null });
                    }
                    return Promise.resolve({
                      data: { sku_autonomous_emergency_paused: w.paused === true },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }

      // ── sku_autonomous_runs ───────────────────────────────────────
      if (table === "sku_autonomous_runs") {
        let workspaceId = "";
        const builder = {
          select(_cols: string) {
            return this;
          },
          eq(col: string, value: string) {
            if (col === "workspace_id") workspaceId = value;
            return this;
          },
          gte(_col: string, _value: string) {
            return this;
          },
          order(_col: string, _opts: unknown) {
            return this;
          },
          limit(_n: number) {
            const w = ws(workspaceId);
            if (w?.runsReadError) {
              return Promise.resolve({ data: null, error: { message: w.runsReadError } });
            }
            return Promise.resolve({ data: w?.runs ?? [], error: null });
          },
        };
        return builder;
      }

      // ── sku_autonomous_decisions (paginated via .range) ───────────
      if (table === "sku_autonomous_decisions") {
        let workspaceId = "";
        let runIdsFilter: string[] = [];
        const builder = {
          select(_cols: string) {
            return this;
          },
          eq(col: string, value: string) {
            if (col === "workspace_id") workspaceId = value;
            return this;
          },
          in(_col: string, values: string[]) {
            runIdsFilter = values;
            return this;
          },
          range(start: number, end: number) {
            const w = ws(workspaceId);
            if (w?.decisionsReadError) {
              return Promise.resolve({
                data: null,
                error: { message: w.decisionsReadError },
              });
            }
            const all = (w?.decisions ?? []).filter((d) =>
              runIdsFilter.includes(d.run_id as string),
            );
            const page = all.slice(start, end + 1);
            return Promise.resolve({ data: page, error: null });
          },
        };
        return builder;
      }

      // ── sku_outcome_transitions ───────────────────────────────────
      if (table === "sku_outcome_transitions") {
        let workspaceId = "";
        const builder = {
          select(_cols: string) {
            return this;
          },
          eq(col: string, value: string) {
            if (col === "workspace_id") workspaceId = value;
            return this;
          },
          gte(_col: string, _value: string) {
            return this;
          },
          order(_col: string, _opts: unknown) {
            return this;
          },
          limit(_n: number) {
            const w = ws(workspaceId);
            if (w?.transitionsReadError) {
              return Promise.resolve({
                data: null,
                error: { message: w.transitionsReadError },
              });
            }
            return Promise.resolve({ data: w?.transitions ?? [], error: null });
          },
        };
        return builder;
      }

      // ── order_fulfillment_hold_events ─────────────────────────────
      if (table === "order_fulfillment_hold_events") {
        let workspaceId = "";
        const builder = {
          select(_cols: string) {
            return this;
          },
          eq(col: string, value: string) {
            if (col === "workspace_id") workspaceId = value;
            return this;
          },
          gte(_col: string, _value: string) {
            return this;
          },
          order(_col: string, _opts: unknown) {
            return this;
          },
          limit(_n: number) {
            const w = ws(workspaceId);
            if (w?.holdEventsReadError) {
              return Promise.resolve({
                data: null,
                error: { message: w.holdEventsReadError },
              });
            }
            return Promise.resolve({ data: w?.holdEvents ?? [], error: null });
          },
        };
        return builder;
      }

      // ── client_store_product_identity_matches (count queries) ────
      if (table === "client_store_product_identity_matches") {
        let workspaceId = "";
        let outcomeState = "";
        const builder = {
          select(_cols: string, _opts: unknown) {
            return this;
          },
          eq(col: string, value: string | boolean) {
            if (col === "workspace_id") workspaceId = value as string;
            if (col === "outcome_state") outcomeState = value as string;
            return this;
          },
        };
        // The final .eq('is_active', true) must resolve a promise,
        // so we override the last .eq to be thenable with the
        // count result.
        const firstEq = builder.eq.bind(builder);
        let eqCount = 0;
        builder.eq = ((col: string, value: string | boolean) => {
          eqCount += 1;
          firstEq(col, value);
          if (eqCount < 3) return builder;
          // Third .eq resolves.
          const w = ws(workspaceId);
          if (w?.identityCountsReadError) {
            return Promise.resolve({
              data: null,
              count: null,
              error: { message: w.identityCountsReadError },
            });
          }
          const countMap = w?.identityCounts ?? {};
          const count =
            outcomeState === "auto_database_identity_match"
              ? (countMap.auto_database_identity_match ?? 0)
              : outcomeState === "client_stock_exception"
                ? (countMap.client_stock_exception ?? 0)
                : outcomeState === "auto_holdout_for_evidence"
                  ? (countMap.auto_holdout_for_evidence ?? 0)
                  : 0;
          return Promise.resolve({ data: null, count, error: null });
        }) as typeof builder.eq;
        return builder;
      }

      // ── sensor_readings (insert) ──────────────────────────────────
      if (table === "sensor_readings") {
        return {
          insert(row: Row) {
            if (state.sensorWriteError) {
              return Promise.resolve({ error: { message: state.sensorWriteError } });
            }
            state.sensorInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }

      // ── warehouse_review_queue (upsert) ───────────────────────────
      if (table === "warehouse_review_queue") {
        return {
          upsert(row: Row, opts: { onConflict?: string } = {}) {
            state.reviewUpserts.push({ row, onConflict: opts.onConflict });
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`Unhandled table in test fake: ${table}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Row factories
// ─────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-04-20T12:00:00Z");

function runRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    status: "completed",
    dry_run: false,
    started_at: "2026-04-15T00:00:00Z",
    completed_at: "2026-04-15T00:10:00Z",
    variants_evaluated: 50,
    trigger_source: "scheduled_periodic",
    ...overrides,
  };
}

function decisionRow(runId: string, overrides: Partial<Row> = {}): Row {
  return {
    run_id: runId,
    outcome_state: "auto_live_inventory_alias",
    outcome_changed: false,
    ...overrides,
  };
}

function transitionRow(overrides: Partial<Row> = {}): Row {
  return {
    from_state: null,
    to_state: "auto_live_inventory_alias",
    trigger: "scheduled_periodic",
    reason_code: "path_a",
    triggered_at: "2026-04-15T00:00:00Z",
    ...overrides,
  };
}

function holdEventRow(overrides: Partial<Row> = {}): Row {
  return {
    event_type: "hold_applied",
    hold_cycle_id: `cycle-${Math.random().toString(36).slice(2, 8)}`,
    created_at: "2026-04-15T00:00:00Z",
    resolution_code: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("runSkuAutonomousTelemetry — happy path", () => {
  it("writes one healthy sensor row and zero review items for a clean workspace", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-a" }],
    });
    const supabase = makeFakeSupabase(state) as ReturnType<typeof makeFakeSupabase> as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });

    expect(result.workspaces_scanned).toBe(1);
    expect(result.workspaces_ok).toBe(1);
    expect(result.workspaces_errored).toBe(0);
    expect(result.total_review_items_upserted).toBe(0);
    expect(state.sensorInserts).toHaveLength(1);
    expect(state.sensorInserts[0]).toMatchObject({
      workspace_id: "ws-a",
      sensor_name: "sku_autonomous.telemetry",
      status: "healthy",
    });
    expect(state.reviewUpserts).toHaveLength(0);
  });

  it("emits warning sensor + review upserts per reason when thresholds trip", async () => {
    // Construct a workspace that trips BOTH
    // run_failure_rate_above_threshold AND decision_audit_incomplete:
    //   - r1 is a completed non-dry-run with NO decisions → audit
    //     expected 1 / got 0 → completeness trip.
    //   - r2, r3 are failed → failure rate 2/3 > 10% → trip.
    const state = freshState({
      workspaces: [
        {
          id: "ws-trip",
          runs: [
            runRow({ id: "r1" }),
            runRow({ id: "r2", status: "failed" }),
            runRow({ id: "r3", status: "failed" }),
          ],
          // Intentionally no decisions for r1 → audit incomplete.
          decisions: [],
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });

    expect(result.workspaces_ok).toBe(1);
    const wr = result.per_workspace[0];
    expect(wr.reasons).toEqual(
      expect.arrayContaining(["run_failure_rate_above_threshold", "decision_audit_incomplete"]),
    );
    expect(state.sensorInserts[0]).toMatchObject({
      status: "warning",
      sensor_name: "sku_autonomous.telemetry",
    });
    // Review upserts: exactly one per reason, with the right group_key shape.
    expect(state.reviewUpserts.length).toBe(wr.reasons.length);
    for (const up of state.reviewUpserts) {
      expect(up.onConflict).toBe("group_key");
      expect(up.row.category).toBe("sku_autonomous_telemetry");
      expect(up.row.status).toBe("open");
      expect(String(up.row.group_key)).toMatch(
        /^sku-autonomous-telemetry:[a-z_]+:ws-trip:\d{4}-W\d{2}$/,
      );
    }
    // Audit-incomplete is `high` severity; failure rate is `high`.
    const auditItem = state.reviewUpserts.find((u) =>
      String(u.row.group_key).includes("decision_audit_incomplete"),
    );
    expect(auditItem?.row.severity).toBe("high");
  });
});

describe("runSkuAutonomousTelemetry — emergency pause semantics", () => {
  it("writes a paused sensor row and SKIPS review upserts when the workspace is paused", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-paused",
          paused: true,
          // Same threshold trip as above — but paused state should
          // suppress the review queue writes entirely.
          runs: [runRow({ id: "f", status: "failed" })],
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.workspaces_emergency_paused).toBe(1);
    expect(result.workspaces_ok).toBe(0);
    expect(state.sensorInserts).toHaveLength(1);
    expect(state.sensorInserts[0]).toMatchObject({
      status: "paused",
      workspace_id: "ws-paused",
    });
    expect(state.sensorInserts[0].value).toMatchObject({
      emergency_paused: true,
    });
    expect(state.reviewUpserts).toHaveLength(0);
  });

  it("records pause_read_failed and writes no sensor row when the pause read errors", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-pr-err", emergencyReadError: "connection timeout" }],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.workspaces_errored).toBe(1);
    expect(result.per_workspace[0].status).toBe("pause_read_failed");
    expect(result.per_workspace[0].detail).toContain("connection timeout");
    expect(state.sensorInserts).toHaveLength(0);
    expect(state.reviewUpserts).toHaveLength(0);
  });
});

describe("runSkuAutonomousTelemetry — per-fetch failure modes", () => {
  it("records runs_read_failed and stops before writing anything", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-runs-err", runsReadError: "relation missing" }],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.per_workspace[0].status).toBe("runs_read_failed");
    expect(result.per_workspace[0].detail).toContain("relation missing");
    expect(state.sensorInserts).toHaveLength(0);
  });

  it("records transitions_read_failed", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-t-err",
          runs: [runRow({ id: "r1" })],
          decisions: [decisionRow("r1")],
          transitionsReadError: "boom",
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.per_workspace[0].status).toBe("transitions_read_failed");
    expect(state.sensorInserts).toHaveLength(0);
  });

  it("records hold_events_read_failed", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-h-err",
          runs: [runRow({ id: "r1" })],
          decisions: [decisionRow("r1")],
          holdEventsReadError: "boom",
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.per_workspace[0].status).toBe("hold_events_read_failed");
  });

  it("records identity_counts_read_failed", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-ic-err",
          runs: [runRow({ id: "r1" })],
          decisions: [decisionRow("r1")],
          identityCountsReadError: "missing permission",
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.per_workspace[0].status).toBe("identity_counts_read_failed");
  });

  it("records sensor_write_failed when the sensor insert errors", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-sw-err" }],
      sensorWriteError: "primary key conflict",
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.per_workspace[0].status).toBe("sensor_write_failed");
    expect(result.per_workspace[0].detail).toContain("primary key conflict");
  });
});

describe("runSkuAutonomousTelemetry — multi-workspace iteration", () => {
  it("continues past a failing workspace and processes healthy ones", async () => {
    const state = freshState({
      workspaces: [
        { id: "ws-bad", emergencyReadError: "down" },
        { id: "ws-good" },
        { id: "ws-paused", paused: true },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.workspaces_scanned).toBe(3);
    expect(result.workspaces_ok).toBe(1);
    expect(result.workspaces_emergency_paused).toBe(1);
    expect(result.workspaces_errored).toBe(1);

    // Sensor writes: 1 for ws-good, 1 for ws-paused. None for ws-bad.
    expect(state.sensorInserts.map((r) => r.workspace_id).sort()).toEqual(["ws-good", "ws-paused"]);
  });
});

describe("runSkuAutonomousTelemetry — filtering + payloads", () => {
  it("respects the workspaceIds override and skips the workspaces read", async () => {
    const state = freshState({
      workspacesReadError: "should-not-be-hit",
      workspaces: [{ id: "ws-explicit" }],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({
      supabase,
      now: NOW,
      workspaceIds: ["ws-explicit"],
    });
    expect(result.workspaces_scanned).toBe(1);
    expect(result.workspaces_ok).toBe(1);
  });

  it("deduplicates duplicate workspaceIds in the filter", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-a" }],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({
      supabase,
      now: NOW,
      workspaceIds: ["ws-a", "ws-a", "ws-a"],
    });
    expect(result.workspaces_scanned).toBe(1);
    expect(state.sensorInserts).toHaveLength(1);
  });

  it("echoes windowDays, identity_counts, and emergency_paused in the sensor value", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-echo",
          identityCounts: {
            auto_database_identity_match: 100,
            client_stock_exception: 20,
            auto_holdout_for_evidence: 5,
          },
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    await runSkuAutonomousTelemetry({ supabase, now: NOW, windowDays: 14 });

    const value = state.sensorInserts[0].value as {
      window_days: number;
      identity_counts: {
        shadow_candidates: number;
        stock_exception: number;
        holdout: number;
      };
      emergency_paused: boolean;
    };
    expect(value.window_days).toBe(14);
    expect(value.identity_counts).toEqual({
      shadow_candidates: 100,
      stock_exception: 20,
      holdout: 5,
    });
    expect(value.emergency_paused).toBe(false);
  });
});

describe("runSkuAutonomousTelemetry — decisions pagination", () => {
  it("accumulates decisions across multiple pages", async () => {
    // 1_000-per-page ceiling inside the task; two runs, one with
    // many decisions, the other with one decision. We should see
    // audit completeness = 100% since BOTH runs have ≥1 decision.
    const runs = [runRow({ id: "big" }), runRow({ id: "small" })];
    const bigDecisions = Array.from({ length: 1_500 }, () => decisionRow("big"));
    const smallDecisions = [decisionRow("small")];

    const state = freshState({
      workspaces: [
        {
          id: "ws-pg",
          runs,
          decisions: [...bigDecisions, ...smallDecisions],
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.per_workspace[0].reasons).not.toContain("decision_audit_incomplete");
    expect(state.sensorInserts[0].status).toBe("healthy");
  });
});

describe("runSkuAutonomousTelemetry — end-to-end with all tables populated", () => {
  it("threads transitions + hold events + decisions through the summarizer and into the sensor row", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-full",
          runs: [runRow({ id: "run-a" }), runRow({ id: "run-b" })],
          decisions: [decisionRow("run-a"), decisionRow("run-b")],
          transitions: [
            transitionRow({
              from_state: "auto_database_identity_match",
              to_state: "auto_live_inventory_alias",
              trigger: "periodic_revaluation",
              reason_code: "path_a_promoted",
            }),
            transitionRow({
              from_state: "auto_live_inventory_alias",
              to_state: "client_stock_exception",
              trigger: "stock_change",
              reason_code: "stock_depleted_post_alias",
            }),
          ],
          holdEvents: [
            holdEventRow({ event_type: "hold_applied", hold_cycle_id: "c1" }),
            holdEventRow({
              event_type: "hold_released",
              hold_cycle_id: "c1",
              resolution_code: "fetch_recovered_evaluator_passed",
            }),
            holdEventRow({ event_type: "hold_applied", hold_cycle_id: "c2" }),
          ],
          identityCounts: {
            auto_database_identity_match: 40,
            client_stock_exception: 10,
            auto_holdout_for_evidence: 2,
          },
        },
      ],
    });
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.workspaces_ok).toBe(1);
    expect(state.sensorInserts).toHaveLength(1);
    const sensorValue = state.sensorInserts[0].value as {
      summary: {
        promotionsInWindow: number;
        demotionsInWindow: number;
        holdsAppliedCycles: number;
        holdsReleasedCycles: number;
      };
      identity_counts: { shadow_candidates: number; stock_exception: number };
    };
    expect(sensorValue.summary.promotionsInWindow).toBe(1);
    expect(sensorValue.summary.demotionsInWindow).toBe(1);
    expect(sensorValue.summary.holdsAppliedCycles).toBe(2);
    expect(sensorValue.summary.holdsReleasedCycles).toBe(1);
    expect(sensorValue.identity_counts.shadow_candidates).toBe(40);
  });
});

describe("runSkuAutonomousTelemetry — no-workspaces edge case", () => {
  it("returns a zero-length summary when there are no workspaces", async () => {
    const state = freshState({});
    const supabase = makeFakeSupabase(state) as Parameters<
      typeof runSkuAutonomousTelemetry
    >[0] extends infer O
      ? O extends { supabase?: infer S }
        ? S
        : never
      : never;

    const result = await runSkuAutonomousTelemetry({ supabase, now: NOW });
    expect(result.workspaces_scanned).toBe(0);
    expect(result.per_workspace).toHaveLength(0);
    expect(state.sensorInserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isoWeekKey — exported from the task; a few ISO-8601 edge cases
// ─────────────────────────────────────────────────────────────────────

describe("isoWeekKey", () => {
  it("returns YYYY-Www for a normal mid-year date", () => {
    expect(isoWeekKey(new Date("2026-04-20T00:00:00Z"))).toBe("2026-W17");
  });

  it("treats Monday as the start of the week", () => {
    // 2026-04-20 is a Monday; 2026-04-26 is a Sunday. Same ISO week.
    expect(isoWeekKey(new Date("2026-04-20T00:00:00Z"))).toBe("2026-W17");
    expect(isoWeekKey(new Date("2026-04-26T23:59:59Z"))).toBe("2026-W17");
    // 2026-04-27 (Monday) is the NEXT week.
    expect(isoWeekKey(new Date("2026-04-27T00:00:00Z"))).toBe("2026-W18");
  });

  it("rolls late December dates into the following ISO year when applicable", () => {
    // 2025-12-29 is a Monday; ISO week is 2026-W01 even though the
    // calendar year is still 2025.
    expect(isoWeekKey(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
  });

  it("rolls early-January dates into the previous ISO year when applicable", () => {
    // 2027-01-01 is a Friday; ISO week is 2026-W53 (yes, 2026 has 53
    // ISO weeks because its Jan-1 is a Thursday).
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  it("zero-pads single-digit weeks", () => {
    expect(isoWeekKey(new Date("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });
});

// Silence warn logger noise in test output.
vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});
