import { describe, expect, it } from "vitest";
import { isEchoOrder } from "@/trigger/tasks/client-store-order-detect";

describe("client-store-order-detect: echo detection (Rule #65)", () => {
  it("identifies echo when webhook quantity matches last pushed for all SKUs", () => {
    const lineItems = [
      { sku: "LP-001", quantity: 25 },
      { sku: "LP-002", quantity: 50 },
    ];
    const lastPushed = new Map([
      ["LP-001", 25],
      ["LP-002", 50],
    ]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(true);
  });

  it("does not flag real orders where quantities differ from last push", () => {
    const lineItems = [
      { sku: "LP-001", quantity: 23 }, // 2 sold since push
    ];
    const lastPushed = new Map([["LP-001", 25]]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(false);
  });

  it("does not flag orders with unmapped SKUs", () => {
    const lineItems = [{ sku: "UNKNOWN-SKU", quantity: 5 }];
    const lastPushed = new Map([["LP-001", 25]]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(false);
  });

  it("handles mixed: one SKU matches, another differs → not echo", () => {
    const lineItems = [
      { sku: "LP-001", quantity: 25 },
      { sku: "LP-002", quantity: 48 },
    ];
    const lastPushed = new Map([
      ["LP-001", 25],
      ["LP-002", 50],
    ]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(false);
  });

  it("handles single-item order that is an echo", () => {
    const lineItems = [{ sku: "CD-001", quantity: 100 }];
    const lastPushed = new Map([["CD-001", 100]]);

    expect(isEchoOrder(lineItems, lastPushed)).toBe(true);
  });
});
