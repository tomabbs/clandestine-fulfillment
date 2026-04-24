/**
 * Phase 5 §9.6 D1 — inventory-commitments helper contract.
 *
 * The Postgres trigger (`sync_committed_quantity()`) is exercised by
 * the migration's invariants — this suite pins the *application-side*
 * behavior:
 *   - Aggregating duplicate SKUs into one upsert row (so the partial
 *     unique index doesn't reject the second copy and silently
 *     undercount).
 *   - Filtering non-positive quantities (matches the CHECK > 0
 *     constraint without raising on legitimate zero-qty payload lines).
 *   - Reporting `inserted` vs `alreadyOpen` diagnostics so webhook
 *     retries are observable.
 *   - Releasing only-open rows (a second cancel webhook is a no-op).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface UpsertCall {
  rows: Array<{
    workspace_id: string;
    sku: string;
    source: string;
    source_id: string;
    qty: number;
    metadata: Record<string, unknown>;
  }>;
  options: { onConflict?: string; ignoreDuplicates?: boolean };
}

interface UpdateCall {
  patch: Record<string, unknown>;
  filters: Array<{ kind: string; col: string; val: unknown }>;
}

let upsertCalls: UpsertCall[];
let upsertNextResult: { data: Array<{ sku: string }> | null; error: { message: string } | null };
let updateCalls: UpdateCall[];
let updateNextResult: { data: Array<{ id: string }> | null; error: { message: string } | null };

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (_table: string) => ({
      upsert: (rows: UpsertCall["rows"], options: UpsertCall["options"]) => {
        upsertCalls.push({ rows, options });
        return {
          select: () => Promise.resolve(upsertNextResult),
        };
      },
      update: (patch: Record<string, unknown>) => {
        const filters: UpdateCall["filters"] = [];
        const builder: Record<string, unknown> = {};
        const chain = {
          eq(col: string, val: unknown) {
            filters.push({ kind: "eq", col, val });
            return chain;
          },
          is(col: string, val: unknown) {
            filters.push({ kind: "is", col, val });
            return chain;
          },
          in(col: string, val: unknown) {
            filters.push({ kind: "in", col, val });
            return chain;
          },
          select() {
            updateCalls.push({ patch, filters });
            return Promise.resolve(updateNextResult);
          },
        };
        Object.assign(builder, chain);
        return chain;
      },
    }),
  }),
}));

import { commitInventory, releaseInventory } from "@/lib/server/inventory-commitments";

describe("commitInventory", () => {
  beforeEach(() => {
    upsertCalls = [];
    upsertNextResult = { data: [], error: null };
  });

  it("inserts one row per (sku, qty) and reports inserted count", async () => {
    upsertNextResult = { data: [{ sku: "SKU-A" }, { sku: "SKU-B" }], error: null };
    const result = await commitInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-123",
      items: [
        { sku: "SKU-A", qty: 2 },
        { sku: "SKU-B", qty: 1 },
      ],
    });
    expect(result).toEqual({ inserted: 2, alreadyOpen: [] });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].rows).toEqual([
      {
        workspace_id: "ws-1",
        sku: "SKU-A",
        source: "order",
        source_id: "order-123",
        qty: 2,
        metadata: {},
      },
      {
        workspace_id: "ws-1",
        sku: "SKU-B",
        source: "order",
        source_id: "order-123",
        qty: 1,
        metadata: {},
      },
    ]);
    expect(upsertCalls[0].options).toEqual({
      onConflict: "workspace_id,source,source_id,sku",
      ignoreDuplicates: true,
    });
  });

  it("aggregates duplicate SKUs into one row at the summed qty", async () => {
    upsertNextResult = { data: [{ sku: "SKU-A" }], error: null };
    await commitInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-123",
      items: [
        { sku: "SKU-A", qty: 2 },
        { sku: "SKU-A", qty: 3 },
        { sku: "SKU-A", qty: 1 },
      ],
    });
    expect(upsertCalls[0].rows).toEqual([
      {
        workspace_id: "ws-1",
        sku: "SKU-A",
        source: "order",
        source_id: "order-123",
        qty: 6,
        metadata: {},
      },
    ]);
  });

  it("filters non-positive quantities and empty SKUs without raising", async () => {
    upsertNextResult = { data: [{ sku: "SKU-A" }], error: null };
    await commitInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-1",
      items: [
        { sku: "SKU-A", qty: 1 },
        { sku: "SKU-B", qty: 0 },
        { sku: "SKU-C", qty: -3 },
        { sku: "", qty: 5 },
      ],
    });
    expect(upsertCalls[0].rows).toHaveLength(1);
    expect(upsertCalls[0].rows[0].sku).toBe("SKU-A");
  });

  it("returns inserted=0 alreadyOpen=[] without I/O when items are empty", async () => {
    const result = await commitInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-1",
      items: [],
    });
    expect(result).toEqual({ inserted: 0, alreadyOpen: [] });
    expect(upsertCalls).toHaveLength(0);
  });

  it("reports already-open SKUs when the unique index swallows a duplicate insert", async () => {
    upsertNextResult = { data: [{ sku: "SKU-A" }], error: null };
    const result = await commitInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-1",
      items: [
        { sku: "SKU-A", qty: 1 },
        { sku: "SKU-B", qty: 1 },
        { sku: "SKU-C", qty: 1 },
      ],
    });
    expect(result.inserted).toBe(1);
    expect(result.alreadyOpen.sort()).toEqual(["SKU-B", "SKU-C"]);
  });

  it("propagates Supabase errors with a context-bearing message", async () => {
    upsertNextResult = { data: null, error: { message: "permission denied" } };
    await expect(
      commitInventory({
        workspaceId: "ws-1",
        source: "order",
        sourceId: "order-1",
        items: [{ sku: "SKU-A", qty: 1 }],
      }),
    ).rejects.toThrow(/commitInventory upsert failed: permission denied/);
  });

  it("forwards metadata to every row in the batch", async () => {
    upsertNextResult = { data: [{ sku: "SKU-A" }, { sku: "SKU-B" }], error: null };
    await commitInventory({
      workspaceId: "ws-1",
      source: "cart",
      sourceId: "cart-xyz",
      items: [
        { sku: "SKU-A", qty: 1 },
        { sku: "SKU-B", qty: 1 },
      ],
      metadata: { triggered_by: "checkout-2" },
    });
    expect(upsertCalls[0].rows.every((r) => r.metadata.triggered_by === "checkout-2")).toBe(true);
  });
});

describe("releaseInventory", () => {
  beforeEach(() => {
    updateCalls = [];
    updateNextResult = { data: [], error: null };
  });

  it("releases all open rows for (source, source_id) when no SKU filter is given", async () => {
    updateNextResult = { data: [{ id: "r1" }, { id: "r2" }, { id: "r3" }], error: null };
    const result = await releaseInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-123",
      reason: "fulfilled",
    });
    expect(result.released).toBe(3);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch.release_reason).toBe("fulfilled");
    expect(updateCalls[0].patch.released_at).toBeTypeOf("string");
    expect(updateCalls[0].filters).toEqual([
      { kind: "eq", col: "workspace_id", val: "ws-1" },
      { kind: "eq", col: "source", val: "order" },
      { kind: "eq", col: "source_id", val: "order-123" },
      { kind: "is", col: "released_at", val: null },
    ]);
  });

  it("narrows release to a SKU subset for partial fulfillment", async () => {
    updateNextResult = { data: [{ id: "r1" }], error: null };
    await releaseInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-123",
      skus: ["SKU-A", "SKU-B"],
      reason: "partial_fulfilled",
    });
    expect(updateCalls[0].filters).toEqual([
      { kind: "eq", col: "workspace_id", val: "ws-1" },
      { kind: "eq", col: "source", val: "order" },
      { kind: "eq", col: "source_id", val: "order-123" },
      { kind: "is", col: "released_at", val: null },
      { kind: "in", col: "sku", val: ["SKU-A", "SKU-B"] },
    ]);
  });

  it("returns released=0 when there is nothing open (retry no-op)", async () => {
    updateNextResult = { data: [], error: null };
    const result = await releaseInventory({
      workspaceId: "ws-1",
      source: "order",
      sourceId: "order-123",
      reason: "cancelled",
    });
    expect(result.released).toBe(0);
  });

  it("propagates Supabase errors with a context-bearing message", async () => {
    updateNextResult = { data: null, error: { message: "rls denied" } };
    await expect(
      releaseInventory({
        workspaceId: "ws-1",
        source: "order",
        sourceId: "order-1",
        reason: "x",
      }),
    ).rejects.toThrow(/releaseInventory update failed: rls denied/);
  });
});
