/**
 * Unit tests for the sku-hold-recovery-recheck Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"sku-hold-recovery-recheck".
 *
 * Coverage:
 *   * Happy path: fresh fetch succeeds + evaluator returns
 *     should_hold=false → releaser invoked with
 *     resolution_code='fetch_recovered_evaluator_passed'.
 *   * Fetch failure: hold retained, release NOT called.
 *   * Evaluator still says hold: release NOT called.
 *   * Loader failure: counted as error, release NOT called.
 *   * Connection row missing: counted as error.
 *   * Release RPC failure: status surfaces the failure reason.
 *   * Per-workspace emergency pause short-circuits the workspace.
 *   * Pause-read error fails closed.
 *   * Orders read error recorded; no per-order work done.
 *   * Cutoff: only orders within the last 24h are queried (assert
 *     ISO format of the .gte threshold).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedClientStoreOrder } from "@/lib/server/normalized-order";
import type { LoadNormalizedOrderResult } from "@/lib/server/normalized-order-loader";
import type { EvaluateOrderForHoldResult } from "@/lib/server/order-hold-evaluator";
import type {
  ReleaseOrderFulfillmentHoldInput,
  ReleaseOrderFulfillmentHoldResult,
} from "@/lib/server/order-hold-rpcs";
import type { RemoteCatalogResult } from "@/lib/server/sku-matching";
import { runSkuHoldRecoveryRecheck } from "@/trigger/tasks/sku-hold-recovery-recheck";

interface HeldOrderFixture {
  id: string;
  source: "shopify" | "woocommerce" | "squarespace";
  fulfillment_hold_at: string;
}

interface WorkspaceFixture {
  id: string;
  paused?: boolean;
  emergencyReadError?: string;
  ordersReadError?: string;
  orders?: HeldOrderFixture[];
  connection?: { id: string } & Record<string, unknown>;
  connectionMissing?: boolean;
}

interface FakeState {
  workspaces: WorkspaceFixture[];
  workspacesReadError?: string;
  observedHoldQuery: { cutoffIso?: string; workspaceId?: string; limit?: number };
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    workspaces: [],
    observedHoldQuery: {},
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

      if (table === "warehouse_orders") {
        return {
          select(_cols: string) {
            const chain = {
              _workspaceId: "",
              eq(col: string, val: string) {
                if (col === "workspace_id") chain._workspaceId = val;
                return chain;
              },
              gte(_col: string, cutoff: string) {
                state.observedHoldQuery.cutoffIso = cutoff;
                state.observedHoldQuery.workspaceId = chain._workspaceId;
                return chain;
              },
              order(_c: string, _o: unknown) {
                return chain;
              },
              limit(n: number) {
                state.observedHoldQuery.limit = n;
                const ws = state.workspaces.find((w) => w.id === chain._workspaceId);
                if (ws?.ordersReadError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: ws.ordersReadError },
                  });
                }
                return Promise.resolve({ data: ws?.orders ?? [], error: null });
              },
            };
            return chain;
          },
        };
      }

      if (table === "client_store_connections") {
        return {
          select(_cols: string) {
            return {
              eq(_c: string, val: string) {
                return {
                  maybeSingle: () => {
                    const ws = state.workspaces.find((w) => w.connection?.id === val);
                    if (ws?.connectionMissing) {
                      return Promise.resolve({ data: null, error: null });
                    }
                    if (ws?.connection) {
                      return Promise.resolve({ data: ws.connection, error: null });
                    }
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table read in recovery fake: ${table}`);
    },
  };
}

function makeNormalizedOrder(orderId: string, connectionId: string): NormalizedClientStoreOrder {
  return {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId,
    platform: "shopify",
    remoteOrderId: `ext-${orderId}`,
    source: "recovery",
    lines: [
      {
        remoteSku: "SKU-1",
        remoteProductId: null,
        remoteVariantId: null,
        quantity: 1,
        title: "T1",
        warehouseOrderItemId: null,
      },
    ],
    warehouseOrderId: orderId,
    orderCreatedAt: "2026-04-29T00:00:00Z",
  };
}

function makeLoader(
  result: LoadNormalizedOrderResult | ((orderId: string) => LoadNormalizedOrderResult),
) {
  return async (_supabase: SupabaseClient, orderId: string) => {
    return typeof result === "function" ? result(orderId) : result;
  };
}

function makeEvaluator(
  shouldHold: boolean,
): (
  supabase: SupabaseClient,
  order: NormalizedClientStoreOrder,
) => Promise<EvaluateOrderForHoldResult> {
  return async (_supabase, order) =>
    ({
      ok: true,
      decision: shouldHold
        ? {
            shouldHold: true,
            firstReason: "non_warehouse_match",
            affectedLines: [],
            heldLineIdempotencyKeys: [],
            perLineReason: new Map(),
            orderId: order.warehouseOrderId,
            connectionId: order.connectionId,
            source: order.source,
          }
        : {
            shouldHold: false,
            firstReason: null,
            affectedLines: [],
            heldLineIdempotencyKeys: [],
            perLineReason: new Map(),
            orderId: order.warehouseOrderId,
            connectionId: order.connectionId,
            source: order.source,
          },
      classifications: [],
    }) as unknown as EvaluateOrderForHoldResult;
}

function makeFetchOk(): typeof import("@/lib/server/sku-matching").fetchRemoteCatalogWithTimeout {
  return (async (_connection) => {
    const r: RemoteCatalogResult = {
      state: "ok",
      items: [],
      error: null,
      fetchedAt: new Date().toISOString(),
    };
    return r;
  }) as typeof import("@/lib/server/sku-matching").fetchRemoteCatalogWithTimeout;
}

function makeFetchFail(
  state: RemoteCatalogResult["state"] = "timeout",
): typeof import("@/lib/server/sku-matching").fetchRemoteCatalogWithTimeout {
  return (async (_connection) => {
    const r: RemoteCatalogResult = {
      state,
      items: [],
      error: `simulated ${state}`,
      fetchedAt: null,
    };
    return r;
  }) as typeof import("@/lib/server/sku-matching").fetchRemoteCatalogWithTimeout;
}

function makeReleaser(
  response: ReleaseOrderFulfillmentHoldResult,
  spy?: (input: ReleaseOrderFulfillmentHoldInput) => void,
) {
  return (async (_supabase, input) => {
    spy?.(input);
    return response;
  }) as typeof import("@/lib/server/order-hold-rpcs").releaseOrderFulfillmentHold;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-01T12:00:00.000Z");
const EXPECTED_CUTOFF = "2026-04-30T12:00:00.000Z";

describe("runSkuHoldRecoveryRecheck — happy path", () => {
  it("releases an order when fetch succeeds and evaluator returns shouldHold=false", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          orders: [{ id: "ord-1", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connection: { id: "conn-1", platform: "shopify" },
        },
      ],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({
        ok: true,
        order: makeNormalizedOrder("ord-1", "conn-1"),
      }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "evt-1", idempotent: false }, releaserSpy),
    });

    expect(result.total_released).toBe(1);
    expect(result.total_still_held).toBe(0);
    expect(result.total_errors).toBe(0);
    expect(releaserSpy).toHaveBeenCalledOnce();

    const input = releaserSpy.mock.calls[0][0] as ReleaseOrderFulfillmentHoldInput;
    expect(input).toMatchObject({
      orderId: "ord-1",
      resolutionCode: "fetch_recovered_evaluator_passed",
      actorKind: "recovery_task",
    });

    // Cutoff is 24h prior to now, exactly.
    expect(state.observedHoldQuery.cutoffIso).toBe(EXPECTED_CUTOFF);
  });
});

describe("runSkuHoldRecoveryRecheck — conditions preventing release", () => {
  it("fetch failure: order counted as still-held, release NOT called", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          orders: [{ id: "ord-2", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connection: { id: "conn-1", platform: "shopify" },
        },
      ],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchFail("auth_expired"),
      loadOrder: makeLoader({ ok: true, order: makeNormalizedOrder("ord-2", "conn-1") }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }, releaserSpy),
    });

    expect(result.total_released).toBe(0);
    expect(result.total_still_held).toBe(1);
    expect(releaserSpy).not.toHaveBeenCalled();

    const wsResult = result.per_workspace[0];
    expect(wsResult.per_order[0]).toMatchObject({ status: "fetch_failed" });
  });

  it("evaluator still says hold: release NOT called", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          orders: [{ id: "ord-3", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connection: { id: "conn-1", platform: "shopify" },
        },
      ],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: true, order: makeNormalizedOrder("ord-3", "conn-1") }),
      evaluate: makeEvaluator(true),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }, releaserSpy),
    });

    expect(result.total_released).toBe(0);
    expect(result.total_still_held).toBe(1);
    expect(releaserSpy).not.toHaveBeenCalled();
    expect(result.per_workspace[0].per_order[0].status).toBe("still_holds");
  });

  it("loader failure: counted as error", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          orders: [{ id: "ord-4", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connection: { id: "conn-1", platform: "shopify" },
        },
      ],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: false, reason: "ambiguous_connection", detail: "dup" }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }, releaserSpy),
    });

    expect(result.total_errors).toBe(1);
    expect(result.total_released).toBe(0);
    expect(releaserSpy).not.toHaveBeenCalled();
    expect(result.per_workspace[0].per_order[0].status).toBe("load_failed");
  });

  it("connection missing: counted as error", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          orders: [{ id: "ord-5", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connectionMissing: true,
          connection: { id: "conn-1", platform: "shopify" },
        },
      ],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: true, order: makeNormalizedOrder("ord-5", "conn-1") }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }, releaserSpy),
    });

    expect(result.total_errors).toBe(1);
    expect(releaserSpy).not.toHaveBeenCalled();
    expect(result.per_workspace[0].per_order[0].status).toBe("connection_missing");
  });

  it("release RPC failure: status is release_failed, not released", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-1",
          orders: [{ id: "ord-6", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connection: { id: "conn-1", platform: "shopify" },
        },
      ],
    });

    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: true, order: makeNormalizedOrder("ord-6", "conn-1") }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({
        ok: false,
        reason: "order_not_on_hold",
        detail: "already released",
      }),
    });

    expect(result.total_released).toBe(0);
    expect(result.total_errors).toBe(1);
    expect(result.per_workspace[0].per_order[0].status).toBe("release_failed");
  });
});

describe("runSkuHoldRecoveryRecheck — workspace gates", () => {
  it("emergency-paused workspace is skipped; no order read performed", async () => {
    const state = freshState({
      workspaces: [
        {
          id: "ws-paused",
          paused: true,
          orders: [{ id: "ord-x", source: "shopify", fulfillment_hold_at: "2026-05-01T09:00:00Z" }],
          connection: { id: "conn-1" },
        },
      ],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: true, order: makeNormalizedOrder("ord-x", "conn-1") }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }, releaserSpy),
    });

    expect(result.per_workspace[0].status).toBe("emergency_paused");
    expect(releaserSpy).not.toHaveBeenCalled();
    expect(state.observedHoldQuery.workspaceId).toBeUndefined();
  });

  it("pause READ error fails closed", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-1", emergencyReadError: "db down" }],
    });

    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: false, reason: "order_not_found" }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }),
    });

    expect(result.per_workspace[0]).toMatchObject({
      status: "pause_read_failed",
      detail: "db down",
    });
  });

  it("orders read failure is recorded; no per-order work runs", async () => {
    const state = freshState({
      workspaces: [{ id: "ws-1", ordersReadError: "relation missing" }],
    });

    const releaserSpy = vi.fn();
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: false, reason: "order_not_found" }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }, releaserSpy),
    });

    expect(result.per_workspace[0]).toMatchObject({
      status: "orders_read_failed",
      detail: "relation missing",
    });
    expect(releaserSpy).not.toHaveBeenCalled();
  });

  it("workspaces-list read failure returns empty result without throwing", async () => {
    const state = freshState({ workspacesReadError: "pool exhausted" });
    const result = await runSkuHoldRecoveryRecheck({
      supabase: makeFakeSupabase(state) as never,
      now: NOW,
      fetchCatalog: makeFetchOk(),
      loadOrder: makeLoader({ ok: false, reason: "order_not_found" }),
      evaluate: makeEvaluator(false),
      releaser: makeReleaser({ ok: true, holdEventId: "e", idempotent: false }),
    });

    expect(result.workspaces_scanned).toBe(0);
    expect(result.per_workspace).toEqual([]);
  });
});
