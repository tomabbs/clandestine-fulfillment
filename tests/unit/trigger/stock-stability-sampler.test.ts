/**
 * Unit tests for the stock-stability-sampler Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md → §"stock-stability-sampler".
 *
 * These tests exercise the observable contract of the whole sampler
 * routine (emergency-pause gate, universe merge, upsert payload) using a
 * small structural fake of the Supabase client. Keeping it structural
 * (not generic `SupabaseClient<Database>`) lets the fake return real
 * Promises everywhere — Biome forbids `then`-on-object patterns and
 * real Promise returns side-step that rule while still modelling the
 * supabase-js "chain now, await later" API shape closely enough for our
 * assertions.
 */

import { describe, expect, it } from "vitest";
import {
  type RunStockStabilityReadingsPurgeOptions,
  type RunStockStabilitySamplerOptions,
  runStockStabilityReadingsPurge,
  runStockStabilitySampler,
} from "@/trigger/tasks/stock-stability-sampler";

type Rows = Record<string, unknown>[];

interface WorkspaceFixture {
  id: string;
  paused?: boolean;
  emergencyReadError?: string;
  identity?: Array<{ variant_id: string | null; outcome_state: string }>;
  identityReadError?: string;
  mappings?: Array<{ variant_id: string | null }>;
  mappingsReadError?: string;
  levels?: Array<{
    variant_id: string;
    available: number | null;
    committed_quantity: number | null;
  }>;
  levelsReadError?: string;
  upsertError?: string;
}

interface FakeState {
  workspaces: WorkspaceFixture[];
  workspacesReadError?: string;
  purgeDeleted?: number;
  purgeError?: string;
  lastPurgeCutoff?: string;
  insertedByWorkspace: Map<string, Rows>;
  insertCallsByWorkspace: Map<string, number>;
}

function makeFakeSupabase(state: FakeState): unknown {
  return {
    from(table: string) {
      if (table === "stock_stability_readings") {
        return {
          upsert(rows: Rows, _options: unknown) {
            // Record rows by workspace_id for payload-shape assertions.
            for (const row of rows) {
              const wsId = (row as { workspace_id?: string }).workspace_id ?? "__unknown__";
              const bucket = state.insertedByWorkspace.get(wsId) ?? [];
              bucket.push(row);
              state.insertedByWorkspace.set(wsId, bucket);
              state.insertCallsByWorkspace.set(
                wsId,
                (state.insertCallsByWorkspace.get(wsId) ?? 0) + 1,
              );
            }
            const firstWsId =
              (rows[0] as { workspace_id?: string } | undefined)?.workspace_id ?? "__unknown__";
            const ws = state.workspaces.find((w) => w.id === firstWsId);
            if (ws?.upsertError) {
              return Promise.resolve({ error: { message: ws.upsertError } });
            }
            return Promise.resolve({ error: null });
          },
          delete(_opts?: { count?: "exact" }) {
            return {
              lt: (_col: string, cutoff: string) => {
                state.lastPurgeCutoff = cutoff;
                if (state.purgeError) {
                  return Promise.resolve({ count: null, error: { message: state.purgeError } });
                }
                return Promise.resolve({ count: state.purgeDeleted ?? 0, error: null });
              },
            };
          },
        };
      }

      if (table === "workspaces") {
        return {
          select(cols: string) {
            // List-read path — sampler does `from("workspaces").select("id")` and awaits.
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
            // Emergency-pause read path — sampler does
            // `from("workspaces").select("sku_autonomous_emergency_paused")
            //    .eq("id", x).maybeSingle()`.
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
          select: (_cols: string) => ({
            eq: (_col: string, workspaceId: string) => ({
              in: (_col2: string, outcomeStates: string[]) => {
                const ws = state.workspaces.find((w) => w.id === workspaceId);
                if (ws?.identityReadError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: ws.identityReadError },
                  });
                }
                const rows = (ws?.identity ?? []).filter((r) =>
                  outcomeStates.includes(r.outcome_state),
                );
                return Promise.resolve({ data: rows, error: null });
              },
            }),
          }),
        };
      }

      if (table === "client_store_sku_mappings") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, workspaceId: string) => ({
              not: (_col2: string, _op: string, _val: unknown) => {
                const ws = state.workspaces.find((w) => w.id === workspaceId);
                if (ws?.mappingsReadError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: ws.mappingsReadError },
                  });
                }
                const rows = (ws?.mappings ?? []).filter((r) => r.variant_id !== null);
                return Promise.resolve({ data: rows, error: null });
              },
            }),
          }),
        };
      }

      if (table === "warehouse_inventory_levels") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, workspaceId: string) => ({
              in: (_col2: string, variantIds: string[]) => {
                const ws = state.workspaces.find((w) => w.id === workspaceId);
                if (ws?.levelsReadError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: ws.levelsReadError },
                  });
                }
                const rows = (ws?.levels ?? []).filter((r) => variantIds.includes(r.variant_id));
                return Promise.resolve({ data: rows, error: null });
              },
            }),
          }),
        };
      }

      throw new Error(`Unexpected table read in sampler fake: ${table}`);
    },
  };
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    workspaces: [],
    insertedByWorkspace: new Map(),
    insertCallsByWorkspace: new Map(),
    ...overrides,
  };
}

function runSampler(state: FakeState, now: Date) {
  const options: RunStockStabilitySamplerOptions = {
    supabase: makeFakeSupabase(state) as never,
    now,
  };
  return runStockStabilitySampler(options);
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe("runStockStabilitySampler", () => {
  const now = new Date("2026-04-26T14:37:23.000Z");
  const expectedBucket = "2026-04-26T14:30:00.000Z";

  it("floors observed_at to the 15-minute bucket in every written row", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          identity: [{ variant_id: "v-1", outcome_state: "client_stock_exception" }],
          levels: [{ variant_id: "v-1", available: 10, committed_quantity: 4 }],
        },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.bucket_observed_at).toBe(expectedBucket);
    expect(result.workspaces_sampled).toBe(1);
    expect(result.total_rows_attempted).toBe(1);
    expect(result.per_workspace[0]).toMatchObject({
      workspace_id: "ws-1",
      status: "ok",
      variants_sampled: 1,
    });

    const inserted = state.insertedByWorkspace.get("ws-1") ?? [];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      workspace_id: "ws-1",
      variant_id: "v-1",
      source: "warehouse",
      observed_at: expectedBucket,
      observed_at_local: expectedBucket,
      available: 10,
      committed: 4,
      atp: 6,
      remote_stock_listed: null,
      clock_skew_ms: null,
      sampler_run_id: `sampler:${expectedBucket}`,
    });
  });

  it("emergency-paused workspace makes zero DB writes", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-paused",
          paused: true,
          identity: [{ variant_id: "v-1", outcome_state: "client_stock_exception" }],
          levels: [{ variant_id: "v-1", available: 10, committed_quantity: 4 }],
        },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.workspaces_sampled).toBe(0);
    expect(result.total_rows_attempted).toBe(0);
    expect(result.per_workspace[0]).toMatchObject({
      workspace_id: "ws-paused",
      status: "emergency_paused",
    });
    expect(state.insertedByWorkspace.get("ws-paused") ?? []).toEqual([]);
    expect(state.insertCallsByWorkspace.get("ws-paused") ?? 0).toBe(0);
  });

  it("emergency-pause READ failure also skips writes (fail-closed)", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-err",
          emergencyReadError: "boom",
          identity: [{ variant_id: "v-1", outcome_state: "client_stock_exception" }],
          levels: [{ variant_id: "v-1", available: 10, committed_quantity: 4 }],
        },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.workspaces_sampled).toBe(0);
    expect(result.per_workspace[0]).toMatchObject({
      status: "emergency_paused",
      error: "boom",
    });
    expect(state.insertCallsByWorkspace.get("ws-err") ?? 0).toBe(0);
  });

  it("merges identity + mappings universes and dedupes", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-merge",
          identity: [
            { variant_id: "v-1", outcome_state: "client_stock_exception" },
            { variant_id: "v-2", outcome_state: "auto_shadow_identity_match" },
            { variant_id: "v-3", outcome_state: "auto_reject_non_match" },
          ],
          mappings: [{ variant_id: "v-2" }, { variant_id: "v-4" }, { variant_id: null }],
          levels: [
            { variant_id: "v-1", available: 10, committed_quantity: 2 },
            { variant_id: "v-2", available: 5, committed_quantity: 0 },
            { variant_id: "v-4", available: 0, committed_quantity: 0 },
          ],
        },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.workspaces_sampled).toBe(1);
    expect(result.total_rows_attempted).toBe(3);

    const inserted = state.insertedByWorkspace.get("ws-merge") ?? [];
    const variantIds = inserted.map((r) => (r as { variant_id: string }).variant_id).sort();
    expect(variantIds).toEqual(["v-1", "v-2", "v-4"]);
  });

  it("returns empty_universe when a workspace has no identity + no mappings", async () => {
    const state = freshState({ workspaces: [{ id: "ws-empty" }] });
    const result = await runSampler(state, now);

    expect(result.workspaces_sampled).toBe(0);
    expect(result.per_workspace[0]).toMatchObject({
      status: "empty_universe",
      variants_sampled: 0,
    });
    expect(state.insertCallsByWorkspace.get("ws-empty") ?? 0).toBe(0);
  });

  it("records levels_read_failed when warehouse_inventory_levels read errors", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-err",
          identity: [{ variant_id: "v-1", outcome_state: "client_stock_exception" }],
          levelsReadError: "db down",
        },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.per_workspace[0]).toMatchObject({
      status: "levels_read_failed",
      error: "db down",
    });
    expect(state.insertCallsByWorkspace.get("ws-err") ?? 0).toBe(0);
  });

  it("records universe_read_failed on identity read error", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-err", identityReadError: "identity table unavailable" }],
    });

    const result = await runSampler(state, now);

    expect(result.per_workspace[0]).toMatchObject({
      status: "universe_read_failed",
      error: "identity table unavailable",
    });
  });

  it("handles many workspaces independently (one failure doesn't halt others)", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-a",
          paused: true,
          identity: [{ variant_id: "v-a", outcome_state: "client_stock_exception" }],
        },
        {
          id: "ws-b",
          identity: [{ variant_id: "v-b", outcome_state: "auto_shadow_identity_match" }],
          levels: [{ variant_id: "v-b", available: 2, committed_quantity: 0 }],
        },
        { id: "ws-c", identityReadError: "oops" },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.workspaces_scanned).toBe(3);
    expect(result.workspaces_sampled).toBe(1);
    expect(result.per_workspace.map((r) => r.status)).toEqual([
      "emergency_paused",
      "ok",
      "universe_read_failed",
    ]);
    expect(state.insertedByWorkspace.get("ws-b")?.length).toBe(1);
    expect(state.insertCallsByWorkspace.get("ws-a") ?? 0).toBe(0);
    expect(state.insertCallsByWorkspace.get("ws-c") ?? 0).toBe(0);
  });

  it("bails cleanly when the workspaces list read itself fails", async () => {
    const state = freshState({ workspacesReadError: "auth bad" });
    const result = await runSampler(state, now);
    expect(result.workspaces_scanned).toBe(0);
    expect(result.workspaces_sampled).toBe(0);
    expect(result.per_workspace).toEqual([]);
  });

  it("same bucket twice writes identical observed_at (idempotency precondition)", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          identity: [{ variant_id: "v-1", outcome_state: "client_stock_exception" }],
          levels: [{ variant_id: "v-1", available: 10, committed_quantity: 4 }],
        },
      ],
    });

    const t1 = new Date("2026-04-26T14:30:00Z");
    const t2 = new Date("2026-04-26T14:44:59Z");

    const r1 = await runSampler(state, t1);
    const r2 = await runSampler(state, t2);

    expect(r1.bucket_observed_at).toBe(r2.bucket_observed_at);
    expect(r1.sampler_run_id).toBe(r2.sampler_run_id);

    const inserted = state.insertedByWorkspace.get("ws-1") ?? [];
    expect(inserted.map((r) => (r as { observed_at: string }).observed_at)).toEqual([
      "2026-04-26T14:30:00.000Z",
      "2026-04-26T14:30:00.000Z",
    ]);
  });

  it("insert error is surfaced on the per-workspace result", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-ins-err",
          identity: [{ variant_id: "v-1", outcome_state: "client_stock_exception" }],
          levels: [{ variant_id: "v-1", available: 10, committed_quantity: 4 }],
          upsertError: "conflict resolver died",
        },
      ],
    });

    const result = await runSampler(state, now);

    expect(result.per_workspace[0]).toMatchObject({
      status: "insert_failed",
      error: "conflict resolver died",
      rows_attempted: 1,
    });
    expect(result.workspaces_sampled).toBe(0);
  });
});

describe("runStockStabilityReadingsPurge", () => {
  it("issues a DELETE with the 30-day retention cutoff by default", async () => {
    const state = freshState({ purgeDeleted: 42 });
    const now = new Date("2026-04-26T00:00:00Z");

    const options: RunStockStabilityReadingsPurgeOptions = {
      supabase: makeFakeSupabase(state) as never,
      now,
    };

    const result = await runStockStabilityReadingsPurge(options);

    expect(result.deleted).toBe(42);
    expect(result.cutoff).toBe("2026-03-27T00:00:00.000Z");
    expect(state.lastPurgeCutoff).toBe("2026-03-27T00:00:00.000Z");
  });

  it("respects a custom retention window", async () => {
    const state = freshState({ purgeDeleted: 3 });
    const now = new Date("2026-04-26T00:00:00Z");

    const result = await runStockStabilityReadingsPurge({
      supabase: makeFakeSupabase(state) as never,
      now,
      retentionDays: 7,
    });

    expect(result.cutoff).toBe("2026-04-19T00:00:00.000Z");
    expect(state.lastPurgeCutoff).toBe("2026-04-19T00:00:00.000Z");
    expect(result.deleted).toBe(3);
  });

  it("surfaces DELETE errors without crashing", async () => {
    const state = freshState({ purgeError: "permission denied" });
    const now = new Date("2026-04-26T00:00:00Z");

    const result = await runStockStabilityReadingsPurge({
      supabase: makeFakeSupabase(state) as never,
      now,
    });

    expect(result.deleted).toBe(0);
    expect(result.error).toBe("permission denied");
  });
});
