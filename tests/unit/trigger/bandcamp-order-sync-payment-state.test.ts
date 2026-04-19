import { describe, expect, it } from "vitest";
import { mapBandcampPaymentState } from "@/trigger/tasks/bandcamp-order-sync";

describe("mapBandcampPaymentState (Phase 0.4)", () => {
  it("'paid' → 'paid'", () => {
    expect(mapBandcampPaymentState("paid")).toBe("paid");
  });

  it("'PAID' → 'paid' (case-insensitive)", () => {
    expect(mapBandcampPaymentState("PAID")).toBe("paid");
  });

  it("'refunded' → 'refunded'", () => {
    expect(mapBandcampPaymentState("refunded")).toBe("refunded");
  });

  it("'partially_refunded' → 'refunded'", () => {
    expect(mapBandcampPaymentState("partially_refunded")).toBe("refunded");
  });

  it("'failed' → 'pending' (do NOT auto-fulfill failed payments)", () => {
    expect(mapBandcampPaymentState("failed")).toBe("pending");
  });

  it("'pending' → 'pending'", () => {
    expect(mapBandcampPaymentState("pending")).toBe("pending");
  });

  it("null → 'pending' (conservative default)", () => {
    expect(mapBandcampPaymentState(null)).toBe("pending");
  });

  it("undefined → 'pending' (conservative default)", () => {
    expect(mapBandcampPaymentState(undefined)).toBe("pending");
  });

  it("unknown state → 'pending' (never silently accept as paid)", () => {
    expect(mapBandcampPaymentState("disputed")).toBe("pending");
    expect(mapBandcampPaymentState("chargeback")).toBe("pending");
  });

  it("trims whitespace before mapping", () => {
    expect(mapBandcampPaymentState("  paid  ")).toBe("paid");
  });
});
