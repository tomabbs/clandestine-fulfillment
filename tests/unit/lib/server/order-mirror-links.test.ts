/**
 * Order Pages Transition Phase 2 — bridge worker decision tests.
 */
import { describe, expect, it } from "vitest";
import { decideMirrorLink } from "@/lib/server/order-mirror-links";

const baseDirect = {
  warehouseOrderId: "wo-1",
  workspaceId: "w1",
  orderNumber: "1001",
  customerEmail: "alice@example.com",
  totalPrice: 25,
  createdAtMs: Date.parse("2026-04-01T00:00:00Z"),
};

const baseMirror = {
  shipstationOrderId: "ss-1",
  workspaceId: "w1",
  orderNumber: "1001",
  customerEmail: "alice@example.com",
  amountPaid: 25,
  orderDateMs: Date.parse("2026-04-02T00:00:00Z"),
};

describe("decideMirrorLink", () => {
  it("returns deterministic when order_number matches AND ship window OK", () => {
    const decision = decideMirrorLink(baseDirect, baseMirror);
    expect(decision.confidence).toBe("deterministic");
    expect((decision.signals as Record<string, unknown>).order_number_match).toBe(true);
  });

  it("returns probable when order_number matches but ship window unknown", () => {
    const decision = decideMirrorLink(baseDirect, { ...baseMirror, orderDateMs: null });
    expect(decision.confidence).toBe("probable");
  });

  it("returns probable when order_number matches but ship window > 14d", () => {
    const decision = decideMirrorLink(baseDirect, {
      ...baseMirror,
      orderDateMs: Date.parse("2026-05-01T00:00:00Z"),
    });
    expect(decision.confidence).toBe("probable");
  });

  it("returns probable when email + total match within ship window (no order_number)", () => {
    const decision = decideMirrorLink(
      { ...baseDirect, orderNumber: null },
      { ...baseMirror, orderNumber: null },
    );
    expect(decision.confidence).toBe("probable");
  });

  it("returns null when nothing matches", () => {
    const decision = decideMirrorLink(
      { ...baseDirect, orderNumber: null, customerEmail: null },
      { ...baseMirror, orderNumber: null, customerEmail: null },
    );
    expect(decision.confidence).toBeNull();
  });

  it("rejects cross-workspace pairs", () => {
    const decision = decideMirrorLink(baseDirect, { ...baseMirror, workspaceId: "w2" });
    expect(decision.confidence).toBeNull();
    expect((decision.signals as Record<string, unknown>).rejected).toBe("workspace_mismatch");
  });

  it("normalizes order_number case + whitespace", () => {
    const decision = decideMirrorLink(
      { ...baseDirect, orderNumber: " 1001 " },
      { ...baseMirror, orderNumber: "1001" },
    );
    expect(decision.confidence).toBe("deterministic");
  });
});
