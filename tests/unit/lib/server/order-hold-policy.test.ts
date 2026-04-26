/**
 * Unit tests for the PURE order-hold classification policy.
 *
 * Contract pinned:
 *   - Every HoldReason is reachable from classifyOrderLine given the
 *     right OrderLineState (full coverage matrix).
 *   - Evaluation order per plan §1916–1921:
 *     1. placeholder_sku_detected
 *     2. alias + positive stock → committable
 *     3. alias + non-positive stock → non_warehouse_sku
 *     4. no alias + identity row → identity_only_match (unless fetch
 *        status escalates)
 *     5. no alias + no identity → unmapped_sku (unless fetch status
 *        escalates)
 *     6. fetch status != 'ok' AND reason would be identity_only_match
 *        or unmapped_sku → escalates to fetch_incomplete_at_match.
 *        Placeholder and non_warehouse are NOT escalated.
 *   - decideOrderHold rolls up by HOLD_REASON_PRIORITY deterministically.
 *   - decideOrderHold routes audiences correctly: clientAlert vs
 *     staffReview per HOLD_REASON_AUDIENCE.
 */

import { describe, expect, it } from "vitest";
import type { NormalizedOrderLine } from "@/lib/server/normalized-order";
import {
  buildHoldDecision,
  classifyOrderLine,
  decideOrderHold,
  HOLD_REASON_AUDIENCE,
  HOLD_REASON_PRIORITY,
  HOLD_REASONS,
  type HoldLineClassification,
  type OrderLineState,
} from "@/lib/server/order-hold-policy";

function line(overrides: Partial<NormalizedOrderLine> = {}): NormalizedOrderLine {
  return {
    remoteSku: "SKU-123",
    remoteProductId: null,
    remoteVariantId: null,
    quantity: 1,
    title: null,
    warehouseOrderItemId: "item-1",
    ...overrides,
  };
}

function state(overrides: Partial<OrderLineState> = {}): OrderLineState {
  return {
    alias: null,
    identityMatch: null,
    warehouseAvailable: null,
    latestFetchStatus: null,
    ...overrides,
  };
}

describe("HOLD_REASONS constant", () => {
  it("contains exactly the five reasons from plan §1914", () => {
    expect(new Set(HOLD_REASONS)).toEqual(
      new Set([
        "non_warehouse_sku",
        "unmapped_sku",
        "identity_only_match",
        "fetch_incomplete_at_match",
        "placeholder_sku_detected",
      ]),
    );
  });

  it("every reason has both an audience and a priority", () => {
    for (const r of HOLD_REASONS) {
      expect(HOLD_REASON_AUDIENCE[r]).toMatch(/^(clientAlert|staffReview)$/);
      expect(Number.isFinite(HOLD_REASON_PRIORITY[r])).toBe(true);
    }
  });

  it("priority mapping is an injection (no duplicate priorities)", () => {
    const priorities = HOLD_REASONS.map((r) => HOLD_REASON_PRIORITY[r]);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("audience routing matches plan §1914 severity taxonomy", () => {
    expect(HOLD_REASON_AUDIENCE.fetch_incomplete_at_match).toBe("staffReview");
    expect(HOLD_REASON_AUDIENCE.identity_only_match).toBe("staffReview");
    expect(HOLD_REASON_AUDIENCE.placeholder_sku_detected).toBe("clientAlert");
    expect(HOLD_REASON_AUDIENCE.unmapped_sku).toBe("clientAlert");
    expect(HOLD_REASON_AUDIENCE.non_warehouse_sku).toBe("clientAlert");
  });
});

describe("classifyOrderLine", () => {
  it("placeholder SKU wins over everything, even with a valid alias", () => {
    const result = classifyOrderLine(
      line({ remoteSku: "1" }),
      state({
        alias: { id: "alias-1", variantId: "variant-1" },
        warehouseAvailable: 500,
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("placeholder_sku_detected");
  });

  it("treats null remoteSku as placeholder (no SKU = no routable identity)", () => {
    const result = classifyOrderLine(line({ remoteSku: null }), state());
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("placeholder_sku_detected");
  });

  it("treats empty-string remoteSku as placeholder", () => {
    const result = classifyOrderLine(line({ remoteSku: "" }), state());
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("placeholder_sku_detected");
  });

  it("alias with positive stock → committable with alias + variant ids + stock", () => {
    const result = classifyOrderLine(
      line(),
      state({
        alias: { id: "alias-1", variantId: "variant-1" },
        warehouseAvailable: 3,
      }),
    );
    expect(result.committable).toBe(true);
    if (!result.committable) return;
    expect(result.aliasId).toBe("alias-1");
    expect(result.variantId).toBe("variant-1");
    expect(result.availableStockAtEval).toBe(3);
  });

  it("alias with zero stock → non_warehouse_sku with stock=0", () => {
    const result = classifyOrderLine(
      line(),
      state({
        alias: { id: "alias-1", variantId: "variant-1" },
        warehouseAvailable: 0,
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("non_warehouse_sku");
    expect(result.availableStockAtEval).toBe(0);
  });

  it("alias with negative stock → non_warehouse_sku preserving the negative value", () => {
    const result = classifyOrderLine(
      line(),
      state({
        alias: { id: "alias-1", variantId: "variant-1" },
        warehouseAvailable: -2,
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("non_warehouse_sku");
    expect(result.availableStockAtEval).toBe(-2);
  });

  it("alias with null stock → non_warehouse_sku with stock=null (level row missing)", () => {
    const result = classifyOrderLine(
      line(),
      state({
        alias: { id: "alias-1", variantId: "variant-1" },
        warehouseAvailable: null,
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("non_warehouse_sku");
    expect(result.availableStockAtEval).toBeNull();
  });

  it("no alias + identity row present → identity_only_match with identityMatchId", () => {
    const result = classifyOrderLine(
      line(),
      state({
        identityMatch: { id: "identity-1", variantId: "variant-9" },
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("identity_only_match");
    expect(result.identityMatchId).toBe("identity-1");
  });

  it("no alias + no identity → unmapped_sku with null identityMatchId", () => {
    const result = classifyOrderLine(line(), state());
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("unmapped_sku");
    expect(result.identityMatchId).toBeNull();
  });

  it("identity_only_match escalates to fetch_incomplete_at_match when fetch_status != 'ok'", () => {
    for (const bad of ["timeout", "auth_error", "unavailable", "unsupported", "partial"] as const) {
      const result = classifyOrderLine(
        line(),
        state({
          identityMatch: { id: "identity-1", variantId: "variant-9" },
          latestFetchStatus: bad,
        }),
      );
      expect(result.committable).toBe(false);
      if (result.committable) continue;
      expect(result.reason).toBe("fetch_incomplete_at_match");
      expect(result.identityMatchId).toBe("identity-1");
    }
  });

  it("unmapped_sku escalates to fetch_incomplete_at_match when fetch_status != 'ok'", () => {
    const result = classifyOrderLine(line(), state({ latestFetchStatus: "timeout" }));
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("fetch_incomplete_at_match");
    expect(result.identityMatchId).toBeNull();
  });

  it("fetch_status='ok' does NOT escalate identity_only_match", () => {
    const result = classifyOrderLine(
      line(),
      state({
        identityMatch: { id: "identity-1", variantId: "variant-9" },
        latestFetchStatus: "ok",
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("identity_only_match");
  });

  it("fetch_status does NOT escalate non_warehouse_sku (deterministic reason)", () => {
    const result = classifyOrderLine(
      line(),
      state({
        alias: { id: "alias-1", variantId: "variant-1" },
        warehouseAvailable: 0,
        latestFetchStatus: "timeout",
      }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("non_warehouse_sku");
  });

  it("fetch_status does NOT escalate placeholder_sku_detected", () => {
    const result = classifyOrderLine(
      line({ remoteSku: "1" }),
      state({ latestFetchStatus: "timeout" }),
    );
    expect(result.committable).toBe(false);
    if (result.committable) return;
    expect(result.reason).toBe("placeholder_sku_detected");
  });
});

describe("decideOrderHold", () => {
  function committable(id: string): HoldLineClassification {
    return {
      committable: true,
      line: line({ warehouseOrderItemId: id }),
      aliasId: `alias-${id}`,
      variantId: `variant-${id}`,
      availableStockAtEval: 10,
    };
  }
  function held(id: string, reason: (typeof HOLD_REASONS)[number]): HoldLineClassification {
    return {
      committable: false,
      line: line({ warehouseOrderItemId: id }),
      reason,
      identityMatchId: null,
      availableStockAtEval: null,
    };
  }

  it("all committable → shouldHold=false, holdReason=null, no alerts", () => {
    const decision = decideOrderHold([committable("a"), committable("b")]);
    expect(decision.shouldHold).toBe(false);
    expect(decision.holdReason).toBeNull();
    expect(decision.affectedLines).toEqual([]);
    expect(decision.committableLines).toHaveLength(2);
    expect(decision.clientAlertRequired).toBe(false);
    expect(decision.staffReviewRequired).toBe(false);
  });

  it("empty classifications → shouldHold=false", () => {
    const decision = decideOrderHold([]);
    expect(decision.shouldHold).toBe(false);
    expect(decision.holdReason).toBeNull();
  });

  it("picks non_warehouse_sku over identity_only_match by priority", () => {
    const decision = decideOrderHold([
      held("a", "identity_only_match"),
      held("b", "non_warehouse_sku"),
    ]);
    expect(decision.shouldHold).toBe(true);
    expect(decision.holdReason).toBe("non_warehouse_sku");
    expect(decision.affectedLines).toHaveLength(2);
  });

  it("picks unmapped_sku over fetch_incomplete_at_match by priority", () => {
    const decision = decideOrderHold([
      held("a", "fetch_incomplete_at_match"),
      held("b", "unmapped_sku"),
    ]);
    expect(decision.holdReason).toBe("unmapped_sku");
  });

  it("picks placeholder_sku_detected over identity_only_match by priority", () => {
    const decision = decideOrderHold([
      held("a", "identity_only_match"),
      held("b", "placeholder_sku_detected"),
    ]);
    expect(decision.holdReason).toBe("placeholder_sku_detected");
  });

  it("mixed client+staff reasons → both alert flags true", () => {
    const decision = decideOrderHold([
      held("a", "non_warehouse_sku"),
      held("b", "identity_only_match"),
    ]);
    expect(decision.clientAlertRequired).toBe(true);
    expect(decision.staffReviewRequired).toBe(true);
  });

  it("only staff reason → only staffReviewRequired", () => {
    const decision = decideOrderHold([held("a", "fetch_incomplete_at_match")]);
    expect(decision.clientAlertRequired).toBe(false);
    expect(decision.staffReviewRequired).toBe(true);
  });

  it("only client reason → only clientAlertRequired", () => {
    const decision = decideOrderHold([held("a", "non_warehouse_sku")]);
    expect(decision.clientAlertRequired).toBe(true);
    expect(decision.staffReviewRequired).toBe(false);
  });

  it("committableLines preserved alongside affectedLines in mixed orders", () => {
    const decision = decideOrderHold([
      committable("a"),
      held("b", "non_warehouse_sku"),
      committable("c"),
    ]);
    expect(decision.shouldHold).toBe(true);
    expect(decision.committableLines).toHaveLength(2);
    expect(decision.affectedLines).toHaveLength(1);
    expect(decision.affectedLines[0].reason).toBe("non_warehouse_sku");
  });

  it("is deterministic — same input always picks the same holdReason", () => {
    const inputs: HoldLineClassification[] = [
      held("a", "identity_only_match"),
      held("b", "non_warehouse_sku"),
      held("c", "unmapped_sku"),
    ];
    const a = decideOrderHold(inputs);
    const b = decideOrderHold(inputs);
    const c = decideOrderHold([...inputs].reverse());
    expect(a.holdReason).toBe("non_warehouse_sku");
    expect(b.holdReason).toBe("non_warehouse_sku");
    expect(c.holdReason).toBe("non_warehouse_sku");
  });
});

describe("buildHoldDecision", () => {
  it("wraps decideOrderHold and carries orderId/connectionId/source", () => {
    const result = buildHoldDecision({
      order: {
        workspaceId: "ws-1",
        orgId: "org-1",
        connectionId: "conn-1",
        platform: "shopify",
        remoteOrderId: "remote-1",
        source: "poll",
        lines: [],
        warehouseOrderId: "order-1",
        orderCreatedAt: null,
      },
      classifications: [
        {
          committable: false,
          line: line(),
          reason: "non_warehouse_sku",
          identityMatchId: null,
          availableStockAtEval: 0,
        },
      ],
    });
    expect(result.shouldHold).toBe(true);
    expect(result.holdReason).toBe("non_warehouse_sku");
    expect(result.orderId).toBe("order-1");
    expect(result.connectionId).toBe("conn-1");
    expect(result.source).toBe("poll");
  });
});
