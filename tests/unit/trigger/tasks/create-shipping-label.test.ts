import { describe, expect, it } from "vitest";
import type { EasyPostRate } from "@/lib/clients/easypost-client";
import {
  assertRateDelta,
  classifyEasyPostError,
  RATE_DELTA_DEFAULTS,
  resolveSelectedRate,
} from "@/trigger/tasks/create-shipping-label";

const rate = (overrides: Partial<EasyPostRate>): EasyPostRate => ({
  id: "rate_default",
  carrier: "USPS",
  service: "Priority",
  rate: "10.00",
  delivery_days: 3,
  ...overrides,
});

describe("resolveSelectedRate (Phase 0.2 stable rate key)", () => {
  it("returns null when no selected key was provided", () => {
    const result = resolveSelectedRate([rate({})], undefined);
    expect(result.via).toBe("none");
    expect(result.rate).toBeNull();
  });

  it("matches exact carrier+service+amount even when EP rate IDs differ", () => {
    const purchaseRates = [
      rate({ id: "rate_NEW_AAA", carrier: "USPS", service: "Priority", rate: "12.34" }),
      rate({ id: "rate_NEW_BBB", carrier: "USPS", service: "First", rate: "5.00" }),
    ];
    const result = resolveSelectedRate(purchaseRates, {
      carrier: "USPS",
      service: "Priority",
      rate: 12.34,
    });
    expect(result.via).toBe("exact");
    expect(result.rate?.id).toBe("rate_NEW_AAA");
  });

  it("treats penny drift (<$0.01) as an exact match", () => {
    const result = resolveSelectedRate(
      [rate({ id: "rate_X", carrier: "USPS", service: "Priority", rate: "12.341" })],
      { carrier: "USPS", service: "Priority", rate: 12.34 },
    );
    expect(result.via).toBe("exact");
    expect(result.rate?.id).toBe("rate_X");
  });

  it("falls back to carrier+service when amount drifted past $0.01 threshold", () => {
    const result = resolveSelectedRate(
      [rate({ id: "rate_X", carrier: "USPS", service: "Priority", rate: "12.99" })],
      { carrier: "USPS", service: "Priority", rate: 12.34 },
    );
    expect(result.via).toBe("carrier_service");
    expect(result.rate?.id).toBe("rate_X");
  });

  it("returns none when neither carrier+service nor exact rate matches", () => {
    const result = resolveSelectedRate(
      [rate({ id: "rate_X", carrier: "FedEx", service: "Ground", rate: "9.00" })],
      { carrier: "USPS", service: "Priority", rate: 12.34 },
    );
    expect(result.via).toBe("none");
    expect(result.rate).toBeNull();
  });

  it("carrier comparison is case-insensitive", () => {
    const result = resolveSelectedRate(
      [rate({ id: "rate_X", carrier: "usps", service: "Priority", rate: "12.34" })],
      { carrier: "USPS", service: "Priority", rate: 12.34 },
    );
    expect(result.via).toBe("exact");
  });

  it("returns the FIRST exact match when duplicates exist (no tiebreakers)", () => {
    const purchaseRates = [
      rate({ id: "rate_FIRST", carrier: "USPS", service: "Priority", rate: "12.34" }),
      rate({ id: "rate_SECOND", carrier: "USPS", service: "Priority", rate: "12.34" }),
    ];
    const result = resolveSelectedRate(purchaseRates, {
      carrier: "USPS",
      service: "Priority",
      rate: 12.34,
    });
    // Two identical rates without tiebreakers → exact_loose (we picked one but
    // can't distinguish them from staff input).
    expect(result.via).toBe("exact_loose");
    expect(result.rate?.id).toBe("rate_FIRST");
  });

  it("uses delivery_days tiebreaker to disambiguate same carrier/service/rate", () => {
    const purchaseRates = [
      rate({ id: "rate_A", carrier: "USPS", service: "Priority", rate: "12.34", delivery_days: 2 }),
      rate({ id: "rate_B", carrier: "USPS", service: "Priority", rate: "12.34", delivery_days: 3 }),
    ];
    const result = resolveSelectedRate(purchaseRates, {
      carrier: "USPS",
      service: "Priority",
      rate: 12.34,
      deliveryDays: 3,
    });
    expect(result.via).toBe("exact");
    expect(result.rate?.id).toBe("rate_B");
  });
});

describe("assertRateDelta (Phase 0.5.2 circuit breaker)", () => {
  it("delta within $0.50 default → proceed silently", () => {
    expect(assertRateDelta(12.34, 12.5).verdict).toBe("proceed");
    expect(assertRateDelta(12.34, 12.84).verdict).toBe("proceed");
  });

  it("delta within $2.00 default → warn (still proceeds)", () => {
    const r = assertRateDelta(12.34, 14.0);
    expect(r.verdict).toBe("warn");
    expect(r.deltaUsd).toBeCloseTo(1.66, 2);
  });

  it("delta over $2.00 default → halt (caller refuses purchase)", () => {
    const r = assertRateDelta(12.34, 15.0);
    expect(r.verdict).toBe("halt");
    expect(r.deltaUsd).toBeCloseTo(2.66, 2);
  });

  it("absolute value — negative drift (price went down) is also bounded", () => {
    expect(assertRateDelta(15.0, 12.34).verdict).toBe("halt");
    expect(assertRateDelta(13.0, 12.5).verdict).toBe("proceed");
  });

  it("custom thresholds (workspace override) are respected", () => {
    expect(assertRateDelta(10, 11, { warn: 0.1, halt: 0.5 }).verdict).toBe("halt");
    expect(assertRateDelta(10, 10.05, { warn: 0.1, halt: 0.5 }).verdict).toBe("proceed");
  });

  it("default thresholds match documented values", () => {
    expect(RATE_DELTA_DEFAULTS).toEqual({ warn: 0.5, halt: 2.0 });
  });
});

describe("classifyEasyPostError (Phase 0.5.2 EP error catches)", () => {
  it("recognizes rate-invalid messages from EP", () => {
    expect(classifyEasyPostError(new Error("Rate not found"))).toBe("rate_invalid");
    expect(classifyEasyPostError(new Error("Invalid rate provided"))).toBe("rate_invalid");
    expect(classifyEasyPostError(new Error("Rate has expired"))).toBe("rate_invalid");
  });

  it("recognizes rate-unavailable messages from EP", () => {
    expect(classifyEasyPostError(new Error("No rates available"))).toBe("rate_unavailable");
    expect(classifyEasyPostError(new Error("rates unavailable for this destination"))).toBe(
      "rate_unavailable",
    );
  });

  it("classifies unknown EP errors as 'other' so default retry handling applies", () => {
    expect(classifyEasyPostError(new Error("Connection reset by peer"))).toBe("other");
    expect(classifyEasyPostError("string error")).toBe("other");
  });
});
