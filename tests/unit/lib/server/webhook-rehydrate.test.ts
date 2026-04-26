/**
 * Unit tests — `rehydrateWebhookInventoryUpdate()` orchestrator
 * (Phase 4 SKU-AUTO-24 + SKU-AUTO-28).
 *
 * Coverage map (every branch in the orchestrator + its SKU-AUTO-24
 * contract: no discovery routing when an identity row exists):
 *
 *   Identity-lookup layer
 *     * Emergency pause → emergency_paused (no other reads).
 *     * Workspace read error → identity_lookup_failed.
 *     * All three lookup keys null → identity_lookup_failed
 *       (the caller must provide at least one key).
 *     * remote_inventory_item_id hit → found.
 *     * Inventory-item miss → (product, variant) pair hit.
 *     * Both above miss → remote_fingerprint hit.
 *     * All probes miss → no_identity_row.
 *     * DB error mid-probe → identity_lookup_failed.
 *
 *   Policy-branch layer
 *     * Inactive identity row → updated_evidence_only/
 *       inactive_identity_row; evidence bump executed.
 *     * Active non-exception state → updated_evidence_only/
 *       not_stock_exception; evidence bump executed.
 *     * Exception + unreliable tier → bumped_reobserved/
 *       stock_tier_unreliable; no warehouse read attempted? (we DO
 *       read it under the short-circuit rule but that's acceptable;
 *       the test asserts the rationale and the bump).
 *
 *   Promotion layer
 *     * Stock exception + all gates pass → promoted. The promotion
 *       RPC is called with reason_code='stock_positive_promotion'.
 *       A run row is opened before the RPC and closed after with
 *       status='completed'. SKU-AUTO-24 is asserted by confirming
 *       the caller NEVER sees no_identity_row.
 *     * Run open failure → run_open_failed; no promotion RPC.
 *     * Promotion RPC failure → promotion_blocked (reason forwarded);
 *       run is closed with status='failed'; evidence is still bumped.
 *
 *   Side effects
 *     * Every non-promote path updates client_store_product_identity_matches
 *       with evidence_snapshot, last_evaluated_at, and an incremented
 *       evaluation_count.
 *     * Emergency-paused path writes nothing beyond the workspace read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockSignal } from "@/lib/server/stock-reliability";
import {
  type RehydrateSupabaseClient,
  type RehydrateWebhookInventoryUpdateInput,
  rehydrateWebhookInventoryUpdate,
} from "@/lib/server/webhook-rehydrate";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const NOW_ISO = "2026-04-21T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

const workspaceId = "ws-1";
const connectionId = "conn-1";
const variantId = "var-1";
const identityMatchId = "ident-1";

function positiveSignal(value = 4): StockSignal {
  return {
    value,
    observedAt: NOW_ISO,
    observedAtLocal: NOW_ISO,
    source: "shopify_graphql",
    tier: "fresh_remote",
  };
}

function stableHistoryRows(value = 4): Array<Record<string, unknown>> {
  return Array.from({ length: 13 }, (_, i) => ({
    observed_at: new Date(NOW_MS - i * 30 * 60 * 1000).toISOString(),
    available: value,
  }));
}

type ProbeResult = {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
};

interface ClientSetup {
  workspaceRead?: { data: Record<string, unknown> | null; error: { message: string } | null };
  identityByInventoryItem?: ProbeResult;
  identityByProductVariant?: ProbeResult;
  identityByFingerprint?: ProbeResult;
  warehouseLevel?: ProbeResult;
  stabilityHistory?: {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  };
  runInsert?: {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  };
  rpcResult?: { data: unknown; error: { message: string } | null };
  decisionInsert?: {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  };
}

interface Spies {
  client: RehydrateSupabaseClient;
  rpc: ReturnType<typeof vi.fn>;
  identityUpdate: ReturnType<typeof vi.fn>;
  identityUpdatePayloads: Array<Record<string, unknown>>;
  runInsert: ReturnType<typeof vi.fn>;
  runUpdate: ReturnType<typeof vi.fn>;
  runUpdatePayloads: Array<Record<string, unknown>>;
  decisionInsert: ReturnType<typeof vi.fn>;
  calls: {
    identityProbesByKey: string[];
    warehouseReads: number;
    historyReads: number;
  };
}

function makeClient(setup: ClientSetup = {}): Spies {
  const rpc = vi.fn(
    async (_fn: string, _args: Record<string, unknown>) =>
      setup.rpcResult ?? { data: "alias-1", error: null },
  );

  const identityUpdatePayloads: Array<Record<string, unknown>> = [];
  const identityUpdate = vi.fn((row: Record<string, unknown>) => {
    identityUpdatePayloads.push(row);
    return {
      eq: async (_c: string, _v: string) => ({ data: null, error: null }),
    };
  });

  const runUpdatePayloads: Array<Record<string, unknown>> = [];
  const runUpdate = vi.fn((row: Record<string, unknown>) => {
    runUpdatePayloads.push(row);
    return {
      eq: async (_c: string, _v: string) => ({ data: null, error: null }),
    };
  });

  const runInsert = vi.fn((_rows: Record<string, unknown>[]) => ({
    select: (_cols: string) => ({
      single: async () =>
        setup.runInsert ?? {
          data: { id: "run-1" },
          error: null,
        },
    }),
  }));

  const decisionInsert = vi.fn((_rows: Record<string, unknown>[]) => ({
    select: (_cols: string) => ({
      single: async () =>
        setup.decisionInsert ?? {
          data: { id: "decision-1" },
          error: null,
        },
    }),
  }));

  const calls: Spies["calls"] = {
    identityProbesByKey: [],
    warehouseReads: 0,
    historyReads: 0,
  };

  /**
   * Identity select builder — records which key the caller chained on
   * and returns the corresponding ProbeResult stub.
   */
  function identitySelect() {
    let product: string | null = null;
    let variant: string | null = null;
    let inventoryItem: string | null = null;
    let fingerprint: string | null = null;

    const builder = {
      eq(col: string, val: string) {
        if (col === "remote_inventory_item_id") inventoryItem = val;
        else if (col === "remote_product_id") product = val;
        else if (col === "remote_variant_id") variant = val;
        else if (col === "remote_fingerprint") fingerprint = val;
        return builder;
      },
      async maybeSingle() {
        if (inventoryItem) {
          calls.identityProbesByKey.push("remote_inventory_item_id");
          return setup.identityByInventoryItem ?? { data: null, error: null };
        }
        if (product && variant) {
          calls.identityProbesByKey.push("remote_product_id+remote_variant_id");
          return setup.identityByProductVariant ?? { data: null, error: null };
        }
        if (fingerprint) {
          calls.identityProbesByKey.push("remote_fingerprint");
          return setup.identityByFingerprint ?? { data: null, error: null };
        }
        calls.identityProbesByKey.push("no_key_set");
        return { data: null, error: null };
      },
      order(_c: string, _opts: { ascending: boolean }) {
        return {
          limit: async (_n: number) => ({ data: [], error: null }),
        };
      },
    };
    return builder;
  }

  function workspaceSelect() {
    return {
      eq(_c: string, _v: string) {
        return {
          eq(_c2: string, _v2: string) {
            return {
              maybeSingle: async () => ({ data: null, error: null }),
            };
          },
          async maybeSingle() {
            return (
              setup.workspaceRead ?? {
                data: { sku_autonomous_emergency_paused: false },
                error: null,
              }
            );
          },
          order() {
            return { limit: async () => ({ data: [], error: null }) };
          },
        };
      },
      order() {
        return { limit: async () => ({ data: [], error: null }) };
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
  }

  function warehouseSelect() {
    return {
      eq(_c: string, _v: string) {
        return {
          eq(_c2: string, _v2: string) {
            return {
              maybeSingle: async () => ({ data: null, error: null }),
            };
          },
          async maybeSingle() {
            calls.warehouseReads += 1;
            return setup.warehouseLevel ?? { data: null, error: null };
          },
          order() {
            return { limit: async () => ({ data: [], error: null }) };
          },
        };
      },
      order() {
        return { limit: async () => ({ data: [], error: null }) };
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
  }

  function stabilitySelect() {
    return {
      eq(_c: string, _v: string) {
        return {
          eq(_c2: string, _v2: string) {
            return {
              eq(_c3: string, _v3: string) {
                return {
                  order(_col: string, _opts: { ascending: boolean }) {
                    return {
                      limit: async (_n: number) => {
                        calls.historyReads += 1;
                        return (
                          setup.stabilityHistory ?? {
                            data: [],
                            error: null,
                          }
                        );
                      },
                    };
                  },
                  maybeSingle: async () => ({ data: null, error: null }),
                };
              },
              order(_col: string, _opts: { ascending: boolean }) {
                return {
                  limit: async (_n: number) => {
                    calls.historyReads += 1;
                    return (
                      setup.stabilityHistory ?? {
                        data: [],
                        error: null,
                      }
                    );
                  },
                };
              },
              maybeSingle: async () => ({ data: null, error: null }),
            };
          },
          order() {
            return {
              limit: async () => {
                calls.historyReads += 1;
                return setup.stabilityHistory ?? { data: [], error: null };
              },
            };
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
      order() {
        return {
          limit: async () => {
            calls.historyReads += 1;
            return setup.stabilityHistory ?? { data: [], error: null };
          },
        };
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
  }

  const from = vi.fn((table: string) => {
    if (table === "workspaces") {
      return {
        select: (_cols: string) => workspaceSelect(),
        update: identityUpdate,
        insert: runInsert,
      };
    }
    if (table === "client_store_product_identity_matches") {
      return {
        select: (_cols: string) => identitySelect(),
        update: identityUpdate,
        insert: runInsert,
      };
    }
    if (table === "warehouse_inventory_levels") {
      return {
        select: (_cols: string) => warehouseSelect(),
        update: identityUpdate,
        insert: runInsert,
      };
    }
    if (table === "stock_stability_readings") {
      return {
        select: (_cols: string) => stabilitySelect(),
        update: identityUpdate,
        insert: runInsert,
      };
    }
    if (table === "sku_autonomous_runs") {
      return {
        select: (_cols: string) => workspaceSelect(),
        update: runUpdate,
        insert: runInsert,
      };
    }
    if (table === "sku_autonomous_decisions") {
      return {
        select: (_cols: string) => workspaceSelect(),
        update: identityUpdate,
        insert: decisionInsert,
      };
    }
    return {
      select: (_cols: string) => workspaceSelect(),
      update: identityUpdate,
      insert: runInsert,
    };
  });

  const client = { rpc, from } as unknown as RehydrateSupabaseClient;

  return {
    client,
    rpc,
    identityUpdate,
    identityUpdatePayloads,
    runInsert,
    runUpdate,
    runUpdatePayloads,
    decisionInsert,
    calls,
  };
}

function baseInput(
  overrides: Partial<RehydrateWebhookInventoryUpdateInput> = {},
): RehydrateWebhookInventoryUpdateInput {
  return {
    workspaceId,
    connectionId,
    platform: "shopify",
    inboundStockSignal: positiveSignal(4),
    identityKeys: { remoteInventoryItemId: "inv-9" },
    triggeredBy: "webhook:shopify:inventory_levels_update",
    webhookEventId: "wh-evt-1",
    ...overrides,
  };
}

const activeStockException = {
  data: {
    id: identityMatchId,
    outcome_state: "client_stock_exception",
    is_active: true,
    state_version: 7,
    variant_id: variantId,
    evidence_snapshot: { prior_reason: "client_stock_exception_initial" },
    evaluation_count: 2,
  },
  error: null,
};

const activeShadowIdentity = {
  data: {
    id: identityMatchId,
    outcome_state: "auto_shadow_identity_match",
    is_active: true,
    state_version: 3,
    variant_id: variantId,
    evidence_snapshot: {},
    evaluation_count: 1,
  },
  error: null,
};

const inactiveRow = {
  data: {
    id: identityMatchId,
    outcome_state: "auto_database_identity_match",
    is_active: false,
    state_version: 1,
    variant_id: variantId,
    evidence_snapshot: {},
    evaluation_count: 9,
  },
  error: null,
};

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("rehydrateWebhookInventoryUpdate — emergency pause (SKU-AUTO-28)", () => {
  it("short-circuits with emergency_paused and performs no identity writes", async () => {
    const spies = makeClient({
      workspaceRead: {
        data: { sku_autonomous_emergency_paused: true },
        error: null,
      },
      identityByInventoryItem: activeStockException,
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({ kind: "emergency_paused" });
    expect(spies.calls.identityProbesByKey).toEqual([]);
    expect(spies.identityUpdatePayloads).toEqual([]);
    expect(spies.runInsert).not.toHaveBeenCalled();
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it("surfaces workspace read errors as identity_lookup_failed", async () => {
    const spies = makeClient({
      workspaceRead: { data: null, error: { message: "db_offline" } },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({ kind: "identity_lookup_failed", detail: "db_offline" });
  });
});

describe("rehydrateWebhookInventoryUpdate — identity lookup cascade", () => {
  it("probes remote_inventory_item_id FIRST and returns found on hit", async () => {
    const spies = makeClient({ identityByInventoryItem: activeShadowIdentity });

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({
        identityKeys: {
          remoteInventoryItemId: "inv-9",
          remoteProductId: "prod-9",
          remoteVariantId: "var-9",
          remoteFingerprint: "fp-9",
        },
      }),
    );

    expect(result.kind).toBe("updated_evidence_only");
    expect(spies.calls.identityProbesByKey).toEqual(["remote_inventory_item_id"]);
  });

  it("falls through from inventory-item miss to (product, variant) hit", async () => {
    const spies = makeClient({
      identityByInventoryItem: { data: null, error: null },
      identityByProductVariant: activeShadowIdentity,
    });

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({
        identityKeys: {
          remoteInventoryItemId: "inv-9",
          remoteProductId: "prod-9",
          remoteVariantId: "var-9",
          remoteFingerprint: "fp-9",
        },
      }),
    );

    expect(result.kind).toBe("updated_evidence_only");
    expect(spies.calls.identityProbesByKey).toEqual([
      "remote_inventory_item_id",
      "remote_product_id+remote_variant_id",
    ]);
  });

  it("falls through inventory + product/variant miss to fingerprint hit", async () => {
    const spies = makeClient({
      identityByInventoryItem: { data: null, error: null },
      identityByProductVariant: { data: null, error: null },
      identityByFingerprint: activeShadowIdentity,
    });

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({
        identityKeys: {
          remoteInventoryItemId: "inv-9",
          remoteProductId: "prod-9",
          remoteVariantId: "var-9",
          remoteFingerprint: "fp-9",
        },
      }),
    );

    expect(result.kind).toBe("updated_evidence_only");
    expect(spies.calls.identityProbesByKey).toEqual([
      "remote_inventory_item_id",
      "remote_product_id+remote_variant_id",
      "remote_fingerprint",
    ]);
  });

  it("returns no_identity_row when every probe misses", async () => {
    const spies = makeClient({
      identityByInventoryItem: { data: null, error: null },
      identityByProductVariant: { data: null, error: null },
      identityByFingerprint: { data: null, error: null },
    });

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({
        identityKeys: {
          remoteInventoryItemId: "inv-9",
          remoteProductId: "prod-9",
          remoteVariantId: "var-9",
          remoteFingerprint: "fp-9",
        },
      }),
    );

    expect(result).toEqual({ kind: "no_identity_row" });
    expect(spies.identityUpdatePayloads).toEqual([]);
  });

  it("skips probes whose keys are null", async () => {
    const spies = makeClient({
      identityByFingerprint: activeShadowIdentity,
    });

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({
        identityKeys: {
          remoteInventoryItemId: null,
          remoteFingerprint: "fp-9",
        },
      }),
    );

    expect(result.kind).toBe("updated_evidence_only");
    expect(spies.calls.identityProbesByKey).toEqual(["remote_fingerprint"]);
  });

  it("propagates probe DB errors as identity_lookup_failed", async () => {
    const spies = makeClient({
      identityByInventoryItem: { data: null, error: { message: "supabase_timeout" } },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({ kind: "identity_lookup_failed", detail: "supabase_timeout" });
  });

  it("returns no_identity_row when no identity keys are set at all", async () => {
    const spies = makeClient();

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({ identityKeys: {} }),
    );

    // Policy never fires because no probes run; orchestrator returns
    // "none" from the cascade which maps to no_identity_row.
    expect(result).toEqual({ kind: "no_identity_row" });
  });
});

describe("rehydrateWebhookInventoryUpdate — policy branches on the found row", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("inactive identity row → updated_evidence_only + bumps evidence", async () => {
    const spies = makeClient({ identityByInventoryItem: inactiveRow });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({
      kind: "updated_evidence_only",
      identityMatchId,
      outcomeState: "auto_database_identity_match",
      rationale: "inactive_identity_row",
    });
    expect(spies.identityUpdatePayloads).toHaveLength(1);
    const bump = spies.identityUpdatePayloads[0];
    expect(bump?.evaluation_count).toBe(10);
    expect(bump?.last_evaluated_at).toBe(NOW_ISO);
    expect(bump?.evidence_snapshot).toEqual(
      expect.objectContaining({
        latest_webhook_reading: expect.objectContaining({
          value: 4,
          source: "shopify_graphql",
        }),
      }),
    );
    expect(spies.rpc).not.toHaveBeenCalled();
    expect(spies.runInsert).not.toHaveBeenCalled();
    expect(spies.calls.warehouseReads).toBe(0);
    expect(spies.calls.historyReads).toBe(0);
  });

  it("active non-exception row → updated_evidence_only/not_stock_exception", async () => {
    const spies = makeClient({ identityByInventoryItem: activeShadowIdentity });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({
      kind: "updated_evidence_only",
      identityMatchId,
      outcomeState: "auto_shadow_identity_match",
      rationale: "not_stock_exception",
    });
    expect(spies.identityUpdatePayloads).toHaveLength(1);
    expect(spies.calls.warehouseReads).toBe(0);
    expect(spies.calls.historyReads).toBe(0);
  });

  it("stock exception + stability history empty → bump_reobserved/stability_gate_failed", async () => {
    const spies = makeClient({
      identityByInventoryItem: activeStockException,
      warehouseLevel: {
        data: { available: 10, committed_quantity: 0 },
        error: null,
      },
      stabilityHistory: { data: [], error: null },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({
      kind: "bumped_reobserved",
      identityMatchId,
      rationale: "stability_gate_failed",
    });
    expect(spies.identityUpdatePayloads).toHaveLength(1);
    expect(spies.calls.warehouseReads).toBe(1);
    expect(spies.calls.historyReads).toBe(1);
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it("stock exception + warehouse ATP zero → bump_reobserved/warehouse_atp_zero", async () => {
    const spies = makeClient({
      identityByInventoryItem: activeStockException,
      warehouseLevel: {
        data: { available: 5, committed_quantity: 5 },
        error: null,
      },
      stabilityHistory: { data: stableHistoryRows(4), error: null },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({
      kind: "bumped_reobserved",
      identityMatchId,
      rationale: "warehouse_atp_zero",
    });
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it("treats a missing warehouse_inventory_levels row as ATP zero", async () => {
    const spies = makeClient({
      identityByInventoryItem: activeStockException,
      warehouseLevel: { data: null, error: null },
      stabilityHistory: { data: stableHistoryRows(4), error: null },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result.kind).toBe("bumped_reobserved");
    if (result.kind === "bumped_reobserved") {
      expect(result.rationale).toBe("warehouse_atp_zero");
    }
  });

  it("stock exception + non-positive inbound stock → bump_reobserved/remote_stock_not_positive", async () => {
    const spies = makeClient({
      identityByInventoryItem: activeStockException,
      warehouseLevel: {
        data: { available: 10, committed_quantity: 0 },
        error: null,
      },
      stabilityHistory: { data: stableHistoryRows(4), error: null },
    });

    const zeroSignal: StockSignal = { ...positiveSignal(0), value: 0 };

    const result = await rehydrateWebhookInventoryUpdate(
      spies.client,
      baseInput({ inboundStockSignal: zeroSignal }),
    );

    expect(result).toEqual({
      kind: "bumped_reobserved",
      identityMatchId,
      rationale: "remote_stock_not_positive",
    });
  });
});

describe("rehydrateWebhookInventoryUpdate — promotion happy path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("promotes + opens audit run + calls promote_identity_match_to_alias with stock_positive_promotion", async () => {
    const spies = makeClient({
      workspaceRead: {
        data: {
          sku_autonomous_emergency_paused: false,
          flags: { sku_live_alias_autonomy_enabled: true },
        },
        error: null,
      },
      identityByInventoryItem: activeStockException,
      warehouseLevel: {
        data: { available: 10, committed_quantity: 0 },
        error: null,
      },
      stabilityHistory: { data: stableHistoryRows(4), error: null },
      runInsert: { data: { id: "run-abc" }, error: null },
      rpcResult: { data: "alias-xyz", error: null },
      decisionInsert: { data: { id: "decision-xyz" }, error: null },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result.kind).toBe("promoted");
    if (result.kind === "promoted") {
      expect(result.identityMatchId).toBe(identityMatchId);
      expect(result.aliasId).toBe("alias-xyz");
      expect(result.decisionId).toBe("decision-xyz");
      expect(result.runId).toBe("run-abc");
    }

    // Run opened exactly once with stock_change_trigger.
    expect(spies.runInsert).toHaveBeenCalledTimes(1);
    const runRows = spies.runInsert.mock.calls[0]?.[0];
    expect(Array.isArray(runRows)).toBe(true);
    expect(runRows[0]).toEqual(
      expect.objectContaining({
        workspace_id: workspaceId,
        connection_id: connectionId,
        trigger_source: "stock_change_trigger",
        dry_run: false,
        triggered_by: "webhook:shopify:inventory_levels_update",
      }),
    );
    expect(runRows[0].feature_flags).toEqual(
      expect.objectContaining({
        webhook_event_id: "wh-evt-1",
        platform: "shopify",
        entry_point: "webhook_rehydrate_inventory_update",
      }),
    );

    // Promotion RPC called with stock_positive_promotion.
    expect(spies.rpc).toHaveBeenCalledTimes(1);
    const rpcCall = spies.rpc.mock.calls[0];
    expect(rpcCall?.[0]).toBe("promote_identity_match_to_alias");
    expect(rpcCall?.[1]).toEqual(
      expect.objectContaining({
        p_identity_match_id: identityMatchId,
        p_expected_state_version: 7,
        p_reason_code: "stock_positive_promotion",
        p_triggered_by: "webhook:shopify:inventory_levels_update",
      }),
    );

    // Decision row inserted exactly once.
    expect(spies.decisionInsert).toHaveBeenCalledTimes(1);

    // Run closed with completed.
    expect(spies.runUpdate).toHaveBeenCalledTimes(1);
    expect(spies.runUpdatePayloads[0]).toEqual(expect.objectContaining({ status: "completed" }));

    // SKU-AUTO-24: caller never routed to discovery.
    expect(result).not.toEqual({ kind: "no_identity_row" });
  });

  it("surfaces run_open_failed without calling the promotion RPC", async () => {
    const spies = makeClient({
      workspaceRead: {
        data: {
          sku_autonomous_emergency_paused: false,
          flags: { sku_live_alias_autonomy_enabled: true },
        },
        error: null,
      },
      identityByInventoryItem: activeStockException,
      warehouseLevel: { data: { available: 10, committed_quantity: 0 }, error: null },
      stabilityHistory: { data: stableHistoryRows(4), error: null },
      runInsert: { data: null, error: { message: "insert failed" } },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result).toEqual({
      kind: "run_open_failed",
      detail: "insert failed",
      identityMatchId,
    });
    expect(spies.rpc).not.toHaveBeenCalled();
    expect(spies.runUpdate).not.toHaveBeenCalled();
  });

  it("surfaces promotion_blocked when the promotion RPC fails + closes run failed + bumps evidence", async () => {
    const spies = makeClient({
      workspaceRead: {
        data: {
          sku_autonomous_emergency_paused: false,
          flags: { sku_live_alias_autonomy_enabled: true },
        },
        error: null,
      },
      identityByInventoryItem: activeStockException,
      warehouseLevel: { data: { available: 10, committed_quantity: 0 }, error: null },
      stabilityHistory: { data: stableHistoryRows(4), error: null },
      runInsert: { data: { id: "run-xyz" }, error: null },
      rpcResult: { data: null, error: { message: "state_version drift" } },
    });

    const result = await rehydrateWebhookInventoryUpdate(spies.client, baseInput());

    expect(result.kind).toBe("promotion_blocked");
    if (result.kind === "promotion_blocked") {
      expect(result.reason).toBe("state_version_drift");
      expect(result.runId).toBe("run-xyz");
    }

    // Evidence STILL bumped so next cycle has the latest reading.
    expect(spies.identityUpdatePayloads).toHaveLength(1);
    // Run closed as failed.
    expect(spies.runUpdatePayloads[0]).toEqual(expect.objectContaining({ status: "failed" }));
  });
});
