/**
 * Unit tests for `evaluateAndApplyOrderHold` — the Phase 8 shared
 * hold-ingress helper that both webhook and poll ingress call.
 *
 * Exhaustive branch coverage:
 *   - hold_disabled (flag off) — no DB reads
 *   - emergency_paused — no DB reads
 *   - unsupported_platform — loader returns unsupported_platform
 *   - loader_error — loader returns any other failure (order_not_found,
 *     missing_connection, ambiguous_connection, no_lines)
 *   - evaluator_error — evaluator returns ok: false
 *   - no_hold — evaluator says shouldHold=false; no RPC call
 *   - hold_applied (webhook source) — full happy path, with mixed-order
 *     committable lines
 *   - hold_applied (poll source) — identical input yields identical cycle
 *     id + identical decision (SKU-AUTO-3 parity guarantee)
 *   - apply_error — evaluator says hold, but RPC fails
 *   - HOLD_REASON_TO_APPLY_REASON exhaustiveness
 *   - Cycle id determinism
 *   - Helper pure builders (buildCommitLinesFromClassifications,
 *     buildHeldLinesPayload, buildCommittableRemoteSkuSet,
 *     summarizeCommittableLines)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedClientStoreOrder } from "@/lib/server/normalized-order";
import type { loadNormalizedOrder } from "@/lib/server/normalized-order-loader";
import type { evaluateOrderForHold } from "@/lib/server/order-hold-evaluator";
import type { OrderHoldIngressInput } from "@/lib/server/order-hold-ingress";
import {
  buildCommitLinesFromClassifications,
  buildCommittableRemoteSkuSet,
  buildHeldLinesPayload,
  buildIngressCycleId,
  evaluateAndApplyOrderHold,
  HOLD_REASON_TO_APPLY_REASON,
  type IngressGuardsReader,
  runHoldIngressSafely,
  summarizeCommittableLines,
} from "@/lib/server/order-hold-ingress";
import type {
  HoldDecision,
  HoldLineClassification,
  HoldReason,
} from "@/lib/server/order-hold-policy";
import type {
  ApplyOrderFulfillmentHoldInput,
  ApplyOrderFulfillmentHoldResult,
} from "@/lib/server/order-hold-rpcs";

const STUB_SUPABASE = {} as unknown as SupabaseClient;

const BASE_INPUT: OrderHoldIngressInput = {
  orderId: "order-uuid-1",
  workspaceId: "ws-1",
  source: "webhook",
  holdEnabled: true,
  emergencyPaused: false,
};

function makeNormalizedOrder(
  overrides: Partial<NormalizedClientStoreOrder> = {},
): NormalizedClientStoreOrder {
  return {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId: "conn-1",
    platform: "shopify",
    remoteOrderId: "remote-order-abc",
    source: "webhook",
    warehouseOrderId: "order-uuid-1",
    orderCreatedAt: "2026-04-21T12:00:00Z",
    lines: [
      {
        remoteSku: "SKU-W1",
        remoteProductId: null,
        remoteVariantId: "v1",
        quantity: 2,
        title: "Warehouse 1",
        warehouseOrderItemId: "item-1",
      },
      {
        remoteSku: "SKU-W2",
        remoteProductId: null,
        remoteVariantId: "v2",
        quantity: 1,
        title: "Warehouse 2",
        warehouseOrderItemId: "item-2",
      },
      {
        remoteSku: "SKU-N1",
        remoteProductId: null,
        remoteVariantId: "v3",
        quantity: 1,
        title: "Non-warehouse 1",
        warehouseOrderItemId: "item-3",
      },
    ],
    ...overrides,
  };
}

function committableClassification(
  line: NormalizedClientStoreOrder["lines"][number],
  variantId: string,
  aliasId: string,
  available = 50,
): HoldLineClassification {
  return {
    committable: true,
    line,
    aliasId,
    variantId,
    availableStockAtEval: available,
  };
}

function nonWarehouseClassification(
  line: NormalizedClientStoreOrder["lines"][number],
  reason: HoldReason = "non_warehouse_sku",
  identityMatchId: string | null = null,
): HoldLineClassification {
  return {
    committable: false,
    line,
    reason,
    identityMatchId,
    availableStockAtEval: reason === "non_warehouse_sku" ? 0 : null,
  };
}

function buildMixedHoldDecision(order: NormalizedClientStoreOrder): {
  classifications: HoldLineClassification[];
  decision: HoldDecision;
} {
  const classifications: HoldLineClassification[] = [
    committableClassification(order.lines[0], "variant-1", "alias-1"),
    committableClassification(order.lines[1], "variant-2", "alias-2"),
    nonWarehouseClassification(order.lines[2]),
  ];
  const affected = classifications.filter(
    (c): c is HoldLineClassification & { committable: false } => !c.committable,
  );
  const committable = classifications.filter(
    (c): c is HoldLineClassification & { committable: true } => c.committable,
  );
  const decision: HoldDecision = {
    shouldHold: true,
    holdReason: "non_warehouse_sku",
    affectedLines: affected,
    committableLines: committable,
    clientAlertRequired: true,
    staffReviewRequired: false,
  };
  return { classifications, decision };
}

function mockLoader(order: NormalizedClientStoreOrder): typeof loadNormalizedOrder {
  return vi.fn(async () => ({ ok: true as const, order })) as unknown as typeof loadNormalizedOrder;
}

function mockLoaderError(
  reason:
    | "unsupported_platform"
    | "missing_connection"
    | "ambiguous_connection"
    | "no_lines"
    | "order_not_found",
  detail = "",
): typeof loadNormalizedOrder {
  return vi.fn(async () => ({
    ok: false as const,
    reason,
    detail,
  })) as unknown as typeof loadNormalizedOrder;
}

function mockEvaluator(
  decision: HoldDecision,
  classifications: HoldLineClassification[],
  order: NormalizedClientStoreOrder,
): typeof evaluateOrderForHold {
  return vi.fn(async () => ({
    ok: true as const,
    decision: {
      ...decision,
      orderId: order.warehouseOrderId,
      connectionId: order.connectionId,
      source: order.source,
    },
    classifications,
  })) as unknown as typeof evaluateOrderForHold;
}

function mockEvaluatorError(detail: string): typeof evaluateOrderForHold {
  return vi.fn(async () => ({
    ok: false as const,
    reason: "db_error" as const,
    detail,
  })) as unknown as typeof evaluateOrderForHold;
}

function mockApplyHold(result: ApplyOrderFulfillmentHoldResult): {
  apply: (
    supabase: unknown,
    input: ApplyOrderFulfillmentHoldInput,
  ) => Promise<ApplyOrderFulfillmentHoldResult>;
  calls: ApplyOrderFulfillmentHoldInput[];
} {
  const calls: ApplyOrderFulfillmentHoldInput[] = [];
  const apply = vi.fn(async (_s: unknown, input: ApplyOrderFulfillmentHoldInput) => {
    calls.push(input);
    return result;
  }) as unknown as (
    supabase: unknown,
    input: ApplyOrderFulfillmentHoldInput,
  ) => Promise<ApplyOrderFulfillmentHoldResult>;
  return { apply, calls };
}

describe("HOLD_REASON_TO_APPLY_REASON — exhaustive mapping", () => {
  const allReasons: HoldReason[] = [
    "fetch_incomplete_at_match",
    "placeholder_sku_detected",
    "identity_only_match",
    "unmapped_sku",
    "non_warehouse_sku",
  ];

  it("maps every HoldReason to an ApplyHoldReason", () => {
    for (const reason of allReasons) {
      expect(HOLD_REASON_TO_APPLY_REASON[reason]).toBeDefined();
    }
  });

  it("maps non_warehouse_sku and identity_only_match to non_warehouse_match", () => {
    expect(HOLD_REASON_TO_APPLY_REASON.non_warehouse_sku).toBe("non_warehouse_match");
    expect(HOLD_REASON_TO_APPLY_REASON.identity_only_match).toBe("non_warehouse_match");
  });

  it("maps unmapped_sku to unknown_remote_sku", () => {
    expect(HOLD_REASON_TO_APPLY_REASON.unmapped_sku).toBe("unknown_remote_sku");
  });

  it("maps placeholder_sku_detected to placeholder_remote_sku", () => {
    expect(HOLD_REASON_TO_APPLY_REASON.placeholder_sku_detected).toBe("placeholder_remote_sku");
  });

  it("mirrors fetch_incomplete_at_match directly", () => {
    expect(HOLD_REASON_TO_APPLY_REASON.fetch_incomplete_at_match).toBe("fetch_incomplete_at_match");
  });
});

describe("buildIngressCycleId", () => {
  it("is deterministic for a given (workspace, order) pair", () => {
    expect(buildIngressCycleId("ws-1", "order-abc")).toBe(buildIngressCycleId("ws-1", "order-abc"));
  });

  it("produces different ids for different orders", () => {
    expect(buildIngressCycleId("ws-1", "order-a")).not.toBe(buildIngressCycleId("ws-1", "order-b"));
  });

  it("produces different ids for different workspaces", () => {
    expect(buildIngressCycleId("ws-1", "order-a")).not.toBe(buildIngressCycleId("ws-2", "order-a"));
  });
});

describe("pure builders", () => {
  it("buildCommitLinesFromClassifications keeps only committable lines with valid remote SKU + positive qty", () => {
    const order = makeNormalizedOrder();
    const classifications: HoldLineClassification[] = [
      committableClassification(order.lines[0], "v1", "a1"),
      committableClassification(order.lines[1], "v2", "a2"),
      nonWarehouseClassification(order.lines[2]),
    ];
    expect(buildCommitLinesFromClassifications(classifications)).toEqual([
      { sku: "SKU-W1", qty: 2 },
      { sku: "SKU-W2", qty: 1 },
    ]);
  });

  it("buildCommitLinesFromClassifications drops committable lines with null/empty remote SKU", () => {
    const order = makeNormalizedOrder({
      lines: [
        {
          remoteSku: null,
          remoteProductId: null,
          remoteVariantId: null,
          quantity: 2,
          title: null,
          warehouseOrderItemId: "item-null",
        },
      ],
    });
    const classifications: HoldLineClassification[] = [
      committableClassification(order.lines[0], "v", "a"),
    ];
    expect(buildCommitLinesFromClassifications(classifications)).toEqual([]);
  });

  it("buildHeldLinesPayload shapes every non-committable line with expected fields", () => {
    const order = makeNormalizedOrder();
    const { decision } = buildMixedHoldDecision(order);
    const payload = buildHeldLinesPayload(decision);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      sku: "SKU-N1",
      title: "Non-warehouse 1",
      quantity: 1,
      held: true,
      reason: "non_warehouse_sku",
      warehouse_order_item_id: "item-3",
    });
  });

  it("buildCommittableRemoteSkuSet returns only committable remote SKUs", () => {
    const order = makeNormalizedOrder();
    const { decision } = buildMixedHoldDecision(order);
    const set = buildCommittableRemoteSkuSet(decision);
    expect(set.has("SKU-W1")).toBe(true);
    expect(set.has("SKU-W2")).toBe(true);
    expect(set.has("SKU-N1")).toBe(false);
  });

  it("summarizeCommittableLines mirrors decision.committableLines", () => {
    const order = makeNormalizedOrder();
    const { decision } = buildMixedHoldDecision(order);
    expect(summarizeCommittableLines(decision)).toEqual([
      { remoteSku: "SKU-W1", variantId: "variant-1", quantity: 2 },
      { remoteSku: "SKU-W2", variantId: "variant-2", quantity: 1 },
    ]);
  });
});

describe("evaluateAndApplyOrderHold — short-circuits", () => {
  it("returns hold_disabled without touching DB when holdEnabled=false", async () => {
    const loader = mockLoader(makeNormalizedOrder());
    const evaluator = mockEvaluator(
      { ...buildMixedHoldDecision(makeNormalizedOrder()).decision },
      buildMixedHoldDecision(makeNormalizedOrder()).classifications,
      makeNormalizedOrder(),
    );

    const result = await evaluateAndApplyOrderHold(
      STUB_SUPABASE,
      { ...BASE_INPUT, holdEnabled: false },
      { loadOrder: loader, evaluate: evaluator },
    );

    expect(result).toEqual({ kind: "hold_disabled" });
    expect(loader).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("returns emergency_paused without touching DB when emergencyPaused=true", async () => {
    const loader = mockLoader(makeNormalizedOrder());
    const evaluator = mockEvaluator(
      buildMixedHoldDecision(makeNormalizedOrder()).decision,
      buildMixedHoldDecision(makeNormalizedOrder()).classifications,
      makeNormalizedOrder(),
    );

    const result = await evaluateAndApplyOrderHold(
      STUB_SUPABASE,
      { ...BASE_INPUT, emergencyPaused: true },
      { loadOrder: loader, evaluate: evaluator },
    );

    expect(result).toEqual({ kind: "emergency_paused" });
    expect(loader).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveBeenCalled();
  });
});

describe("evaluateAndApplyOrderHold — loader errors", () => {
  it("returns unsupported_platform when loader reports non-autonomous platform", async () => {
    const loader = mockLoaderError("unsupported_platform", "order.source=bandcamp");
    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
    });
    expect(result.kind).toBe("unsupported_platform");
    if (result.kind === "unsupported_platform") {
      expect(result.detail).toBe("order.source=bandcamp");
    }
  });

  it("returns loader_error for missing_connection", async () => {
    const loader = mockLoaderError("missing_connection", "none found");
    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
    });
    expect(result.kind).toBe("loader_error");
    if (result.kind === "loader_error") {
      expect(result.reason).toBe("missing_connection");
    }
  });

  it("returns loader_error for ambiguous_connection", async () => {
    const loader = mockLoaderError("ambiguous_connection", "two found");
    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
    });
    if (result.kind === "loader_error") {
      expect(result.reason).toBe("ambiguous_connection");
    } else {
      expect.fail(`expected loader_error got ${result.kind}`);
    }
  });

  it("returns loader_error for no_lines", async () => {
    const loader = mockLoaderError("no_lines", "0 rows");
    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
    });
    if (result.kind === "loader_error") {
      expect(result.reason).toBe("no_lines");
    } else {
      expect.fail(`expected loader_error got ${result.kind}`);
    }
  });

  it("returns loader_error for order_not_found", async () => {
    const loader = mockLoaderError("order_not_found", "missing uuid");
    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
    });
    if (result.kind === "loader_error") {
      expect(result.reason).toBe("order_not_found");
    } else {
      expect.fail(`expected loader_error got ${result.kind}`);
    }
  });
});

describe("evaluateAndApplyOrderHold — evaluator errors", () => {
  it("returns evaluator_error when evaluator returns ok: false", async () => {
    const loader = mockLoader(makeNormalizedOrder());
    const evaluator = mockEvaluatorError("postgres down");
    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
      evaluate: evaluator,
    });
    expect(result.kind).toBe("evaluator_error");
    if (result.kind === "evaluator_error") {
      expect(result.detail).toBe("postgres down");
    }
  });
});

describe("evaluateAndApplyOrderHold — no-hold branch", () => {
  it("returns no_hold without calling the RPC when shouldHold=false", async () => {
    const order = makeNormalizedOrder();
    const classifications: HoldLineClassification[] = [
      committableClassification(order.lines[0], "v1", "a1"),
      committableClassification(order.lines[1], "v2", "a2"),
      committableClassification(order.lines[2], "v3", "a3"),
    ];
    const decision: HoldDecision = {
      shouldHold: false,
      holdReason: null,
      affectedLines: [],
      committableLines: classifications.filter(
        (c): c is HoldLineClassification & { committable: true } => c.committable,
      ),
      clientAlertRequired: false,
      staffReviewRequired: false,
    };

    const loader = mockLoader(order);
    const evaluator = mockEvaluator(decision, classifications, order);
    const { apply, calls } = mockApplyHold({
      ok: true,
      holdEventId: "ignored",
      commitsInserted: 0,
      idempotent: false,
    });

    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
      evaluate: evaluator,
      applyHold: apply,
    });

    expect(result.kind).toBe("no_hold");
    if (result.kind === "no_hold") {
      expect(result.classifications).toHaveLength(3);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("evaluateAndApplyOrderHold — hold applied (happy path)", () => {
  it("writes the hold via RPC and returns the committable remote-SKU set for mixed orders", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const loader = mockLoader(order);
    const evaluator = mockEvaluator(decision, classifications, order);
    const { apply, calls } = mockApplyHold({
      ok: true,
      holdEventId: "event-123",
      commitsInserted: 2,
      idempotent: false,
    });

    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
      evaluate: evaluator,
      applyHold: apply,
    });

    expect(result.kind).toBe("hold_applied");
    if (result.kind !== "hold_applied") return;
    expect(result.holdReason).toBe("non_warehouse_sku");
    expect(result.applyHoldReason).toBe("non_warehouse_match");
    expect(result.cycleId).toBe(buildIngressCycleId("ws-1", "order-uuid-1"));
    expect(result.holdEventId).toBe("event-123");
    expect(result.commitsInserted).toBe(2);
    expect(result.clientAlertRequired).toBe(true);
    expect(result.staffReviewRequired).toBe(false);
    expect(Array.from(result.committableRemoteSkus).sort()).toEqual(["SKU-W1", "SKU-W2"]);
    expect(result.committableLines).toEqual([
      { remoteSku: "SKU-W1", variantId: "variant-1", quantity: 2 },
      { remoteSku: "SKU-W2", variantId: "variant-2", quantity: 1 },
    ]);

    expect(calls).toHaveLength(1);
    const [rpcCall] = calls;
    expect(rpcCall.orderId).toBe("order-uuid-1");
    expect(rpcCall.connectionId).toBe("conn-1");
    expect(rpcCall.reason).toBe("non_warehouse_match");
    expect(rpcCall.cycleId).toBe(buildIngressCycleId("ws-1", "order-uuid-1"));
    expect(rpcCall.commitLines).toEqual([
      { sku: "SKU-W1", qty: 2 },
      { sku: "SKU-W2", qty: 1 },
    ]);
    expect(rpcCall.heldLines).toHaveLength(1);
    expect(rpcCall.heldLines?.[0]).toMatchObject({
      sku: "SKU-N1",
      reason: "non_warehouse_sku",
    });
    expect(rpcCall.actorKind).toBe("task");
    expect(rpcCall.metadata).toMatchObject({
      ingress_source: "webhook",
      hold_reason_evaluated: "non_warehouse_sku",
      committable_line_count: 2,
      held_line_count: 1,
      affected_line_count: 1,
    });
  });

  it("SKU-AUTO-3 parity — webhook and poll produce the same cycle id and the same RPC args for identical input", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);

    const webhookLoader = mockLoader(order);
    const webhookEvaluator = mockEvaluator(decision, classifications, order);
    const { apply: webhookApply, calls: webhookCalls } = mockApplyHold({
      ok: true,
      holdEventId: "w-event",
      commitsInserted: 2,
      idempotent: false,
    });

    const pollLoader = mockLoader({ ...order, source: "poll" });
    const pollEvaluator = mockEvaluator(decision, classifications, { ...order, source: "poll" });
    const { apply: pollApply, calls: pollCalls } = mockApplyHold({
      ok: true,
      holdEventId: "p-event",
      commitsInserted: 2,
      idempotent: false,
    });

    const webhookResult = await evaluateAndApplyOrderHold(
      STUB_SUPABASE,
      { ...BASE_INPUT, source: "webhook" },
      { loadOrder: webhookLoader, evaluate: webhookEvaluator, applyHold: webhookApply },
    );
    const pollResult = await evaluateAndApplyOrderHold(
      STUB_SUPABASE,
      { ...BASE_INPUT, source: "poll" },
      { loadOrder: pollLoader, evaluate: pollEvaluator, applyHold: pollApply },
    );

    if (webhookResult.kind !== "hold_applied" || pollResult.kind !== "hold_applied") {
      expect.fail("both ingress paths must reach hold_applied");
    }
    expect(webhookResult.cycleId).toBe(pollResult.cycleId);
    expect(webhookResult.holdReason).toBe(pollResult.holdReason);
    expect(webhookResult.applyHoldReason).toBe(pollResult.applyHoldReason);
    expect(webhookResult.committableLines).toEqual(pollResult.committableLines);
    expect(Array.from(webhookResult.committableRemoteSkus).sort()).toEqual(
      Array.from(pollResult.committableRemoteSkus).sort(),
    );

    const [webhookArgs] = webhookCalls;
    const [pollArgs] = pollCalls;
    expect(webhookArgs.cycleId).toBe(pollArgs.cycleId);
    expect(webhookArgs.reason).toBe(pollArgs.reason);
    expect(webhookArgs.connectionId).toBe(pollArgs.connectionId);
    expect(webhookArgs.heldLines).toEqual(pollArgs.heldLines);
    expect(webhookArgs.commitLines).toEqual(pollArgs.commitLines);
    // Metadata differs only in ingress_source.
    expect((webhookArgs.metadata as Record<string, unknown> | undefined)?.ingress_source).toBe(
      "webhook",
    );
    expect((pollArgs.metadata as Record<string, unknown> | undefined)?.ingress_source).toBe("poll");
  });
});

describe("evaluateAndApplyOrderHold — apply_error", () => {
  it("returns apply_error when the RPC wrapper fails (e.g. cycle_id_conflict)", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const loader = mockLoader(order);
    const evaluator = mockEvaluator(decision, classifications, order);
    const { apply } = mockApplyHold({
      ok: false,
      reason: "cycle_id_conflict",
      detail: "already applied",
    });

    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
      evaluate: evaluator,
      applyHold: apply,
    });

    expect(result.kind).toBe("apply_error");
    if (result.kind === "apply_error") {
      expect(result.reason).toBe("cycle_id_conflict");
      expect(result.detail).toBe("already applied");
      expect(result.decision.shouldHold).toBe(true);
    }
  });

  it("returns apply_error on rpc_error", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const loader = mockLoader(order);
    const evaluator = mockEvaluator(decision, classifications, order);
    const { apply } = mockApplyHold({
      ok: false,
      reason: "rpc_error",
      detail: "postgres disconnected",
    });

    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
      evaluate: evaluator,
      applyHold: apply,
    });
    if (result.kind === "apply_error") {
      expect(result.reason).toBe("rpc_error");
    } else {
      expect.fail(`expected apply_error got ${result.kind}`);
    }
  });

  it("returns apply_error on invalid_hold_reason (defensive)", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const loader = mockLoader(order);
    const evaluator = mockEvaluator(decision, classifications, order);
    const { apply } = mockApplyHold({
      ok: false,
      reason: "invalid_hold_reason",
      detail: "",
    });

    const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
      loadOrder: loader,
      evaluate: evaluator,
      applyHold: apply,
    });
    expect(result.kind).toBe("apply_error");
  });
});

describe("evaluateAndApplyOrderHold — hold-reason permutations", () => {
  type Case = {
    label: string;
    reason: HoldReason;
    applyReason: string;
    expectedClientAlert: boolean;
    expectedStaffReview: boolean;
  };
  const cases: Case[] = [
    {
      label: "non_warehouse_sku",
      reason: "non_warehouse_sku",
      applyReason: "non_warehouse_match",
      expectedClientAlert: true,
      expectedStaffReview: false,
    },
    {
      label: "unmapped_sku",
      reason: "unmapped_sku",
      applyReason: "unknown_remote_sku",
      expectedClientAlert: true,
      expectedStaffReview: false,
    },
    {
      label: "placeholder_sku_detected",
      reason: "placeholder_sku_detected",
      applyReason: "placeholder_remote_sku",
      expectedClientAlert: true,
      expectedStaffReview: false,
    },
    {
      label: "identity_only_match",
      reason: "identity_only_match",
      applyReason: "non_warehouse_match",
      expectedClientAlert: false,
      expectedStaffReview: true,
    },
    {
      label: "fetch_incomplete_at_match",
      reason: "fetch_incomplete_at_match",
      applyReason: "fetch_incomplete_at_match",
      expectedClientAlert: false,
      expectedStaffReview: true,
    },
  ];

  for (const tc of cases) {
    it(`maps ${tc.label} → applyHoldReason ${tc.applyReason} and propagates audience flags`, async () => {
      const order = makeNormalizedOrder({
        lines: [
          {
            remoteSku: "SKU-X",
            remoteProductId: null,
            remoteVariantId: null,
            quantity: 1,
            title: "Hold candidate",
            warehouseOrderItemId: "item-x",
          },
        ],
      });
      const classifications: HoldLineClassification[] = [
        nonWarehouseClassification(order.lines[0], tc.reason),
      ];
      const decision: HoldDecision = {
        shouldHold: true,
        holdReason: tc.reason,
        affectedLines: classifications.filter(
          (c): c is HoldLineClassification & { committable: false } => !c.committable,
        ),
        committableLines: [],
        clientAlertRequired: tc.expectedClientAlert,
        staffReviewRequired: tc.expectedStaffReview,
      };
      const { apply, calls } = mockApplyHold({
        ok: true,
        holdEventId: `event-${tc.label}`,
        commitsInserted: 0,
        idempotent: false,
      });

      const result = await evaluateAndApplyOrderHold(STUB_SUPABASE, BASE_INPUT, {
        loadOrder: mockLoader(order),
        evaluate: mockEvaluator(decision, classifications, order),
        applyHold: apply,
      });

      if (result.kind !== "hold_applied") {
        expect.fail(`expected hold_applied got ${result.kind}`);
      }
      expect(result.applyHoldReason).toBe(tc.applyReason);
      expect(result.holdReason).toBe(tc.reason);
      expect(result.clientAlertRequired).toBe(tc.expectedClientAlert);
      expect(result.staffReviewRequired).toBe(tc.expectedStaffReview);
      expect(calls[0].reason).toBe(tc.applyReason);
      // No committable lines in these fixtures.
      expect(calls[0].commitLines).toEqual([]);
    });
  }
});

describe("evaluateAndApplyOrderHold — passes source through to loader", () => {
  it("stamps source=webhook when caller says webhook", async () => {
    const order = makeNormalizedOrder();
    const loader = vi.fn(async (_s, _id, opts) => ({
      ok: true as const,
      order: { ...order, source: opts.source },
    })) as unknown as typeof loadNormalizedOrder;
    const classifications: HoldLineClassification[] = [
      committableClassification(order.lines[0], "v1", "a1"),
      committableClassification(order.lines[1], "v2", "a2"),
      committableClassification(order.lines[2], "v3", "a3"),
    ];
    const decision: HoldDecision = {
      shouldHold: false,
      holdReason: null,
      affectedLines: [],
      committableLines: classifications.filter(
        (c): c is HoldLineClassification & { committable: true } => c.committable,
      ),
      clientAlertRequired: false,
      staffReviewRequired: false,
    };

    await evaluateAndApplyOrderHold(
      STUB_SUPABASE,
      { ...BASE_INPUT, source: "webhook" },
      {
        loadOrder: loader,
        evaluate: mockEvaluator(decision, classifications, order),
      },
    );

    expect(loader).toHaveBeenCalledWith(
      STUB_SUPABASE,
      "order-uuid-1",
      expect.objectContaining({ source: "webhook" }),
    );
  });

  it("stamps source=poll when caller says poll", async () => {
    const order = makeNormalizedOrder();
    const loader = vi.fn(async (_s, _id, opts) => ({
      ok: true as const,
      order: { ...order, source: opts.source },
    })) as unknown as typeof loadNormalizedOrder;
    const classifications: HoldLineClassification[] = [
      committableClassification(order.lines[0], "v1", "a1"),
      committableClassification(order.lines[1], "v2", "a2"),
      committableClassification(order.lines[2], "v3", "a3"),
    ];
    const decision: HoldDecision = {
      shouldHold: false,
      holdReason: null,
      affectedLines: [],
      committableLines: classifications.filter(
        (c): c is HoldLineClassification & { committable: true } => c.committable,
      ),
      clientAlertRequired: false,
      staffReviewRequired: false,
    };

    await evaluateAndApplyOrderHold(
      STUB_SUPABASE,
      { ...BASE_INPUT, source: "poll" },
      {
        loadOrder: loader,
        evaluate: mockEvaluator(decision, classifications, order),
      },
    );

    expect(loader).toHaveBeenCalledWith(
      STUB_SUPABASE,
      "order-uuid-1",
      expect.objectContaining({ source: "poll" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// runHoldIngressSafely — Phase 8.C/8.D shared wrapper.
//
// Exhaustive branch coverage:
//   - fail-open paths (every verdict MUST be kind:"legacy"):
//       * workspace read threw
//       * workspace read returned workspace_read_failed
//       * workspace flag off (hold_disabled)
//       * workspace emergency paused
//       * evaluator threw
//       * loader_error
//       * evaluator_error
//       * apply_error
//       * unsupported_platform
//   - proceed paths:
//       * no_hold (caller runs legacy commitOrderItems loop)
//       * hold_applied (caller skips commit ledger + filters decrement)
//   - sensor warning shape:
//       * every failure branch emits exactly one warning with stable
//         sensor_name + value keys so ops dashboards can count them.
//   - parity (SKU-AUTO-3):
//       * identical input into webhook + poll produces identical
//         verdict (kind, cycleId, committableRemoteSkus, classifications).
// ─────────────────────────────────────────────────────────────────────

function guardsReader(
  outcome:
    | { kind: "ok"; holdEnabled: boolean; emergencyPaused: boolean }
    | { kind: "workspace_read_failed"; detail: string },
): IngressGuardsReader {
  return vi.fn(async () => outcome) as unknown as IngressGuardsReader;
}

const SAFE_INPUT = {
  workspaceId: "ws-1",
  orderId: "order-uuid-1",
  source: "webhook" as const,
  platform: "shopify" as const,
};

describe("runHoldIngressSafely — short-circuit guards", () => {
  it("returns legacy + no warnings when the flag is off (no loader call)", async () => {
    const loader = mockLoader(makeNormalizedOrder());
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: guardsReader({ kind: "ok", holdEnabled: false, emergencyPaused: false }),
      loadOrder: loader,
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "hold_disabled" });
    expect(warnings).toHaveLength(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns legacy + no warnings when the workspace is emergency-paused (no loader call)", async () => {
    const loader = mockLoader(makeNormalizedOrder());
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: guardsReader({ kind: "ok", holdEnabled: true, emergencyPaused: true }),
      loadOrder: loader,
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "emergency_paused" });
    expect(warnings).toHaveLength(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns legacy + one warning when the workspace read fails", async () => {
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: guardsReader({
        kind: "workspace_read_failed",
        detail: "connection lost",
      }),
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "workspace_read_failed" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sensor_name).toBe("hold_ingress.workspace_read_failed");
    expect(warnings[0].status).toBe("warning");
    expect(warnings[0].value).toMatchObject({
      order_id: "order-uuid-1",
      workspace_id: "ws-1",
      source: "webhook",
      detail: "connection lost",
    });
  });

  it("returns legacy + one warning when the workspace read throws", async () => {
    const throwReader = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as IngressGuardsReader;
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: throwReader,
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "workspace_read_threw" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sensor_name).toBe("hold_ingress.workspace_read_threw");
    expect(warnings[0].value).toMatchObject({ detail: "socket hang up" });
  });
});

describe("runHoldIngressSafely — evaluator/loader/apply errors", () => {
  const okGuards: IngressGuardsReader = guardsReader({
    kind: "ok",
    holdEnabled: true,
    emergencyPaused: false,
  });

  it("returns legacy + warning on loader_error", async () => {
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: mockLoaderError("order_not_found", "missing row"),
    });

    expect(verdict.kind).toBe("legacy");
    if (verdict.kind === "legacy") {
      expect(verdict.reason).toBe("loader_error:order_not_found");
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sensor_name).toBe("hold_ingress.loader_error");
    expect(warnings[0].value).toMatchObject({ reason: "order_not_found", detail: "missing row" });
  });

  it("returns legacy + warning on evaluator_error", async () => {
    const order = makeNormalizedOrder();
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: mockLoader(order),
      evaluate: mockEvaluatorError("postgres unreachable"),
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "evaluator_error" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sensor_name).toBe("hold_ingress.evaluator_error");
    expect(warnings[0].value).toMatchObject({ detail: "postgres unreachable" });
  });

  it("returns legacy + warning on apply_error", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const { apply } = mockApplyHold({
      ok: false,
      reason: "cycle_id_conflict",
      detail: "already applied",
    });
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: mockLoader(order),
      evaluate: mockEvaluator(decision, classifications, order),
      applyHold: apply,
    });

    expect(verdict.kind).toBe("legacy");
    if (verdict.kind === "legacy") {
      expect(verdict.reason).toBe("apply_error:cycle_id_conflict");
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sensor_name).toBe("hold_ingress.apply_error");
    expect(warnings[0].status).toBe("error");
    expect(warnings[0].value).toMatchObject({
      reason: "cycle_id_conflict",
      detail: "already applied",
      hold_reason: "non_warehouse_sku",
    });
  });

  it("returns legacy (no warning) on unsupported_platform", async () => {
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: mockLoaderError("unsupported_platform", "bandcamp"),
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "unsupported_platform" });
    expect(warnings).toHaveLength(0);
  });

  it("returns legacy + warning when evaluateAndApplyOrderHold throws", async () => {
    const throwingLoader = vi.fn(async () => {
      throw new Error("loader exploded");
    }) as unknown as typeof loadNormalizedOrder;
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: throwingLoader,
    });

    expect(verdict).toEqual({ kind: "legacy", reason: "evaluator_threw" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sensor_name).toBe("hold_ingress.evaluator_threw");
    expect(warnings[0].value).toMatchObject({ detail: "loader exploded" });
  });
});

describe("runHoldIngressSafely — proceed paths", () => {
  const okGuards: IngressGuardsReader = guardsReader({
    kind: "ok",
    holdEnabled: true,
    emergencyPaused: false,
  });

  it("returns no_hold (no warnings) when evaluator says shouldHold=false", async () => {
    const order = makeNormalizedOrder();
    const classifications: HoldLineClassification[] = [
      committableClassification(order.lines[0], "v1", "a1"),
      committableClassification(order.lines[1], "v2", "a2"),
      committableClassification(order.lines[2], "v3", "a3"),
    ];
    const decision: HoldDecision = {
      shouldHold: false,
      holdReason: null,
      affectedLines: [],
      committableLines: classifications.filter(
        (c): c is HoldLineClassification & { committable: true } => c.committable,
      ),
      clientAlertRequired: false,
      staffReviewRequired: false,
    };

    const { apply, calls } = mockApplyHold({
      ok: true,
      holdEventId: "unused",
      commitsInserted: 0,
      idempotent: false,
    });
    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: mockLoader(order),
      evaluate: mockEvaluator(decision, classifications, order),
      applyHold: apply,
    });

    expect(verdict.kind).toBe("no_hold");
    if (verdict.kind === "no_hold") {
      expect(verdict.classifications).toHaveLength(3);
    }
    expect(warnings).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("returns hold_applied with committable remote SKU set and full decision on mixed orders", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const { apply, calls } = mockApplyHold({
      ok: true,
      holdEventId: "event-42",
      commitsInserted: 2,
      idempotent: false,
    });

    const { verdict, warnings } = await runHoldIngressSafely(STUB_SUPABASE, SAFE_INPUT, {
      readGuards: okGuards,
      loadOrder: mockLoader(order),
      evaluate: mockEvaluator(decision, classifications, order),
      applyHold: apply,
    });

    expect(warnings).toHaveLength(0);
    expect(verdict.kind).toBe("hold_applied");
    if (verdict.kind !== "hold_applied") return;
    expect(verdict.cycleId).toBe(buildIngressCycleId("ws-1", "order-uuid-1"));
    expect(verdict.holdReason).toBe("non_warehouse_sku");
    expect(verdict.applyHoldReason).toBe("non_warehouse_match");
    expect(verdict.holdEventId).toBe("event-42");
    expect(verdict.commitsInserted).toBe(2);
    expect(verdict.clientAlertRequired).toBe(true);
    expect(verdict.staffReviewRequired).toBe(false);
    expect(Array.from(verdict.committableRemoteSkus).sort()).toEqual(["SKU-W1", "SKU-W2"]);
    expect(verdict.committableLines).toEqual([
      { remoteSku: "SKU-W1", variantId: "variant-1", quantity: 2 },
      { remoteSku: "SKU-W2", variantId: "variant-2", quantity: 1 },
    ]);
    expect(verdict.decision.shouldHold).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata).toMatchObject({ ingress_source: "webhook" });
  });
});

describe("runHoldIngressSafely — SKU-AUTO-3 parity (webhook vs poll)", () => {
  const okGuards: IngressGuardsReader = guardsReader({
    kind: "ok",
    holdEnabled: true,
    emergencyPaused: false,
  });

  it("webhook + poll produce identical verdicts for identical inputs (cycleId, committable set, classifications)", async () => {
    const order = makeNormalizedOrder();
    const { classifications, decision } = buildMixedHoldDecision(order);
    const webhookApply = mockApplyHold({
      ok: true,
      holdEventId: "webhook-event",
      commitsInserted: 2,
      idempotent: false,
    });
    const pollApply = mockApplyHold({
      ok: true,
      holdEventId: "poll-event",
      commitsInserted: 2,
      idempotent: false,
    });

    const webhookResult = await runHoldIngressSafely(
      STUB_SUPABASE,
      { ...SAFE_INPUT, source: "webhook" },
      {
        readGuards: okGuards,
        loadOrder: mockLoader({ ...order, source: "webhook" }),
        evaluate: mockEvaluator(decision, classifications, { ...order, source: "webhook" }),
        applyHold: webhookApply.apply,
      },
    );
    const pollResult = await runHoldIngressSafely(
      STUB_SUPABASE,
      { ...SAFE_INPUT, source: "poll" },
      {
        readGuards: okGuards,
        loadOrder: mockLoader({ ...order, source: "poll" }),
        evaluate: mockEvaluator(decision, classifications, { ...order, source: "poll" }),
        applyHold: pollApply.apply,
      },
    );

    if (
      webhookResult.verdict.kind !== "hold_applied" ||
      pollResult.verdict.kind !== "hold_applied"
    ) {
      expect.fail("both paths must reach hold_applied");
    }

    expect(webhookResult.verdict.cycleId).toBe(pollResult.verdict.cycleId);
    expect(webhookResult.verdict.holdReason).toBe(pollResult.verdict.holdReason);
    expect(webhookResult.verdict.applyHoldReason).toBe(pollResult.verdict.applyHoldReason);
    expect(webhookResult.verdict.committableLines).toEqual(pollResult.verdict.committableLines);
    expect(Array.from(webhookResult.verdict.committableRemoteSkus).sort()).toEqual(
      Array.from(pollResult.verdict.committableRemoteSkus).sort(),
    );
    expect(webhookResult.verdict.clientAlertRequired).toBe(pollResult.verdict.clientAlertRequired);
    expect(webhookResult.verdict.staffReviewRequired).toBe(pollResult.verdict.staffReviewRequired);
    // Metadata differs only in ingress_source — which is the only allowed delta.
    expect(webhookApply.calls[0].metadata).toMatchObject({ ingress_source: "webhook" });
    expect(pollApply.calls[0].metadata).toMatchObject({ ingress_source: "poll" });
    expect(webhookApply.calls[0].commitLines).toEqual(pollApply.calls[0].commitLines);
    expect(webhookApply.calls[0].heldLines).toEqual(pollApply.calls[0].heldLines);
  });
});
