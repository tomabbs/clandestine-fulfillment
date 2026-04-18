import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockMatchOrg, mockRecord, mockFetchByUrl } = vi.hoisted(() => ({
  mockMatchOrg: vi.fn(),
  mockRecord: vi.fn(),
  mockFetchByUrl: vi.fn(),
}));

vi.mock("@/trigger/lib/match-shipment-org", () => ({
  matchShipmentOrg: mockMatchOrg,
}));

vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: mockRecord,
}));

vi.mock("@/lib/clients/shipstation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clients/shipstation")>(
    "@/lib/clients/shipstation",
  );
  return {
    ...actual,
    fetchShipmentsByResourceUrl: mockFetchByUrl,
  };
});

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: (...args: unknown[]) => unknown }) => def,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation" },
}));

// Import after mocks
import {
  findVariantBySkuOrAlias,
  processOneShipment,
} from "@/trigger/tasks/process-shipstation-shipment";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ChainResult {
  data: unknown;
  error?: unknown;
}

function chain(result: ChainResult) {
  const obj: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    in: () => chain(result),
    order: () => chain(result),
    limit: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    upsert: () => Promise.resolve({ error: null }),
    insert: () => Promise.resolve({ error: null }),
    update: () => Promise.resolve({ error: null }),
  };
  return obj;
}

interface SupabaseStub {
  from: ReturnType<typeof vi.fn>;
}

function makeSupabase(
  handlers: Partial<Record<string, (op: string) => unknown>> = {},
): SupabaseStub {
  const calls: Array<{ table: string }> = [];
  const stub: SupabaseStub & { _calls: Array<{ table: string }> } = {
    from: vi.fn((table: string) => {
      calls.push({ table });
      const handler = handlers[table];
      if (handler) {
        return handler("from") as object;
      }
      return chain({ data: null });
    }),
    _calls: calls,
  };
  return stub;
}

function makeShipment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    shipmentId: 7777,
    orderNumber: "ORD-1",
    trackingNumber: "TRACK-1",
    voided: false,
    storeId: 42,
    advancedOptions: null,
    shipmentItems: [{ sku: "WAREHOUSE-001", quantity: 2, lineItemKey: "li-1", name: "Test" }],
    ...overrides,
  } as Parameters<typeof processOneShipment>[1];
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("processOneShipment — voided / unresolved org / unknown SKU branches", () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockMatchOrg.mockReset();
    mockFetchByUrl.mockReset();
  });

  it("skips voided shipments without touching inventory or org match", async () => {
    const supabase = makeSupabase();
    const result = await processOneShipment(
      supabase as unknown as Parameters<typeof processOneShipment>[0],
      makeShipment({ voided: true }),
      "ws-1",
    );
    expect(result.status).toBe("voided");
    expect(mockMatchOrg).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("blocks the shipment and writes a high-severity review item when org is unresolvable", async () => {
    mockMatchOrg.mockResolvedValueOnce(null);
    let upsertPayload: unknown = null;
    const supabase = makeSupabase({
      warehouse_review_queue: () => ({
        upsert: vi.fn((payload: unknown) => {
          upsertPayload = payload;
          return Promise.resolve({ error: null });
        }),
      }),
    });

    const result = await processOneShipment(
      supabase as unknown as Parameters<typeof processOneShipment>[0],
      makeShipment(),
      "ws-1",
    );

    expect(result.status).toBe("unresolved_org");
    expect(mockRecord).not.toHaveBeenCalled();
    expect(upsertPayload).toMatchObject({
      category: "shipment_org_match",
      severity: "high",
      group_key: "ship_notify_org:7777",
    });
  });

  it("isolates per-line failures: unknown SKU writes a medium review item but other lines still process", async () => {
    mockMatchOrg.mockResolvedValueOnce({
      orgId: "org-1",
      method: "store_mapping",
      isDropShip: false,
    });

    const variantHits: Record<string, unknown> = {
      "GOOD-SKU": {
        id: "v-good",
        sku: "GOOD-SKU",
        workspace_id: "ws-1",
        warehouse_products: { org_id: "org-1" },
      },
    };

    const reviewUpserts: unknown[] = [];
    const supabase = makeSupabase({
      warehouse_product_variants: () => ({
        select: () => ({
          eq: (_col: string, val: string) => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: variantHits[val] ?? null, error: null }),
            }),
          }),
        }),
      }),
      client_store_sku_mappings: () => chain({ data: null }),
      sku_remap_history: () => chain({ data: null }),
      warehouse_review_queue: () => ({
        upsert: vi.fn((payload: unknown) => {
          reviewUpserts.push(payload);
          return Promise.resolve({ error: null });
        }),
      }),
    });

    mockRecord.mockResolvedValue({ success: true, newQuantity: 5, alreadyProcessed: false });

    const shipment = makeShipment({
      shipmentItems: [
        { sku: "GOOD-SKU", quantity: 1, lineItemKey: "li-good" },
        { sku: "BOGUS-SKU", quantity: 3, lineItemKey: "li-bad" },
      ],
    });

    const result = await processOneShipment(
      supabase as unknown as Parameters<typeof processOneShipment>[0],
      shipment,
      "ws-1",
    );

    expect(result.status).toBe("partial");
    expect(result.lines).toEqual([
      { sku: "GOOD-SKU", status: "ok" },
      { sku: "BOGUS-SKU", status: "unknown_sku" },
    ]);

    // The good line decremented inventory.
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "GOOD-SKU",
        delta: -1,
        source: "shipstation",
        correlationId: "ssv1:shipment:7777:GOOD-SKU",
      }),
    );

    // One medium-severity review item recorded for the bad SKU.
    expect(reviewUpserts).toHaveLength(1);
    expect(reviewUpserts[0]).toMatchObject({
      category: "shipment_unknown_sku",
      severity: "medium",
      group_key: "ship_notify_unknown_sku:7777:BOGUS-SKU",
    });
  });

  it("uses ssv1:shipment:{id}:{sku} correlation id (Rule #15 stable per logical op)", async () => {
    mockMatchOrg.mockResolvedValueOnce({
      orgId: "org-1",
      method: "store_mapping",
      isDropShip: false,
    });

    const supabase = makeSupabase({
      warehouse_product_variants: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: "v-1",
                    sku: "WAREHOUSE-001",
                    workspace_id: "ws-1",
                    warehouse_products: { org_id: "org-1" },
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }),
    });

    mockRecord.mockResolvedValue({ success: true, newQuantity: 5, alreadyProcessed: false });

    await processOneShipment(
      supabase as unknown as Parameters<typeof processOneShipment>[0],
      makeShipment(),
      "ws-1",
    );

    expect(mockRecord.mock.calls[0]?.[0]).toMatchObject({
      correlationId: "ssv1:shipment:7777:WAREHOUSE-001",
      delta: -2,
      source: "shipstation",
      metadata: expect.objectContaining({
        shipment_id: "7777",
        order_number: "ORD-1",
        line_item_key: "li-1",
        source_subtype: "ship_notify",
      }),
    });
  });
});

describe("findVariantBySkuOrAlias — alias resolution chain", () => {
  beforeEach(() => {
    mockRecord.mockReset();
  });

  it("returns the direct variant when sku matches and org_id matches", async () => {
    const supabase = makeSupabase({
      warehouse_product_variants: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: "v-1",
                    sku: "DIRECT-1",
                    workspace_id: "ws-1",
                    warehouse_products: { org_id: "org-A" },
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }),
    });

    const result = await findVariantBySkuOrAlias(
      supabase as unknown as Parameters<typeof findVariantBySkuOrAlias>[0],
      "DIRECT-1",
      "org-A",
    );
    expect(result).toEqual({
      workspaceId: "ws-1",
      sku: "DIRECT-1",
      variantId: "v-1",
      resolvedFromAlias: false,
    });
  });

  it("accepts distro variants (org_id IS NULL) regardless of caller's orgId", async () => {
    const supabase = makeSupabase({
      warehouse_product_variants: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: "v-distro",
                    sku: "DISTRO-1",
                    workspace_id: "ws-1",
                    warehouse_products: { org_id: null },
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }),
    });

    const result = await findVariantBySkuOrAlias(
      supabase as unknown as Parameters<typeof findVariantBySkuOrAlias>[0],
      "DISTRO-1",
      "org-A",
    );
    expect(result?.variantId).toBe("v-distro");
    expect(result?.resolvedFromAlias).toBe(false);
  });

  it("rejects a direct hit whose product belongs to a different org", async () => {
    const supabase = makeSupabase({
      warehouse_product_variants: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: "v-other",
                    sku: "WRONG-ORG-1",
                    workspace_id: "ws-1",
                    warehouse_products: { org_id: "org-B" },
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }),
      client_store_sku_mappings: () => chain({ data: null }),
      sku_remap_history: () => chain({ data: null }),
    });

    const result = await findVariantBySkuOrAlias(
      supabase as unknown as Parameters<typeof findVariantBySkuOrAlias>[0],
      "WRONG-ORG-1",
      "org-A",
    );
    expect(result).toBeNull();
  });
});
