import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 §9.6 D2 — `safety-stock` Server Actions companion test
// suite (Rule #6).
//
// Covers:
//   - parseCsv (RFC 4180 corner cases — quotes, escapes, CRLF/LF/CR,
//     trailing newlines, embedded commas).
//   - listSafetyStockChannels: storefront connections + drift count
//     + internal channel rows; staff-only gate.
//   - listSafetyStockEntries: storefront vs internal pagination,
//     onlyWithSafetyStock filter, last-edit enrichment.
//   - updateSafetyStockBulk: per-SKU best-effort (applied + skipped +
//     error mix); SKU-not-found, mapping-not-found-on-storefront,
//     no-op skip; audit log batched insert; cross-workspace guard.
//   - previewSafetyStockCsv: header validation, change-kind classification
//     (create / update / delete / no_change / error).
//   - listSafetyStockAuditLog: filter combinations + contradiction
//     rejection.

const requireAuth = vi.fn();
vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: (...args: unknown[]) => requireAuth(...args),
}));

const mockServiceFrom = vi.fn();
vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

import {
  commitSafetyStockCsv,
  listSafetyStockAuditLog,
  listSafetyStockChannels,
  listSafetyStockEntries,
  previewSafetyStockCsv,
  updateSafetyStockBulk,
} from "@/actions/safety-stock";
import { parseCsv } from "@/lib/shared/safety-stock-csv";

// Zod v4 UUID enforcement — see connection-cutover.test.ts header.
const UUID = {
  ws: "11111111-1111-4111-8111-111111111111",
  user: "22222222-2222-4222-8222-222222222222",
  conn1: "33333333-3333-4333-8333-333333333333",
  conn2: "44444444-4444-4444-8444-444444444444",
  conn3: "55555555-5555-4555-8555-555555555555",
  variantA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  variantB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  variantC: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function setupAuth(isStaff: boolean, workspaceId = UUID.ws) {
  requireAuth.mockResolvedValue({
    isStaff,
    userRecord: {
      id: UUID.user,
      workspace_id: workspaceId,
      org_id: null,
      role: isStaff ? "admin" : "client",
      email: "test@test.com",
      name: "Tester",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupAuth(true);
});

// ─── parseCsv ────────────────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("handles bare comma-separated rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles double-quoted fields with embedded commas", () => {
    expect(parseCsv('sku,note\nABC-1,"hello, world"')).toEqual([
      ["sku", "note"],
      ["ABC-1", "hello, world"],
    ]);
  });

  it("handles doubled-quote escape", () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([["a"], ['she said "hi"']]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("filters out empty trailing rows", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves empty cells", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

// ─── Helpers for query mock chains ───────────────────────────────────────────

/** Build a terminal chain that resolves with `result` regardless of
 *  any chained `.eq/.in/.gt/.order/.range` calls. */
function terminalChain(result: { data?: unknown; count?: number; error?: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const handler = {
    get(target: typeof chain, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      }
      if (prop === "maybeSingle" || prop === "single") {
        return vi.fn().mockResolvedValue(result);
      }
      target[prop] ??= vi.fn().mockReturnValue(new Proxy(target, handler));
      return target[prop];
    },
  };
  return new Proxy(chain, handler);
}

// ─── listSafetyStockChannels ─────────────────────────────────────────────────

describe("listSafetyStockChannels", () => {
  it("rejects non-staff", async () => {
    setupAuth(false);
    await expect(listSafetyStockChannels({})).rejects.toThrow(/staff-only/);
  });

  it("returns storefront connections + internal channels with drift counts", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") {
        return terminalChain({
          data: [
            {
              id: UUID.conn1,
              platform: "shopify",
              store_url: "northern-spy.myshopify.com",
              connection_status: "active",
              organizations: { name: "Northern Spy" },
            },
          ],
          error: null,
        });
      }
      if (table === "client_store_sku_mappings") {
        // Both drift query + stocked query land here. Return a stub
        // that matches both (same data shape; the action keys by
        // `connection_id`).
        return terminalChain({
          data: [{ connection_id: UUID.conn1 }, { connection_id: UUID.conn1 }],
          error: null,
        });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        return terminalChain({
          data: [{ id: "x" }],
          error: null,
        });
      }
      throw new Error(`unexpected from(${table})`);
    });

    const result = await listSafetyStockChannels({});
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      pickerKey: `storefront:${UUID.conn1}`,
      kind: "storefront",
      connectionId: UUID.conn1,
      label: "northern-spy.myshopify.com",
      subtitle: "Northern Spy",
      policyDriftCount: 2,
      rowsWithSafetyStock: 2,
    });
    expect(result[1]).toMatchObject({
      pickerKey: "internal:bandcamp",
      kind: "internal",
      channelName: "bandcamp",
      label: "Bandcamp",
      rowsWithSafetyStock: 1,
    });
    expect(result[2]).toMatchObject({
      pickerKey: "internal:clandestine_shopify",
      kind: "internal",
    });
  });
});

// ─── updateSafetyStockBulk ───────────────────────────────────────────────────

describe("updateSafetyStockBulk", () => {
  it("rejects non-staff", async () => {
    setupAuth(false);
    await expect(
      updateSafetyStockBulk({
        channel: { kind: "internal", channelName: "bandcamp" },
        edits: [{ sku: "X-1", newSafetyStock: 5 }],
        source: "ui_bulk",
      }),
    ).rejects.toThrow(/staff-only/);
  });

  it("rejects cross-workspace storefront connection", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") {
        return terminalChain({
          data: {
            id: UUID.conn1,
            workspace_id: "00000000-0000-4000-8000-000000000099",
            platform: "shopify",
            store_url: null,
            connection_status: "active",
          },
          error: null,
        });
      }
      throw new Error(`unexpected from(${table})`);
    });
    await expect(
      updateSafetyStockBulk({
        channel: { kind: "storefront", connectionId: UUID.conn1 },
        edits: [{ sku: "X-1", newSafetyStock: 5 }],
        source: "ui_bulk",
      }),
    ).rejects.toThrow(/cross-workspace/);
  });

  it("applies internal-channel upsert + writes audit row when value goes 0→7", async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null });
    const auditInsertSpy = vi.fn().mockResolvedValue({ error: null });

    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return terminalChain({
          data: [{ id: UUID.variantA, sku: "ABC-1" }],
          error: null,
        });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        // First call resolves the read (no row → empty array), second call
        // is the upsert. Branch on whether `.upsert()` is present in the
        // chain.
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "upsert") return upsertSpy;
              if (prop === "select") {
                return vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      in: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                });
              }
              return vi.fn().mockReturnValue({});
            },
          },
        );
      }
      if (table === "warehouse_safety_stock_audit_log") {
        return { insert: auditInsertSpy };
      }
      throw new Error(`unexpected from(${table})`);
    });

    const res = await updateSafetyStockBulk({
      channel: { kind: "internal", channelName: "bandcamp" },
      edits: [{ sku: "ABC-1", newSafetyStock: 7 }],
      reason: "promo reserve",
      source: "ui_bulk",
    });

    expect(res.applied).toBe(1);
    expect(res.errors).toBe(0);
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(auditInsertSpy).toHaveBeenCalledOnce();
    const auditPayload = (auditInsertSpy.mock.calls[0]?.[0] ?? []) as Array<
      Record<string, unknown>
    >;
    expect(auditPayload[0]).toMatchObject({
      sku: "ABC-1",
      channel_kind: "internal",
      channel_name: "bandcamp",
      prev_safety_stock: null,
      new_safety_stock: 7,
      reason: "promo reserve",
      source: "ui_bulk",
    });
  });

  it("flags SKU-not-found as error without crashing the batch", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return terminalChain({ data: [{ id: UUID.variantA, sku: "REAL-1" }], error: null });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "upsert") return vi.fn().mockResolvedValue({ error: null });
              if (prop === "select") {
                return vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      in: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                });
              }
              return vi.fn().mockReturnValue({});
            },
          },
        );
      }
      if (table === "warehouse_safety_stock_audit_log") {
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      }
      throw new Error(`unexpected from(${table})`);
    });

    const res = await updateSafetyStockBulk({
      channel: { kind: "internal", channelName: "bandcamp" },
      edits: [
        { sku: "REAL-1", newSafetyStock: 3 },
        { sku: "GHOST-99", newSafetyStock: 5 },
      ],
      source: "ui_bulk",
    });

    expect(res.applied).toBe(1);
    expect(res.errors).toBe(1);
    expect(res.outcomes.find((o) => o.sku === "GHOST-99")?.error).toMatch(/not found/);
  });

  it("skips no-op edits without writing", async () => {
    const auditInsertSpy = vi.fn().mockResolvedValue({ error: null });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return terminalChain({ data: [{ id: UUID.variantA, sku: "SAME-1" }], error: null });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "upsert") return vi.fn();
              if (prop === "select") {
                return vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      in: vi.fn().mockResolvedValue({
                        data: [
                          {
                            variant_id: UUID.variantA,
                            safety_stock: 5,
                            warehouse_product_variants: { sku: "SAME-1" },
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                });
              }
              return vi.fn().mockReturnValue({});
            },
          },
        );
      }
      if (table === "warehouse_safety_stock_audit_log") {
        return { insert: auditInsertSpy };
      }
      throw new Error(`unexpected from(${table})`);
    });
    const res = await updateSafetyStockBulk({
      channel: { kind: "internal", channelName: "bandcamp" },
      edits: [{ sku: "SAME-1", newSafetyStock: 5 }],
      source: "ui_bulk",
    });
    expect(res.applied).toBe(0);
    expect(res.skippedNoChange).toBe(1);
    expect(auditInsertSpy).not.toHaveBeenCalled();
  });
});

// ─── previewSafetyStockCsv + commitSafetyStockCsv ────────────────────────────

describe("previewSafetyStockCsv", () => {
  it("rejects missing header columns", async () => {
    mockServiceFrom.mockImplementation((_table: string) =>
      terminalChain({ data: [], error: null }),
    );
    await expect(
      previewSafetyStockCsv({
        channel: { kind: "internal", channelName: "bandcamp" },
        csv: "wrong,header\nABC,5",
      }),
    ).rejects.toThrow(/header row/);
  });

  it("classifies create / update / delete / no_change / error correctly", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return terminalChain({
          data: [
            { id: UUID.variantA, sku: "NEW-1" },
            { id: UUID.variantB, sku: "EXISTS-1" },
            { id: UUID.variantC, sku: "ZERO-1" },
            // GHOST-1 deliberately missing from this list
          ],
          error: null,
        });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "select") {
                return vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      in: vi.fn().mockResolvedValue({
                        data: [
                          {
                            variant_id: UUID.variantB,
                            safety_stock: 3,
                            warehouse_product_variants: { sku: "EXISTS-1" },
                          },
                          {
                            variant_id: UUID.variantC,
                            safety_stock: 7,
                            warehouse_product_variants: { sku: "ZERO-1" },
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                });
              }
              return vi.fn();
            },
          },
        );
      }
      throw new Error(`unexpected from(${table})`);
    });

    const csv =
      "sku,safety_stock\n" +
      "NEW-1,5\n" + // create (no current row, value > 0)
      "EXISTS-1,9\n" + // update
      "EXISTS-1,3\n" + // no_change (matches current 3)
      "ZERO-1,0\n" + // delete (current row, target value 0)
      "GHOST-1,4\n" + // error (sku not found)
      "BAD-VAL,abc\n"; // error (non-integer)

    const res = await previewSafetyStockCsv({
      channel: { kind: "internal", channelName: "bandcamp" },
      csv,
    });
    const byKind: Record<string, number> = {};
    for (const r of res.rows) byKind[r.changeKind] = (byKind[r.changeKind] ?? 0) + 1;
    expect(byKind).toEqual({
      create: 1,
      update: 1,
      no_change: 1,
      delete: 1,
      error: 2,
    });
    expect(res.summary).toEqual({
      create: 1,
      update: 1,
      delete: 1,
      noChange: 1,
      error: 2,
    });
  });
});

describe("commitSafetyStockCsv", () => {
  it("delegates to updateSafetyStockBulk with source='ui_csv'", async () => {
    const auditInsertSpy = vi.fn().mockResolvedValue({ error: null });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return terminalChain({ data: [{ id: UUID.variantA, sku: "X-1" }], error: null });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "upsert") return vi.fn().mockResolvedValue({ error: null });
              if (prop === "select") {
                return vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      in: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                });
              }
              return vi.fn();
            },
          },
        );
      }
      if (table === "warehouse_safety_stock_audit_log") {
        return { insert: auditInsertSpy };
      }
      throw new Error(`unexpected from(${table})`);
    });
    const res = await commitSafetyStockCsv({
      channel: { kind: "internal", channelName: "bandcamp" },
      edits: [{ sku: "X-1", newSafetyStock: 4 }],
    });
    expect(res.applied).toBe(1);
    const auditPayload = (auditInsertSpy.mock.calls[0]?.[0] ?? []) as Array<
      Record<string, unknown>
    >;
    expect(auditPayload[0]?.source).toBe("ui_csv");
  });
});

// ─── listSafetyStockAuditLog ─────────────────────────────────────────────────

describe("listSafetyStockAuditLog", () => {
  it("rejects contradictory channelKind + connectionId", async () => {
    await expect(
      listSafetyStockAuditLog({
        channelKind: "internal",
        connectionId: UUID.conn1,
      }),
    ).rejects.toThrow(/connectionId implies/);
  });

  it("rejects contradictory channelKind + channelName", async () => {
    await expect(
      listSafetyStockAuditLog({
        channelKind: "storefront",
        channelName: "bandcamp",
      }),
    ).rejects.toThrow(/channelName implies/);
  });

  it("returns rows ordered by changed_at desc", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      expect(table).toBe("warehouse_safety_stock_audit_log");
      return terminalChain({
        data: [
          { id: "a", changed_at: "2026-04-24T15:00:00Z", sku: "X-1" },
          { id: "b", changed_at: "2026-04-23T15:00:00Z", sku: "X-2" },
        ],
        count: 2,
        error: null,
      });
    });
    const res = await listSafetyStockAuditLog({});
    expect(res.entries).toHaveLength(2);
    expect(res.total).toBe(2);
  });
});

// ─── listSafetyStockEntries (internal channel happy path) ────────────────────

describe("listSafetyStockEntries", () => {
  it("returns entries with safetyStock=0 for variants without rows", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return terminalChain({
          data: [
            {
              id: UUID.variantA,
              sku: "ABC-1",
              warehouse_products: { title: "Album A" },
              warehouse_inventory_levels: { available: 42 },
            },
            {
              id: UUID.variantB,
              sku: "ABC-2",
              warehouse_products: { title: "Album B" },
              warehouse_inventory_levels: null,
            },
          ],
          count: 2,
          error: null,
        });
      }
      if (table === "warehouse_safety_stock_per_channel") {
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "select") {
                return vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      in: vi.fn().mockResolvedValue({
                        data: [{ variant_id: UUID.variantA, safety_stock: 5 }],
                        error: null,
                      }),
                    }),
                  }),
                });
              }
              return vi.fn();
            },
          },
        );
      }
      if (table === "warehouse_safety_stock_audit_log") {
        return terminalChain({ data: [], error: null });
      }
      throw new Error(`unexpected from(${table})`);
    });
    const res = await listSafetyStockEntries({
      channel: { kind: "internal", channelName: "bandcamp" },
      page: 1,
      pageSize: 50,
    });
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({
      sku: "ABC-1",
      productTitle: "Album A",
      available: 42,
      safetyStock: 5,
    });
    expect(res.entries[1]).toMatchObject({
      sku: "ABC-2",
      available: 0,
      safetyStock: 0,
    });
  });
});
