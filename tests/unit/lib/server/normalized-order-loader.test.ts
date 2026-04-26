/**
 * Unit tests for `loadNormalizedOrder`.
 *
 * This is the thin DB-wrapper around the pure `buildNormalizedOrder`
 * adapter. The pure adapter is exhaustively covered in
 * `normalized-order.test.ts`; these tests focus on loader-only
 * responsibilities:
 *
 *   - warehouse_orders row missing → `order_not_found`
 *   - connection lookup returns zero rows → `missing_connection`
 *   - connection lookup returns >=2 rows with same status →
 *     `ambiguous_connection` (safety net for the single-active-
 *     connection-per-platform invariant)
 *   - connection lookup returns >=2 rows with exactly one active →
 *     picks the active one
 *   - DB errors on any fetch are mapped to deterministic failure
 *     reasons (no exceptions bubble out)
 *   - happy path: full order hydrates into NormalizedClientStoreOrder
 *     with the correct `source` from options.
 */

import { describe, expect, it } from "vitest";
import { loadNormalizedOrder } from "@/lib/server/normalized-order-loader";

type Reply<T> = { data: T; error: unknown };

/**
 * Builds a minimal stub that responds to the exact chain
 * `.from(table).select(...).eq(...).eq(...).[in(...)].maybeSingle()` /
 * `.from(table).select(...).eq(...)` used by the loader.
 *
 * Each call to `from(table)` takes the NEXT configured reply from the
 * queue keyed by table name. Supports:
 *   - warehouse_orders: returns a single-row `maybeSingle` reply.
 *   - client_store_connections: returns a multi-row `await` reply.
 *   - warehouse_order_items: returns a multi-row `await` reply.
 */
function stubSupabase(replies: {
  warehouseOrders: Reply<unknown>;
  connections: Reply<unknown>;
  warehouseOrderItems?: Reply<unknown>;
}): {
  client: {
    from: (table: string) => unknown;
  };
  calls: Array<{
    table: string;
    filters: Array<[string, unknown]>;
    ins: Array<[string, unknown[]]>;
  }>;
} {
  const calls: Array<{
    table: string;
    filters: Array<[string, unknown]>;
    ins: Array<[string, unknown[]]>;
  }> = [];

  function makeBuilder(table: string, thenableReply: Reply<unknown>) {
    const state = {
      filters: [] as Array<[string, unknown]>,
      ins: [] as Array<[string, unknown[]]>,
    };
    const builder: {
      select: (cols: string) => typeof builder;
      eq: (col: string, val: unknown) => typeof builder;
      in: (col: string, vals: unknown[]) => typeof builder;
      maybeSingle: () => Promise<Reply<unknown>>;
      then: (onfulfilled: (value: Reply<unknown>) => unknown) => Promise<unknown>;
    } = {
      select: () => builder,
      eq: (col, val) => {
        state.filters.push([col, val]);
        return builder;
      },
      in: (col, vals) => {
        state.ins.push([col, vals]);
        return builder;
      },
      maybeSingle: async () => thenableReply,
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mimic Supabase PostgREST builder
      then: (onfulfilled) => {
        calls.push({ table, filters: state.filters, ins: state.ins });
        return Promise.resolve(thenableReply).then(onfulfilled);
      },
    };
    return builder;
  }

  return {
    client: {
      from: (table: string) => {
        if (table === "warehouse_orders") {
          const b = makeBuilder(table, replies.warehouseOrders);
          const original = b.maybeSingle;
          b.maybeSingle = async () => {
            calls.push({ table, filters: [], ins: [] });
            return original();
          };
          return b;
        }
        if (table === "client_store_connections") {
          return makeBuilder(table, replies.connections);
        }
        if (table === "warehouse_order_items") {
          if (!replies.warehouseOrderItems) {
            throw new Error("stub: warehouse_order_items fetch triggered but no reply configured");
          }
          return makeBuilder(table, replies.warehouseOrderItems);
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
    calls,
  };
}

describe("loadNormalizedOrder", () => {
  const baseOptions = { source: "poll" as const };

  it("returns order_not_found when orderId is empty", async () => {
    const { client } = stubSupabase({
      warehouseOrders: { data: null, error: null },
      connections: { data: [], error: null },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("order_not_found");
  });

  it("returns order_not_found when warehouse_orders lookup returns no row", async () => {
    const { client } = stubSupabase({
      warehouseOrders: { data: null, error: null },
      connections: { data: [], error: null },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "missing-id",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("order_not_found");
  });

  it("returns order_not_found when warehouse_orders returns an error", async () => {
    const { client } = stubSupabase({
      warehouseOrders: { data: null, error: { message: "connection reset" } },
      connections: { data: [], error: null },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "any-id",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("order_not_found");
    expect(result.detail ?? "").toContain("connection reset");
  });

  it("returns unsupported_platform when order.source is not in the three platforms", async () => {
    const { client } = stubSupabase({
      warehouseOrders: {
        data: {
          id: "order-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          external_order_id: "bc-123",
          source: "bandcamp",
          created_at: "2026-04-26T12:00:00.000Z",
        },
        error: null,
      },
      connections: { data: [], error: null },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "order-1",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_platform");
  });

  it("returns missing_connection when zero connections match", async () => {
    const { client } = stubSupabase({
      warehouseOrders: {
        data: {
          id: "order-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          external_order_id: "sh-123",
          source: "shopify",
          created_at: null,
        },
        error: null,
      },
      connections: { data: [], error: null },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "order-1",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_connection");
  });

  it("returns ambiguous_connection when multiple active connections match the same platform", async () => {
    const { client } = stubSupabase({
      warehouseOrders: {
        data: {
          id: "order-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          external_order_id: "sh-123",
          source: "shopify",
          created_at: null,
        },
        error: null,
      },
      connections: {
        data: [
          {
            id: "conn-a",
            workspace_id: "ws-1",
            org_id: "org-1",
            platform: "shopify",
            connection_status: "active",
            last_webhook_at: "2026-04-26T10:00:00.000Z",
            last_poll_at: null,
          },
          {
            id: "conn-b",
            workspace_id: "ws-1",
            org_id: "org-1",
            platform: "shopify",
            connection_status: "active",
            last_webhook_at: "2026-04-26T11:00:00.000Z",
            last_poll_at: null,
          },
        ],
        error: null,
      },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "order-1",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous_connection");
  });

  it("picks the single active connection when one degraded + one active are returned", async () => {
    const { client } = stubSupabase({
      warehouseOrders: {
        data: {
          id: "order-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          external_order_id: "sh-123",
          source: "shopify",
          created_at: "2026-04-26T12:00:00.000Z",
        },
        error: null,
      },
      connections: {
        data: [
          {
            id: "conn-degraded",
            workspace_id: "ws-1",
            org_id: "org-1",
            platform: "shopify",
            connection_status: "degraded",
            last_webhook_at: null,
            last_poll_at: null,
          },
          {
            id: "conn-active",
            workspace_id: "ws-1",
            org_id: "org-1",
            platform: "shopify",
            connection_status: "active",
            last_webhook_at: null,
            last_poll_at: null,
          },
        ],
        error: null,
      },
      warehouseOrderItems: {
        data: [
          {
            id: "item-1",
            sku: "SKU-A",
            quantity: 2,
            title: "A",
            shopify_line_item_id: "line-1",
          },
        ],
        error: null,
      },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "order-1",
      baseOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.connectionId).toBe("conn-active");
  });

  it("happy path: hydrates order + items + connection into a normalized order", async () => {
    const { client, calls } = stubSupabase({
      warehouseOrders: {
        data: {
          id: "order-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          external_order_id: "sh-123",
          source: "shopify",
          created_at: "2026-04-26T12:00:00.000Z",
        },
        error: null,
      },
      connections: {
        data: [
          {
            id: "conn-1",
            workspace_id: "ws-1",
            org_id: "org-1",
            platform: "shopify",
            connection_status: "active",
            last_webhook_at: "2026-04-26T11:00:00.000Z",
            last_poll_at: null,
          },
        ],
        error: null,
      },
      warehouseOrderItems: {
        data: [
          {
            id: "item-z",
            sku: "SKU-Z",
            quantity: 1,
            title: "Z",
            shopify_line_item_id: "line-z",
          },
          {
            id: "item-a",
            sku: "SKU-A",
            quantity: 2,
            title: "A",
            shopify_line_item_id: "line-a",
          },
        ],
        error: null,
      },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "order-1",
      { source: "recovery" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.source).toBe("recovery");
    expect(result.order.workspaceId).toBe("ws-1");
    expect(result.order.connectionId).toBe("conn-1");
    expect(result.order.remoteOrderId).toBe("sh-123");
    expect(result.order.warehouseOrderId).toBe("order-1");
    expect(result.order.lines.map((l) => l.remoteSku)).toEqual(["SKU-A", "SKU-Z"]);

    const tablesTouched = calls.map((c) => c.table);
    expect(tablesTouched).toContain("warehouse_orders");
    expect(tablesTouched).toContain("client_store_connections");
    expect(tablesTouched).toContain("warehouse_order_items");
  });

  it("returns no_lines when warehouse_order_items query errors", async () => {
    const { client } = stubSupabase({
      warehouseOrders: {
        data: {
          id: "order-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          external_order_id: "sh-123",
          source: "shopify",
          created_at: null,
        },
        error: null,
      },
      connections: {
        data: [
          {
            id: "conn-1",
            workspace_id: "ws-1",
            org_id: "org-1",
            platform: "shopify",
            connection_status: "active",
            last_webhook_at: null,
            last_poll_at: null,
          },
        ],
        error: null,
      },
      warehouseOrderItems: { data: null, error: { message: "pg timeout" } },
    });
    const result = await loadNormalizedOrder(
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to the structural stub
      client as any,
      "order-1",
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_lines");
    expect(result.detail ?? "").toContain("pg timeout");
  });
});
