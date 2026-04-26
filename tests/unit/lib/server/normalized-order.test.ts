/**
 * Unit tests for the PURE `normalized-order` adapter (no DB I/O).
 *
 * The adapter is the Phase 2 contract that both webhook ingest and
 * poll ingest must converge on (plan §1884–1908, release gate
 * SKU-AUTO-3). These tests pin the invariants the rest of Phase 2
 * (hold evaluator, ranker) will rely on:
 *
 *   1. Platform gating — only shopify|woocommerce|squarespace produce
 *      `ok:true`. Bandcamp/discogs/manual always fail with
 *      `unsupported_platform`.
 *   2. Platform↔connection consistency — if the order's source and the
 *      connection's platform disagree, the adapter refuses rather than
 *      emitting a cross-platform normalized order.
 *   3. Null remote SKU is PRESERVED, not coerced. The hold evaluator
 *      needs `null` vs `""` to distinguish `unmapped_sku` from
 *      `placeholder_sku` (plan §1919 step 2).
 *   4. Lines with quantity <= 0 are DROPPED (zero-qty refund rows),
 *      but an order with zero SURVIVING lines fails with `no_lines`.
 *   5. Output line order is deterministic (sorted by item id) — the
 *      SKU-AUTO-3 reference fixture asserts webhook and poll paths
 *      produce byte-identical orders.
 *   6. `NormalizeWebhookOrderFromLines` filters zero-qty lines
 *      symmetrically to `buildNormalizedOrder`.
 */

import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_MATCHING_PLATFORMS,
  buildNormalizedOrder,
  isAutonomousMatchingPlatform,
  normalizeWebhookOrderFromLines,
  type RawWarehouseOrderItemRow,
  type RawWarehouseOrderRow,
} from "@/lib/server/normalized-order";

function orderRow(overrides: Partial<RawWarehouseOrderRow> = {}): RawWarehouseOrderRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_id: "ws-1",
    org_id: "org-1",
    external_order_id: "remote-order-123",
    source: "shopify",
    created_at: "2026-04-26T12:00:00.000Z",
    ...overrides,
  };
}

function itemRow(
  id: string,
  overrides: Partial<RawWarehouseOrderItemRow> = {},
): RawWarehouseOrderItemRow {
  return {
    id,
    sku: "SKU-A",
    quantity: 2,
    title: "Item A",
    shopify_line_item_id: "shopify-line-1",
    ...overrides,
  };
}

describe("isAutonomousMatchingPlatform", () => {
  it("accepts the three supported platforms", () => {
    expect(AUTONOMOUS_MATCHING_PLATFORMS).toEqual(["shopify", "woocommerce", "squarespace"]);
    expect(isAutonomousMatchingPlatform("shopify")).toBe(true);
    expect(isAutonomousMatchingPlatform("woocommerce")).toBe(true);
    expect(isAutonomousMatchingPlatform("squarespace")).toBe(true);
  });

  it("rejects bandcamp, discogs, manual, null, undefined, empty", () => {
    expect(isAutonomousMatchingPlatform("bandcamp")).toBe(false);
    expect(isAutonomousMatchingPlatform("discogs")).toBe(false);
    expect(isAutonomousMatchingPlatform("manual")).toBe(false);
    expect(isAutonomousMatchingPlatform(null)).toBe(false);
    expect(isAutonomousMatchingPlatform(undefined)).toBe(false);
    expect(isAutonomousMatchingPlatform("")).toBe(false);
  });
});

describe("buildNormalizedOrder", () => {
  const connection = {
    id: "conn-1",
    workspace_id: "ws-1",
    org_id: "org-1",
    platform: "shopify" as const,
  };

  it("happy path: shopify order with two lines normalizes cleanly", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [
        itemRow("00000000-0000-0000-0000-000000000002"),
        itemRow("00000000-0000-0000-0000-000000000003", {
          sku: "SKU-B",
          quantity: 1,
          title: "Item B",
        }),
      ],
      connection,
      source: "poll",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.workspaceId).toBe("ws-1");
    expect(result.order.orgId).toBe("org-1");
    expect(result.order.connectionId).toBe("conn-1");
    expect(result.order.platform).toBe("shopify");
    expect(result.order.remoteOrderId).toBe("remote-order-123");
    expect(result.order.source).toBe("poll");
    expect(result.order.warehouseOrderId).toBe("00000000-0000-0000-0000-000000000001");
    expect(result.order.lines).toHaveLength(2);
    expect(result.order.lines[0].remoteSku).toBe("SKU-A");
    expect(result.order.lines[0].quantity).toBe(2);
    expect(result.order.lines[1].remoteSku).toBe("SKU-B");
  });

  it("rejects unsupported platforms (bandcamp, manual)", () => {
    for (const bad of ["bandcamp", "manual", "discogs", null, "unknown"]) {
      const result = buildNormalizedOrder({
        orderRow: orderRow({ source: bad as string | null }),
        orderItemRows: [itemRow("id-1")],
        connection,
        source: "poll",
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("unsupported_platform");
    }
  });

  it("rejects when connection platform disagrees with order source", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow({ source: "woocommerce" }),
      orderItemRows: [itemRow("id-1")],
      connection: { ...connection, platform: "shopify" },
      source: "poll",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_connection");
    expect(result.detail ?? "").toContain("connection.platform=shopify");
  });

  it("returns missing_connection when connection is null", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [itemRow("id-1")],
      connection: null,
      source: "poll",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_connection");
  });

  it("returns order_not_found when external_order_id is null", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow({ external_order_id: null }),
      orderItemRows: [itemRow("id-1")],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("order_not_found");
  });

  it("preserves null remoteSku (NOT coerced to empty string)", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [itemRow("id-1", { sku: null })],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines[0].remoteSku).toBeNull();
  });

  it("drops lines with quantity <= 0 and NaN, keeps positive integer lines", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [
        itemRow("id-1", { quantity: 0 }),
        itemRow("id-2", { quantity: -3 }),
        itemRow("id-3", { quantity: Number.NaN }),
        itemRow("id-4", { quantity: 2, sku: "SKU-KEEP" }),
      ],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines).toHaveLength(1);
    expect(result.order.lines[0].remoteSku).toBe("SKU-KEEP");
  });

  it("floors fractional quantities (Shopify occasionally emits floats on refunds)", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [itemRow("id-1", { quantity: 2.9 })],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines[0].quantity).toBe(2);
  });

  it("returns no_lines when every item has quantity <= 0", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [itemRow("id-1", { quantity: 0 }), itemRow("id-2", { quantity: -1 })],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_lines");
  });

  it("returns no_lines when items array is empty", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_lines");
  });

  it("sorts lines deterministically by warehouse_order_items.id", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [
        itemRow("zzz-id", { sku: "SKU-Z" }),
        itemRow("aaa-id", { sku: "SKU-A" }),
        itemRow("mmm-id", { sku: "SKU-M" }),
      ],
      connection,
      source: "poll",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines.map((l) => l.warehouseOrderItemId)).toEqual([
      "aaa-id",
      "mmm-id",
      "zzz-id",
    ]);
  });

  it("carries source='webhook' and leaves warehouseOrderItemId null-capable", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [itemRow("id-1")],
      connection,
      source: "webhook",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.source).toBe("webhook");
  });

  it("carries source='recovery' for hold-recheck path", () => {
    const result = buildNormalizedOrder({
      orderRow: orderRow(),
      orderItemRows: [itemRow("id-1")],
      connection,
      source: "recovery",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.source).toBe("recovery");
  });
});

describe("normalizeWebhookOrderFromLines", () => {
  const baseArgs = {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId: "conn-1",
    platform: "woocommerce" as const,
    remoteOrderId: "woo-12345",
  };

  it("produces a webhook-sourced normalized order with no internal ids", () => {
    const result = normalizeWebhookOrderFromLines({
      ...baseArgs,
      lines: [
        { remoteSku: "SKU-A", quantity: 1, title: "A" },
        { remoteSku: "SKU-B", quantity: 3, remoteProductId: "p-2" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.source).toBe("webhook");
    expect(result.order.warehouseOrderId).toBeNull();
    expect(result.order.orderCreatedAt).toBeNull();
    expect(result.order.lines).toHaveLength(2);
    expect(result.order.lines[0].warehouseOrderItemId).toBeNull();
    expect(result.order.lines[1].remoteProductId).toBe("p-2");
  });

  it("drops zero-qty lines symmetrically with buildNormalizedOrder", () => {
    const result = normalizeWebhookOrderFromLines({
      ...baseArgs,
      lines: [
        { remoteSku: "SKU-A", quantity: 0 },
        { remoteSku: "SKU-B", quantity: 2 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines).toHaveLength(1);
    expect(result.order.lines[0].remoteSku).toBe("SKU-B");
  });

  it("returns no_lines when all lines are zero-qty", () => {
    const result = normalizeWebhookOrderFromLines({
      ...baseArgs,
      lines: [{ remoteSku: "SKU-A", quantity: 0 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_lines");
  });

  it("preserves optional remoteProductId / remoteVariantId / title / null sku", () => {
    const result = normalizeWebhookOrderFromLines({
      ...baseArgs,
      lines: [
        {
          remoteSku: null,
          remoteProductId: "p-123",
          remoteVariantId: "v-456",
          quantity: 1,
          title: "Variant X",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.order.lines[0];
    expect(line.remoteSku).toBeNull();
    expect(line.remoteProductId).toBe("p-123");
    expect(line.remoteVariantId).toBe("v-456");
    expect(line.title).toBe("Variant X");
  });
});
