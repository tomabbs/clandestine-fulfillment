/**
 * Order Pages Transition Phase 5b — writeback ledger contract tests.
 *
 * Validates the line-grain rules from the plan:
 *   - 3-line direct order with two shipments produces ONE writeback row +
 *     3 line rows.
 *   - Partial success leaves the order-level status as `partial_succeeded`.
 *   - Retry of a failed line does not re-fulfill an already-succeeded line
 *     (UNIQUE(writeback_id, warehouse_order_item_id) blocks duplicates —
 *     the helper upserts on that conflict).
 *   - Bandcamp generic-path block produces a writeback row with status
 *     `blocked_bandcamp_generic_path` and zero attempts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openWriteback, recordBlockedWriteback } from "@/lib/server/platform-fulfillment-writeback";

interface TableRow {
  [k: string]: unknown;
}

class StubTable {
  rows: TableRow[] = [];
  pkSeq = 1;
  newId(): string {
    return `id-${this.pkSeq++}`;
  }
}

class StubSupabase {
  tables: Record<string, StubTable> = {};
  table(name: string): StubTable {
    if (!this.tables[name]) this.tables[name] = new StubTable();
    return this.tables[name];
  }

  from(name: string) {
    const table = this.table(name);
    const filters: Array<{ column: string; value: unknown; op: "eq" | "is" }> = [];
    let pendingInsertResult: TableRow[] | null = null;

    const builder = {
      select(_cols?: string) {
        void _cols;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, value, op: "eq" });
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push({ column, value, op: "is" });
        return builder;
      },
      // biome-ignore lint/suspicious/noThenProperty: thenable stub mimics PostgREST builder
      then(resolve: (v: { data: TableRow[]; error: null }) => void) {
        const data = applyFilters(table.rows, filters);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
      maybeSingle: async () => {
        const filtered = applyFilters(table.rows, filters);
        return { data: filtered[0] ?? null, error: null };
      },
      single: async () => {
        const data = pendingInsertResult ? pendingInsertResult[0] : null;
        return { data, error: data ? null : { message: "no row" } };
      },
      insert: (row: TableRow | TableRow[]) => {
        const arr = Array.isArray(row) ? row : [row];
        const inserted = arr.map((r) => ({
          id: (r as { id?: string }).id ?? table.newId(),
          ...r,
        }));
        table.rows.push(...inserted);
        pendingInsertResult = inserted;
        return Object.assign(Promise.resolve({ data: inserted, error: null }), {
          select(_c?: string) {
            void _c;
            return Object.assign(Promise.resolve({ data: inserted, error: null }), {
              single: async () => ({ data: inserted[0] ?? null, error: null }),
            });
          },
        });
      },
      update: (patch: Record<string, unknown>) => {
        const wrapper = {
          eq(column: string, value: unknown) {
            filters.push({ column, value, op: "eq" });
            return wrapper;
          },
          is(column: string, value: unknown) {
            filters.push({ column, value, op: "is" });
            return wrapper;
          },
          // biome-ignore lint/suspicious/noThenProperty: thenable stub mimics PostgREST builder
          then: (resolve: (v: { data: null; error: null }) => void) => {
            const matches = applyFilters(table.rows, filters);
            for (const row of matches) {
              for (const [k, v] of Object.entries(patch)) row[k] = v;
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        } as unknown as PromiseLike<{ data: null; error: null }> & {
          eq: (c: string, v: unknown) => unknown;
          is: (c: string, v: unknown) => unknown;
        };
        return wrapper;
      },
      upsert: (rows: TableRow[], opts?: { onConflict?: string }) => {
        const conflictKeys = opts?.onConflict?.split(",").map((s) => s.trim()) ?? [];
        for (const newRow of rows) {
          let existing: TableRow | undefined;
          if (conflictKeys.length > 0) {
            existing = table.rows.find((r) => conflictKeys.every((k) => r[k] === newRow[k]));
          }
          if (existing) {
            for (const [k, v] of Object.entries(newRow)) existing[k] = v;
          } else {
            table.rows.push({ id: table.newId(), ...newRow });
          }
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }
}

function applyFilters(
  rows: TableRow[],
  filters: Array<{ column: string; value: unknown; op: string }>,
) {
  return rows.filter((row) =>
    filters.every((f) => {
      if (f.op === "is" && f.value === null)
        return row[f.column] === null || row[f.column] === undefined;
      return row[f.column] === f.value;
    }),
  );
}

describe("openWriteback", () => {
  let supabase: StubSupabase;

  beforeEach(() => {
    supabase = new StubSupabase();
  });

  it("creates one writeback row + 3 line rows for a 3-line direct order", async () => {
    const ledger = await openWriteback({
      // biome-ignore lint/suspicious/noExplicitAny: stub matches SupabaseClient runtime shape
      supabase: supabase as any,
      workspaceId: "w1",
      warehouseOrderId: "wo1",
      shipmentId: null,
      platform: "shopify",
      connectionId: "c1",
      externalOrderId: "12345",
      lines: [
        { warehouseOrderItemId: "oi1", quantity: 1 },
        { warehouseOrderItemId: "oi2", quantity: 2 },
        { warehouseOrderItemId: "oi3", quantity: 1 },
      ],
    });
    expect(ledger.writebackId).toBeTruthy();
    expect(supabase.table("platform_fulfillment_writebacks").rows).toHaveLength(1);
    expect(supabase.table("platform_fulfillment_writeback_lines").rows).toHaveLength(3);
  });

  it("derives partial_succeeded when one line succeeds and one fails terminally", async () => {
    const ledger = await openWriteback({
      // biome-ignore lint/suspicious/noExplicitAny: stub matches SupabaseClient runtime shape
      supabase: supabase as any,
      workspaceId: "w1",
      warehouseOrderId: "wo2",
      shipmentId: null,
      platform: "shopify",
      connectionId: "c1",
      externalOrderId: "12346",
      lines: [
        { warehouseOrderItemId: "oi1", quantity: 1 },
        { warehouseOrderItemId: "oi2", quantity: 1 },
      ],
    });
    await ledger.recordLine({ warehouseOrderItemId: "oi1", status: "succeeded" });
    await ledger.recordLine({
      warehouseOrderItemId: "oi2",
      status: "failed_terminal",
      errorMessage: "shopify rejected",
    });
    const writeback = supabase.table("platform_fulfillment_writebacks").rows[0];
    expect(writeback?.status).toBe("partial_succeeded");
  });

  it("does not create duplicate line rows on retry (upsert on (writeback_id, warehouse_order_item_id))", async () => {
    const ledger = await openWriteback({
      // biome-ignore lint/suspicious/noExplicitAny: stub matches SupabaseClient runtime shape
      supabase: supabase as any,
      workspaceId: "w1",
      warehouseOrderId: "wo3",
      shipmentId: null,
      platform: "shopify",
      connectionId: "c1",
      externalOrderId: "12347",
      lines: [{ warehouseOrderItemId: "oi1", quantity: 1 }],
    });
    await ledger.recordLine({ warehouseOrderItemId: "oi1", status: "succeeded" });
    // Retry the same line — should mutate, not duplicate.
    await openWriteback({
      // biome-ignore lint/suspicious/noExplicitAny: stub matches SupabaseClient runtime shape
      supabase: supabase as any,
      workspaceId: "w1",
      warehouseOrderId: "wo3",
      shipmentId: null,
      platform: "shopify",
      connectionId: "c1",
      externalOrderId: "12347",
      lines: [{ warehouseOrderItemId: "oi1", quantity: 1 }],
    });
    expect(supabase.table("platform_fulfillment_writeback_lines").rows).toHaveLength(1);
    expect(supabase.table("platform_fulfillment_writebacks").rows).toHaveLength(1);
    void ledger;
  });

  it("recordBlockedWriteback inserts a row with the blocked status and zero attempts", async () => {
    await recordBlockedWriteback({
      // biome-ignore lint/suspicious/noExplicitAny: stub matches SupabaseClient runtime shape
      supabase: supabase as any,
      workspaceId: "w1",
      warehouseOrderId: "wo4",
      platform: "bandcamp",
      status: "blocked_bandcamp_generic_path",
      reason: "bandcamp-mark-shipped owns this",
    });
    const rows = supabase.table("platform_fulfillment_writebacks").rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("blocked_bandcamp_generic_path");
    expect(rows[0]?.attempt_count).toBe(0);
  });
});
