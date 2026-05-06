import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireStaff = vi.fn();
const mockCommitOrderItems = vi.fn();
const mockReleaseOrderItems = vi.fn();
const mockRecordInventoryChange = vi.fn();

type QueryResult = { data?: unknown; error?: { message: string } | null };

const responses = new Map<string, QueryResult[]>();
const inserts: Array<{ table: string; row: unknown }> = [];
const updates: Array<{ table: string; patch: unknown }> = [];

function enqueue(table: string, result: QueryResult) {
  const queue = responses.get(table) ?? [];
  queue.push(result);
  responses.set(table, queue);
}

function take(table: string): QueryResult {
  const queue = responses.get(table) ?? [];
  return queue.shift() ?? { data: null, error: null };
}

function chain(table: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    select: () => chain(table),
    eq: () => chain(table),
    in: () => chain(table),
    maybeSingle: () => Promise.resolve(take(table)),
    single: () => Promise.resolve(take(table)),
    insert: (row: unknown) => {
      inserts.push({ table, row });
      return chain(table);
    },
    update: (patch: unknown) => {
      updates.push({ table, patch });
      return chain(table);
    },
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike.
    then: (resolve: (value: QueryResult) => unknown) => resolve(take(table)),
  };
  return obj;
}

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: () => mockRequireStaff(),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => chain(table),
  }),
}));

vi.mock("@/lib/server/inventory-commitments", () => ({
  commitOrderItems: (...args: unknown[]) => mockCommitOrderItems(...args),
  releaseOrderItems: (...args: unknown[]) => mockReleaseOrderItems(...args),
}));

vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: (...args: unknown[]) => mockRecordInventoryChange(...args),
}));

import { createLabelOrder, fulfillLabelOrder, voidLabelOrder } from "@/actions/label-orders";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

describe("label-orders actions", () => {
  beforeEach(() => {
    responses.clear();
    inserts.length = 0;
    updates.length = 0;
    vi.clearAllMocks();
    mockRequireStaff.mockResolvedValue({ userId: "user-1", workspaceId: WORKSPACE_ID });
    mockCommitOrderItems.mockResolvedValue({ inserted: 1, alreadyOpen: [] });
    mockReleaseOrderItems.mockResolvedValue({ released: 1 });
    mockRecordInventoryChange.mockResolvedValue({
      success: true,
      newQuantity: 4,
      alreadyProcessed: false,
    });
  });

  it("creates a warehouse label order, opens commitments, and decrements once per line", async () => {
    enqueue("warehouse_product_variants", {
      data: [
        {
          id: "variant-1",
          sku: "LABEL-LP",
          title: "LP",
          price: 10,
          warehouse_inventory_levels: [{ available: 7 }],
          warehouse_products: { org_id: ORG_ID, title: "Album" },
        },
      ],
    });
    enqueue("warehouse_orders", { data: { id: ORDER_ID, order_number: "LABEL-1" } });
    enqueue("warehouse_order_items", {
      data: [{ id: "item-1", sku: "LABEL-LP", quantity: 2 }],
    });

    const result = await createLabelOrder({
      orgId: ORG_ID,
      orderNumber: "LABEL-1",
      items: [{ sku: "LABEL-LP", quantity: 2 }],
    });

    expect(result.orderId).toBe(ORDER_ID);
    expect(inserts.find((entry) => entry.table === "warehouse_orders")?.row).toMatchObject({
      source: "label_order",
      fulfillment_status: "submitted",
    });
    expect(mockCommitOrderItems).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        orderId: ORDER_ID,
        items: [{ sku: "LABEL-LP", qty: 2 }],
      }),
    );
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "LABEL-LP",
        delta: -2,
        source: "label_order",
        correlationId: `label-order:${ORDER_ID}:item-1`,
      }),
    );
  });

  it("fulfills by releasing commitments without a second decrement", async () => {
    enqueue("warehouse_orders", {
      data: {
        id: ORDER_ID,
        order_number: "LABEL-1",
        source: "label_order",
        fulfillment_status: "submitted",
        identity_resolution_notes: {},
      },
    });
    enqueue("warehouse_orders", { data: null, error: null });

    await fulfillLabelOrder({ orderId: ORDER_ID, reason: "picked up" });

    expect(mockReleaseOrderItems).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, orderId: ORDER_ID }),
    );
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(updates.find((entry) => entry.table === "warehouse_orders")?.patch).toMatchObject({
      fulfillment_status: "fulfilled",
    });
  });

  it("voids by releasing commitments and re-crediting with stable correlation ids", async () => {
    enqueue("warehouse_orders", {
      data: {
        id: ORDER_ID,
        order_number: "LABEL-1",
        source: "label_order",
        fulfillment_status: "submitted",
        identity_resolution_notes: {},
      },
    });
    enqueue("warehouse_order_items", {
      data: [{ id: "item-1", sku: "LABEL-LP", quantity: 2 }],
    });
    enqueue("warehouse_orders", { data: null, error: null });

    await voidLabelOrder({ orderId: ORDER_ID, reason: "client cancelled" });

    expect(mockReleaseOrderItems).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, orderId: ORDER_ID }),
    );
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "LABEL-LP",
        delta: 2,
        source: "label_order",
        correlationId: `label-order-void:${ORDER_ID}:item-1`,
      }),
    );
  });
});
