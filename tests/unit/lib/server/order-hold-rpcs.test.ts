/**
 * Unit tests — applyOrderFulfillmentHold + releaseOrderFulfillmentHold
 * (Phase 3.B, release gates SKU-AUTO-15 / SKU-AUTO-17 / SKU-AUTO-21 /
 * SKU-AUTO-22 / SKU-AUTO-32).
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Order hold RPC contract".
 *
 * Coverage:
 *   * Pre-RPC validation gates:
 *       - applyOrderFulfillmentHold rejects non-whitelist reasons
 *         without calling the RPC.
 *       - applyOrderFulfillmentHold rejects empty cycleId without
 *         calling the RPC.
 *       - releaseOrderFulfillmentHold rejects non-whitelist resolution
 *         codes without calling the RPC.
 *       - releaseOrderFulfillmentHold rejects staff_override without
 *         a note (and with a whitespace-only note).
 *   * Happy paths:
 *       - applyOrderFulfillmentHold returns parsed {holdEventId,
 *         commitsInserted} and forwards args with defaults.
 *       - applyOrderFulfillmentHold sanitizes invalid commitLines
 *         (non-string sku, non-positive qty, non-integer qty) before
 *         forwarding to the RPC.
 *       - applyOrderFulfillmentHold flags idempotent=true when
 *         commits_inserted=0 but commitLines were supplied (retry).
 *       - applyOrderFulfillmentHold forwards custom actorKind/actorId/
 *         metadata.
 *       - releaseOrderFulfillmentHold returns the scalar uuid from the
 *         RPC response (all three shapes: string, array-of-string,
 *         array-of-object).
 *   * Error mapping:
 *       - RPC error message → typed reason for apply (invalid reason,
 *         cycle conflict, order_not_found, order_cancelled, generic
 *         rpc_error).
 *       - RPC error message → typed reason for release (invalid code,
 *         staff_override note, order_not_found, order_not_on_hold,
 *         cycle_id_corrupt, generic rpc_error).
 *   * Pure predicates:
 *       - isApplyHoldReason / isReleaseResolutionCode positive + negative.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApplyOrderFulfillmentHoldInput,
  applyOrderFulfillmentHold,
  type HoldRpcClient,
  isApplyHoldReason,
  isReleaseResolutionCode,
  type ReleaseOrderFulfillmentHoldInput,
  releaseOrderFulfillmentHold,
} from "@/lib/server/order-hold-rpcs";

// ──────────────────────────────────────────────────────────────────────
// Mock supabase
// ──────────────────────────────────────────────────────────────────────

interface MockRpcSetup {
  data?: unknown;
  error?: { message: string } | null;
}

function makeMockRpc(setup: MockRpcSetup = {}): {
  client: HoldRpcClient;
  rpc: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn(async () => ({
    data: setup.data ?? null,
    error: setup.error ?? null,
  }));
  return { client: { rpc } as HoldRpcClient, rpc };
}

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

function baseApplyInput(
  overrides: Partial<ApplyOrderFulfillmentHoldInput> = {},
): ApplyOrderFulfillmentHoldInput {
  return {
    orderId: "order-1",
    connectionId: "conn-1",
    reason: "unknown_remote_sku",
    cycleId: "cycle-1",
    heldLines: [{ line_item_id: "li-1", remote_sku: "UNK-1", qty: 2 }],
    commitLines: [{ sku: "WAR-1", qty: 1 }],
    ...overrides,
  };
}

function baseReleaseInput(
  overrides: Partial<ReleaseOrderFulfillmentHoldInput> = {},
): ReleaseOrderFulfillmentHoldInput {
  return {
    orderId: "order-1",
    resolutionCode: "alias_learned",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Pure predicates
// ──────────────────────────────────────────────────────────────────────

describe("isApplyHoldReason", () => {
  it("accepts every whitelisted reason", () => {
    for (const reason of [
      "unknown_remote_sku",
      "placeholder_remote_sku",
      "non_warehouse_match",
      "fetch_incomplete_at_match",
    ]) {
      expect(isApplyHoldReason(reason)).toBe(true);
    }
  });

  it("rejects any other string", () => {
    for (const reason of ["", "all_lines_warehouse_ready", "random", "UNKNOWN_REMOTE_SKU"]) {
      expect(isApplyHoldReason(reason)).toBe(false);
    }
  });
});

describe("isReleaseResolutionCode", () => {
  it("accepts every whitelisted resolution code", () => {
    for (const code of [
      "staff_override",
      "fetch_recovered_evaluator_passed",
      "alias_learned",
      "manual_sku_fix",
      "order_cancelled",
    ]) {
      expect(isReleaseResolutionCode(code)).toBe(true);
    }
  });

  it("rejects any other string", () => {
    for (const code of ["", "auto_fix", "manual", "STAFF_OVERRIDE"]) {
      expect(isReleaseResolutionCode(code)).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// applyOrderFulfillmentHold — pre-RPC gates
// ──────────────────────────────────────────────────────────────────────

describe("applyOrderFulfillmentHold — pre-RPC validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid reason without calling the RPC", async () => {
    const { client, rpc } = makeMockRpc();
    const r = await applyOrderFulfillmentHold(
      client,
      baseApplyInput({ reason: "all_lines_warehouse_ready" as never }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_hold_reason");
      expect(r.detail).toBe("all_lines_warehouse_ready");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an empty cycleId without calling the RPC", async () => {
    const { client, rpc } = makeMockRpc();
    const r = await applyOrderFulfillmentHold(client, baseApplyInput({ cycleId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_cycle_id");
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// applyOrderFulfillmentHold — happy paths
// ──────────────────────────────────────────────────────────────────────

describe("applyOrderFulfillmentHold — happy paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards args with sensible defaults and parses the TABLE result", async () => {
    const { client, rpc } = makeMockRpc({
      data: [{ hold_event_id: "evt-1", commits_inserted: 1 }],
    });

    const r = await applyOrderFulfillmentHold(client, baseApplyInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.holdEventId).toBe("evt-1");
      expect(r.commitsInserted).toBe(1);
      expect(r.idempotent).toBe(false);
    }

    expect(rpc).toHaveBeenCalledWith("apply_order_fulfillment_hold", {
      p_order_id: "order-1",
      p_connection_id: "conn-1",
      p_reason: "unknown_remote_sku",
      p_cycle_id: "cycle-1",
      p_held_lines: [{ line_item_id: "li-1", remote_sku: "UNK-1", qty: 2 }],
      p_commit_lines: [{ sku: "WAR-1", qty: 1 }],
      p_actor_kind: "system",
      p_actor_id: null,
      p_metadata: {},
    });
  });

  it("parses the bare-object RPC response too", async () => {
    const { client } = makeMockRpc({
      data: { hold_event_id: "evt-2", commits_inserted: 0 },
    });
    const r = await applyOrderFulfillmentHold(client, baseApplyInput({ commitLines: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.holdEventId).toBe("evt-2");
      expect(r.commitsInserted).toBe(0);
      // No commit lines supplied → not idempotent-on-retry, just empty.
      expect(r.idempotent).toBe(false);
    }
  });

  it("flags idempotent=true when commitLines were supplied but RPC inserted 0", async () => {
    const { client } = makeMockRpc({
      data: [{ hold_event_id: "evt-3", commits_inserted: 0 }],
    });
    const r = await applyOrderFulfillmentHold(
      client,
      baseApplyInput({ commitLines: [{ sku: "WAR-1", qty: 1 }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idempotent).toBe(true);
  });

  it("sanitizes invalid commitLines before forwarding (empty sku, zero qty, fractional qty)", async () => {
    const { client, rpc } = makeMockRpc({
      data: [{ hold_event_id: "evt-4", commits_inserted: 1 }],
    });
    const r = await applyOrderFulfillmentHold(
      client,
      baseApplyInput({
        commitLines: [
          { sku: "WAR-1", qty: 2 },
          { sku: "", qty: 1 },
          { sku: "WAR-2", qty: 0 },
          { sku: "WAR-3", qty: -1 },
          { sku: "WAR-4", qty: 1.5 },
          { sku: "WAR-5", qty: Number.NaN },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_commit_lines).toEqual([{ sku: "WAR-1", qty: 2 }]);
  });

  it("forwards custom actorKind / actorId / metadata", async () => {
    const { client, rpc } = makeMockRpc({
      data: [{ hold_event_id: "evt-5", commits_inserted: 0 }],
    });
    await applyOrderFulfillmentHold(
      client,
      baseApplyInput({
        actorKind: "recovery_task",
        actorId: "user-7",
        metadata: { source: "webhook" },
      }),
    );
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_actor_kind).toBe("recovery_task");
    expect(args.p_actor_id).toBe("user-7");
    expect(args.p_metadata).toEqual({ source: "webhook" });
  });
});

// ──────────────────────────────────────────────────────────────────────
// applyOrderFulfillmentHold — RPC error mapping
// ──────────────────────────────────────────────────────────────────────

describe("applyOrderFulfillmentHold — RPC error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  const cases: Array<{ message: string; reason: string }> = [
    {
      message: "apply_order_fulfillment_hold: invalid hold reason all_lines_warehouse_ready",
      reason: "invalid_hold_reason",
    },
    {
      message: "apply_order_fulfillment_hold: p_cycle_id is required",
      reason: "missing_cycle_id",
    },
    {
      message: "apply_order_fulfillment_hold: order 00000000-0000-0000-0000-000000000001 not found",
      reason: "order_not_found",
    },
    {
      message:
        "apply_order_fulfillment_hold: order 00000000-0000-0000-0000-000000000001 is cancelled; cannot hold",
      reason: "order_cancelled",
    },
    {
      message:
        "apply_order_fulfillment_hold: order 00000000-0000-0000-0000-000000000001 already on_hold with cycle abc, caller supplied def",
      reason: "cycle_id_conflict",
    },
    {
      message: "apply_order_fulfillment_hold: something else went wrong",
      reason: "rpc_error",
    },
  ];

  for (const { message, reason } of cases) {
    it(`maps "${message.slice(0, 40)}..." → ${reason}`, async () => {
      const { client } = makeMockRpc({ error: { message } });
      const r = await applyOrderFulfillmentHold(client, baseApplyInput());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        expect(r.detail).toBe(message);
      }
    });
  }

  it("maps a null/empty RPC response to unexpected_response_shape", async () => {
    const { client } = makeMockRpc({ data: null });
    const r = await applyOrderFulfillmentHold(client, baseApplyInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("maps a malformed response row (missing hold_event_id) to unexpected_response_shape", async () => {
    const { client } = makeMockRpc({
      data: [{ commits_inserted: 1 }],
    });
    const r = await applyOrderFulfillmentHold(client, baseApplyInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("maps a malformed commits_inserted (non-number) to unexpected_response_shape", async () => {
    const { client } = makeMockRpc({
      data: [{ hold_event_id: "evt-6", commits_inserted: "1" }],
    });
    const r = await applyOrderFulfillmentHold(client, baseApplyInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });
});

// ──────────────────────────────────────────────────────────────────────
// releaseOrderFulfillmentHold — pre-RPC gates
// ──────────────────────────────────────────────────────────────────────

describe("releaseOrderFulfillmentHold — pre-RPC validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid resolution code without calling the RPC", async () => {
    const { client, rpc } = makeMockRpc();
    const r = await releaseOrderFulfillmentHold(
      client,
      baseReleaseInput({ resolutionCode: "auto_fix" as never }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_resolution_code");
      expect(r.detail).toBe("auto_fix");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects staff_override with no note", async () => {
    const { client, rpc } = makeMockRpc();
    const r = await releaseOrderFulfillmentHold(
      client,
      baseReleaseInput({ resolutionCode: "staff_override" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("staff_override_missing_note");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects staff_override with whitespace-only note", async () => {
    const { client, rpc } = makeMockRpc();
    const r = await releaseOrderFulfillmentHold(
      client,
      baseReleaseInput({ resolutionCode: "staff_override", note: "   \n\t  " }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("staff_override_missing_note");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows staff_override with a non-empty note", async () => {
    const { client, rpc } = makeMockRpc({ data: "evt-release-1" });
    const r = await releaseOrderFulfillmentHold(
      client,
      baseReleaseInput({ resolutionCode: "staff_override", note: "Customer called" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holdEventId).toBe("evt-release-1");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// releaseOrderFulfillmentHold — happy paths + response shapes
// ──────────────────────────────────────────────────────────────────────

describe("releaseOrderFulfillmentHold — response shape tolerance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses bare-string RPC response", async () => {
    const { client } = makeMockRpc({ data: "evt-r-string" });
    const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holdEventId).toBe("evt-r-string");
  });

  it("parses array-of-string response", async () => {
    const { client } = makeMockRpc({ data: ["evt-r-array"] });
    const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holdEventId).toBe("evt-r-array");
  });

  it("parses array-of-object named-property response", async () => {
    const { client } = makeMockRpc({
      data: [{ release_order_fulfillment_hold: "evt-r-obj" }],
    });
    const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holdEventId).toBe("evt-r-obj");
  });

  it("parses bare-object named-property response", async () => {
    const { client } = makeMockRpc({
      data: { release_order_fulfillment_hold: "evt-r-scalar-obj" },
    });
    const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holdEventId).toBe("evt-r-scalar-obj");
  });

  it("null response → unexpected_response_shape", async () => {
    const { client } = makeMockRpc({ data: null });
    const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("empty string response → unexpected_response_shape", async () => {
    const { client } = makeMockRpc({ data: "" });
    const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unexpected_response_shape");
  });

  it("forwards args with defaults", async () => {
    const { client, rpc } = makeMockRpc({ data: "evt-r-7" });
    await releaseOrderFulfillmentHold(
      client,
      baseReleaseInput({
        resolutionCode: "manual_sku_fix",
        note: "fixed mapping",
        actorKind: "user",
        actorId: "user-42",
        metadata: { ticket: "OPS-123" },
      }),
    );
    expect(rpc).toHaveBeenCalledWith("release_order_fulfillment_hold", {
      p_order_id: "order-1",
      p_resolution_code: "manual_sku_fix",
      p_note: "fixed mapping",
      p_actor_kind: "user",
      p_actor_id: "user-42",
      p_metadata: { ticket: "OPS-123" },
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// releaseOrderFulfillmentHold — RPC error mapping
// ──────────────────────────────────────────────────────────────────────

describe("releaseOrderFulfillmentHold — RPC error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  const cases: Array<{ message: string; reason: string }> = [
    {
      message: "release_order_fulfillment_hold: invalid resolution_code auto_fix",
      reason: "invalid_resolution_code",
    },
    {
      message: "release_order_fulfillment_hold: staff_override requires a note",
      reason: "staff_override_missing_note",
    },
    {
      message:
        "release_order_fulfillment_hold: order 00000000-0000-0000-0000-000000000001 not found",
      reason: "order_not_found",
    },
    {
      message:
        "release_order_fulfillment_hold: order 00000000-0000-0000-0000-000000000001 is in state no_hold, cannot release",
      reason: "order_not_on_hold",
    },
    {
      message:
        "release_order_fulfillment_hold: order 00000000-0000-0000-0000-000000000001 is on_hold but cycle_id is NULL (data corruption)",
      reason: "cycle_id_corrupt",
    },
    {
      message: "release_order_fulfillment_hold: unknown failure",
      reason: "rpc_error",
    },
  ];

  for (const { message, reason } of cases) {
    it(`maps "${message.slice(0, 40)}..." → ${reason}`, async () => {
      const { client } = makeMockRpc({ error: { message } });
      const r = await releaseOrderFulfillmentHold(client, baseReleaseInput());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        expect(r.detail).toBe(message);
      }
    });
  }
});
