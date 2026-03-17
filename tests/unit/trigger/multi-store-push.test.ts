import { describe, expect, it } from "vitest";
import { isEchoOrder } from "@/trigger/tasks/client-store-order-detect";
import {
  computeFreshnessState,
  shouldRetryConnection,
} from "@/trigger/tasks/multi-store-inventory-push";

describe("computeFreshnessState (Rule #71)", () => {
  it("returns 'fresh' when pushed less than 5 minutes ago", () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(computeFreshnessState(twoMinAgo)).toBe("fresh");
  });

  it("returns 'delayed' when pushed 5-30 minutes ago", () => {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    expect(computeFreshnessState(fifteenMinAgo)).toBe("delayed");
  });

  it("returns 'stale' when pushed more than 30 minutes ago", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(computeFreshnessState(oneHourAgo)).toBe("stale");
  });

  it("returns 'stale' when never pushed", () => {
    expect(computeFreshnessState(null)).toBe("stale");
  });
});

describe("shouldRetryConnection (Rule #53 circuit breaker)", () => {
  it("always retries when no previous failures", () => {
    expect(shouldRetryConnection(0, null)).toBe(true);
  });

  it("stops retrying after 5 consecutive failures", () => {
    expect(shouldRetryConnection(5, new Date().toISOString())).toBe(false);
    expect(shouldRetryConnection(10, new Date().toISOString())).toBe(false);
  });

  it("respects exponential backoff (1min, 2min, 4min, 8min, 16min)", () => {
    // 1 failure: 1 minute backoff
    const thirtySecAgo = new Date(Date.now() - 30_000).toISOString();
    expect(shouldRetryConnection(1, thirtySecAgo)).toBe(false);

    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(shouldRetryConnection(1, twoMinAgo)).toBe(true);

    // 2 failures: 2 minute backoff
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    expect(shouldRetryConnection(2, oneMinAgo)).toBe(false);

    const threeMinAgo = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(shouldRetryConnection(2, threeMinAgo)).toBe(true);
  });

  it("retries if no lastErrorAt recorded", () => {
    expect(shouldRetryConnection(3, null)).toBe(true);
  });
});

describe("isEchoOrder (Rule #65 echo cancellation)", () => {
  it("detects echo when all line item quantities match last_pushed_quantity", () => {
    const lineItems = [
      { sku: "VINYL-001", quantity: 50 },
      { sku: "CD-002", quantity: 100 },
    ];
    const lastPushed = new Map([
      ["VINYL-001", 50],
      ["CD-002", 100],
    ]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(true);
  });

  it("returns false when quantities differ", () => {
    const lineItems = [{ sku: "VINYL-001", quantity: 48 }];
    const lastPushed = new Map([["VINYL-001", 50]]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(false);
  });

  it("returns false when SKU has no last_pushed_quantity", () => {
    const lineItems = [{ sku: "NEW-SKU", quantity: 10 }];
    const lastPushed = new Map<string, number>();

    expect(isEchoOrder(lineItems, lastPushed)).toBe(false);
  });

  it("returns false for empty line items", () => {
    const lastPushed = new Map([["VINYL-001", 50]]);
    expect(isEchoOrder([], lastPushed)).toBe(false);
  });

  it("requires ALL items to match for echo detection", () => {
    const lineItems = [
      { sku: "VINYL-001", quantity: 50 },
      { sku: "CD-002", quantity: 99 },
    ];
    const lastPushed = new Map([
      ["VINYL-001", 50],
      ["CD-002", 100],
    ]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(false);
  });
});
