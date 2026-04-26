/**
 * Orchestration tests for `evaluateOrderForHold`.
 *
 * The pure policy is exhaustively tested in `order-hold-policy.test.ts`;
 * this file only covers the async orchestrator's responsibilities:
 *
 *   1. Builds the alias/identity lookup maps keyed on `remote_sku`.
 *   2. Fetches warehouse stock only for variants referenced by a
 *      matched alias (no wasted lookups).
 *   3. Fetches latest fetch_status only for variants referenced by a
 *      matched identity.
 *   4. Passes null fetch_status for a variant we've never evaluated
 *      (so pure classifier does NOT escalate to
 *      `fetch_incomplete_at_match`).
 *   5. Skips all lookups when every line is placeholder/null SKU
 *      (fast-path for SKU-AUTO-3 ingest hot path).
 *   6. DB errors on any of the four queries bubble up as
 *      `ok: false, reason: 'db_error'`.
 */

import { describe, expect, it } from "vitest";
import type { NormalizedClientStoreOrder } from "@/lib/server/normalized-order";
import { evaluateOrderForHold } from "@/lib/server/order-hold-evaluator";

type Reply<T> = { data: T; error: unknown };

interface TableReplies {
  client_store_sku_mappings?: Reply<unknown>;
  client_store_product_identity_matches?: Reply<unknown>;
  warehouse_inventory_levels?: Reply<unknown>;
  sku_autonomous_decisions?: Reply<unknown>;
}

interface CallRecord {
  table: string;
  filters: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
  ordered?: string;
}

function stubSupabase(replies: TableReplies): {
  client: { from: (table: string) => unknown };
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];

  function builder(table: string, reply: Reply<unknown> | undefined) {
    const filters: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    let orderKey: string | undefined;
    const b: {
      select: (cols: string) => typeof b;
      eq: (col: string, val: unknown) => typeof b;
      in: (col: string, vals: unknown[]) => typeof b;
      order: (col: string, opts?: unknown) => typeof b;
      then: (onfulfilled: (value: Reply<unknown>) => unknown) => Promise<unknown>;
    } = {
      select: () => b,
      eq: (col, val) => {
        filters.push([col, val]);
        return b;
      },
      in: (col, vals) => {
        ins.push([col, vals]);
        return b;
      },
      order: (col) => {
        orderKey = col;
        return b;
      },
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mimic Supabase PostgREST builder
      then: (onfulfilled) => {
        calls.push({ table, filters, ins, ordered: orderKey });
        if (!reply) {
          throw new Error(`stub: table ${table} queried but no reply configured`);
        }
        return Promise.resolve(reply).then(onfulfilled);
      },
    };
    return b;
  }

  return {
    client: {
      from: (table: string) => builder(table, replies[table as keyof TableReplies]),
    },
    calls,
  };
}

function order(overrides: Partial<NormalizedClientStoreOrder> = {}): NormalizedClientStoreOrder {
  return {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId: "conn-1",
    platform: "shopify",
    remoteOrderId: "remote-1",
    source: "poll",
    warehouseOrderId: "order-1",
    orderCreatedAt: null,
    lines: [
      {
        remoteSku: "SKU-A",
        remoteProductId: null,
        remoteVariantId: null,
        quantity: 1,
        title: "Line A",
        warehouseOrderItemId: "item-a",
      },
    ],
    ...overrides,
  };
}

describe("evaluateOrderForHold — orchestration", () => {
  it("happy path: alias + positive stock → committable, no hold", async () => {
    const { client, calls } = stubSupabase({
      client_store_sku_mappings: {
        data: [
          {
            id: "alias-1",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-1",
            is_active: true,
          },
        ],
        error: null,
      },
      client_store_product_identity_matches: { data: [], error: null },
      warehouse_inventory_levels: {
        data: [{ variant_id: "variant-1", available: 5 }],
        error: null,
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.shouldHold).toBe(false);
    expect(result.decision.committableLines).toHaveLength(1);
    expect(result.decision.committableLines[0].aliasId).toBe("alias-1");
    expect(result.decision.committableLines[0].availableStockAtEval).toBe(5);
    // Fetch-status lookup SHOULD NOT have run (no identity match)
    expect(calls.filter((c) => c.table === "sku_autonomous_decisions")).toHaveLength(0);
  });

  it("alias + zero stock → non_warehouse_sku hold", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: {
        data: [
          {
            id: "alias-1",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-1",
            is_active: true,
          },
        ],
        error: null,
      },
      client_store_product_identity_matches: { data: [], error: null },
      warehouse_inventory_levels: {
        data: [{ variant_id: "variant-1", available: 0 }],
        error: null,
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.shouldHold).toBe(true);
    expect(result.decision.holdReason).toBe("non_warehouse_sku");
    expect(result.decision.clientAlertRequired).toBe(true);
  });

  it("no alias + identity row + fetch_status='ok' → identity_only_match", async () => {
    const { client, calls } = stubSupabase({
      client_store_sku_mappings: { data: [], error: null },
      client_store_product_identity_matches: {
        data: [
          {
            id: "identity-1",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-9",
            is_active: true,
            outcome_state: "auto_database_identity_match",
          },
        ],
        error: null,
      },
      sku_autonomous_decisions: {
        data: [
          {
            variant_id: "variant-9",
            fetch_status: "ok",
            fetch_completed_at: "2026-04-26T12:00:00Z",
          },
        ],
        error: null,
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.shouldHold).toBe(true);
    expect(result.decision.holdReason).toBe("identity_only_match");
    expect(result.decision.staffReviewRequired).toBe(true);
    // Inventory lookup SHOULD NOT have run (no alias)
    expect(calls.filter((c) => c.table === "warehouse_inventory_levels")).toHaveLength(0);
  });

  it("no alias + identity row + fetch_status='timeout' → fetch_incomplete_at_match", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: { data: [], error: null },
      client_store_product_identity_matches: {
        data: [
          {
            id: "identity-1",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-9",
            is_active: true,
            outcome_state: "auto_database_identity_match",
          },
        ],
        error: null,
      },
      sku_autonomous_decisions: {
        data: [
          {
            variant_id: "variant-9",
            fetch_status: "timeout",
            fetch_completed_at: "2026-04-26T12:00:00Z",
          },
        ],
        error: null,
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.holdReason).toBe("fetch_incomplete_at_match");
    expect(result.decision.staffReviewRequired).toBe(true);
  });

  it("no alias + no identity → unmapped_sku; fetch_status lookup skipped", async () => {
    const { client, calls } = stubSupabase({
      client_store_sku_mappings: { data: [], error: null },
      client_store_product_identity_matches: { data: [], error: null },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.holdReason).toBe("unmapped_sku");
    expect(result.decision.clientAlertRequired).toBe(true);
    expect(calls.filter((c) => c.table === "sku_autonomous_decisions")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "warehouse_inventory_levels")).toHaveLength(0);
  });

  it("placeholder SKU on every line → zero lookups run (fast path)", async () => {
    const { client, calls } = stubSupabase({});
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order({
        lines: [
          {
            remoteSku: "1",
            remoteProductId: null,
            remoteVariantId: null,
            quantity: 1,
            title: null,
            warehouseOrderItemId: "item-a",
          },
          {
            remoteSku: null,
            remoteProductId: null,
            remoteVariantId: null,
            quantity: 2,
            title: null,
            warehouseOrderItemId: "item-b",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.holdReason).toBe("placeholder_sku_detected");
    expect(calls.length).toBe(0);
  });

  it("mixed order: committable line + non_warehouse line → shouldHold=true with both lists populated", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: {
        data: [
          {
            id: "alias-a",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-a",
            is_active: true,
          },
          {
            id: "alias-b",
            connection_id: "conn-1",
            remote_sku: "SKU-B",
            variant_id: "variant-b",
            is_active: true,
          },
        ],
        error: null,
      },
      client_store_product_identity_matches: { data: [], error: null },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "variant-a", available: 10 },
          { variant_id: "variant-b", available: 0 },
        ],
        error: null,
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order({
        lines: [
          {
            remoteSku: "SKU-A",
            remoteProductId: null,
            remoteVariantId: null,
            quantity: 1,
            title: null,
            warehouseOrderItemId: "item-a",
          },
          {
            remoteSku: "SKU-B",
            remoteProductId: null,
            remoteVariantId: null,
            quantity: 2,
            title: null,
            warehouseOrderItemId: "item-b",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.shouldHold).toBe(true);
    expect(result.decision.holdReason).toBe("non_warehouse_sku");
    expect(result.decision.committableLines).toHaveLength(1);
    expect(result.decision.committableLines[0].aliasId).toBe("alias-a");
    expect(result.decision.affectedLines).toHaveLength(1);
    expect(result.decision.affectedLines[0].reason).toBe("non_warehouse_sku");
  });

  it("alias query error surfaces as db_error", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: { data: null, error: { message: "timeout" } },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.detail).toContain("timeout");
  });

  it("identity query error surfaces as db_error", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: { data: [], error: null },
      client_store_product_identity_matches: {
        data: null,
        error: { message: "boom" },
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
  });

  it("inventory query error surfaces as db_error", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: {
        data: [
          {
            id: "alias-1",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-1",
            is_active: true,
          },
        ],
        error: null,
      },
      client_store_product_identity_matches: { data: [], error: null },
      warehouse_inventory_levels: { data: null, error: { message: "pg down" } },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.detail).toContain("pg down");
  });

  it("fetch_status query error surfaces as db_error", async () => {
    const { client } = stubSupabase({
      client_store_sku_mappings: { data: [], error: null },
      client_store_product_identity_matches: {
        data: [
          {
            id: "identity-1",
            connection_id: "conn-1",
            remote_sku: "SKU-A",
            variant_id: "variant-9",
            is_active: true,
            outcome_state: "auto_database_identity_match",
          },
        ],
        error: null,
      },
      sku_autonomous_decisions: {
        data: null,
        error: { message: "permission denied" },
      },
    });
    const result = await evaluateOrderForHold(
      // biome-ignore lint/suspicious/noExplicitAny: test-only structural stub
      client as any,
      order(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.detail).toContain("permission denied");
  });
});
