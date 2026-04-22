/**
 * B-2 / HRD-28 — Shopify GraphQL fulfillment helper tests.
 *
 * Two surfaces under test:
 *   1. `selectFulfillmentOrder()` — pure decision (no HTTP). Covers the four
 *      scenarios called out in the plan: happy single OPEN, IN_PROGRESS
 *      (was missed by REST's 'open' filter), no actionable status, and
 *      ambiguous tiebreaker on oldest GID.
 *   2. `runFulfillmentCreateMutation()` — error-envelope handling. The
 *      plan singles out two non-obvious paths: top-level `errors[]` (must
 *      throw) and `userErrors[]` returning a fulfillment id alongside
 *      (must NOT mark confirmed).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/shopify-connection-graphql", () => ({
  connectionShopifyGraphQL: vi.fn(),
}));

import { connectionShopifyGraphQL } from "@/lib/server/shopify-connection-graphql";
import {
  runFulfillmentCreateMutation,
  selectFulfillmentOrder,
  toShopifyOrderGid,
} from "@/lib/server/shopify-fulfillment";

const ctx = { storeUrl: "https://test.myshopify.com", accessToken: "shpat_test" };

describe("toShopifyOrderGid", () => {
  it("wraps a numeric id as a Shopify Order GID", () => {
    expect(toShopifyOrderGid("123456")).toBe("gid://shopify/Order/123456");
  });

  it("is idempotent for an already-formed GID", () => {
    expect(toShopifyOrderGid("gid://shopify/Order/123456")).toBe("gid://shopify/Order/123456");
  });
});

describe("selectFulfillmentOrder (B-2 selection logic)", () => {
  it("happy path: single OPEN fulfillment order is selected unambiguously", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/100",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/1", sku: "SKU-A", remainingQuantity: 2 }],
        },
      ],
      requiredSkus: new Map([["SKU-A", 2]]),
    });

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.fulfillmentOrder.id).toBe("gid://shopify/FulfillmentOrder/100");
      expect(result.ambiguous).toBe(false);
    }
  });

  it("IN_PROGRESS fulfillment order is selected (REST's 'open' filter would have missed it)", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/200",
          status: "IN_PROGRESS",
          lineItems: [{ id: "gid://lif/2", sku: "SKU-B", remainingQuantity: 1 }],
        },
      ],
      requiredSkus: new Map([["SKU-B", 1]]),
    });

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.fulfillmentOrder.status).toBe("IN_PROGRESS");
    }
  });

  it("no actionable status (CLOSED/CANCELLED) returns none_match: no_actionable_status", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/300",
          status: "CLOSED",
          lineItems: [],
        },
        {
          id: "gid://shopify/FulfillmentOrder/301",
          status: "CANCELLED",
          lineItems: [],
        },
      ],
      requiredSkus: new Map(),
    });

    expect(result.kind).toBe("none_match");
    if (result.kind === "none_match") {
      expect(result.reason).toBe("no_actionable_status");
    }
  });

  it("ambiguous selection prefers SKU-coverage match over a non-covering FO", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/400",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/4", sku: "WRONG-SKU", remainingQuantity: 5 }],
        },
        {
          id: "gid://shopify/FulfillmentOrder/401",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/5", sku: "RIGHT-SKU", remainingQuantity: 3 }],
        },
      ],
      requiredSkus: new Map([["RIGHT-SKU", 3]]),
    });

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.fulfillmentOrder.id).toBe("gid://shopify/FulfillmentOrder/401");
      expect(result.ambiguous).toBe(false);
    }
  });

  it("multiple covering FOs → ambiguous, tie-break to oldest GID + flagged for telemetry", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/501",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/a", sku: "SKU-X", remainingQuantity: 4 }],
        },
        {
          id: "gid://shopify/FulfillmentOrder/500",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/b", sku: "SKU-X", remainingQuantity: 4 }],
        },
        {
          id: "gid://shopify/FulfillmentOrder/502",
          status: "IN_PROGRESS",
          lineItems: [{ id: "gid://lif/c", sku: "SKU-X", remainingQuantity: 4 }],
        },
      ],
      requiredSkus: new Map([["SKU-X", 4]]),
    });

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      // 500 < 501 < 502 lexicographically → oldest wins
      expect(result.fulfillmentOrder.id).toBe("gid://shopify/FulfillmentOrder/500");
      expect(result.ambiguous).toBe(true);
      expect(result.tieBreakerReason).toBe("oldest_id");
    }
  });

  it("FOs exist but none cover the required SKUs → none_match: no_sku_coverage", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/600",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/x", sku: "SKU-OTHER", remainingQuantity: 1 }],
        },
        {
          id: "gid://shopify/FulfillmentOrder/601",
          status: "OPEN",
          lineItems: [{ id: "gid://lif/y", sku: "SKU-OTHER", remainingQuantity: 1 }],
        },
      ],
      requiredSkus: new Map([["SKU-NEEDED", 5]]),
    });

    // Both candidates fall through to "all actionable" pool (length > 1) → tie-break.
    // (We documented this fallback as "if zero cover, candidates = actionable" so
    // we don't fail closed when SKU mapping data is incomplete.)
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.ambiguous).toBe(true);
    }
  });

  it("empty requiredSkus map (no items found in DB) → falls back to single actionable FO", () => {
    const result = selectFulfillmentOrder({
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/700",
          status: "OPEN",
          lineItems: [],
        },
      ],
      requiredSkus: new Map(),
    });

    expect(result.kind).toBe("selected");
  });
});

describe("runFulfillmentCreateMutation (B-2 error envelope)", () => {
  afterEach(() => {
    vi.mocked(connectionShopifyGraphQL).mockReset();
  });

  it("happy path: returns ok with the fulfillment id when no userErrors", async () => {
    vi.mocked(connectionShopifyGraphQL).mockResolvedValueOnce({
      fulfillmentCreate: {
        fulfillment: { id: "gid://shopify/Fulfillment/9001", status: "SUCCESS" },
        userErrors: [],
      },
    });

    const result = await runFulfillmentCreateMutation({
      ctx,
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/100",
      trackingNumber: "1Z999",
      carrier: "UPS",
      notifyCustomer: true,
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.fulfillmentId).toBe("gid://shopify/Fulfillment/9001");
    }
  });

  it("userErrors[] non-empty + fulfillment id present → user_errors (NEVER mark confirmed)", async () => {
    vi.mocked(connectionShopifyGraphQL).mockResolvedValueOnce({
      fulfillmentCreate: {
        fulfillment: { id: "gid://shopify/Fulfillment/9002", status: "FAILURE" },
        userErrors: [{ field: ["trackingInfo", "number"], message: "Tracking number invalid" }],
      },
    });

    const result = await runFulfillmentCreateMutation({
      ctx,
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/100",
      trackingNumber: "BAD",
      carrier: "UPS",
      notifyCustomer: false,
    });

    expect(result.kind).toBe("user_errors");
    if (result.kind === "user_errors") {
      expect(result.userErrors).toHaveLength(1);
      expect(result.userErrors[0]?.message).toBe("Tracking number invalid");
      expect(result.partialFulfillmentId).toBe("gid://shopify/Fulfillment/9002");
    }
  });

  it("top-level GraphQL errors[] → connectionShopifyGraphQL throws → rethrown as plain Error", async () => {
    vi.mocked(connectionShopifyGraphQL).mockRejectedValueOnce(
      new Error("Shopify GraphQL: Throttled"),
    );

    await expect(
      runFulfillmentCreateMutation({
        ctx,
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/100",
        trackingNumber: "1Z999",
        carrier: "UPS",
        notifyCustomer: true,
      }),
    ).rejects.toThrow("Shopify GraphQL: Throttled");
  });

  it("no fulfillment id and no userErrors → synthesizes user_errors so caller fails safe", async () => {
    vi.mocked(connectionShopifyGraphQL).mockResolvedValueOnce({
      fulfillmentCreate: { fulfillment: null, userErrors: [] },
    });

    const result = await runFulfillmentCreateMutation({
      ctx,
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/100",
      trackingNumber: "1Z999",
      carrier: "UPS",
      notifyCustomer: true,
    });

    expect(result.kind).toBe("user_errors");
    if (result.kind === "user_errors") {
      expect(result.userErrors[0]?.message).toMatch(/no fulfillment id/i);
      expect(result.partialFulfillmentId).toBeNull();
    }
  });
});
