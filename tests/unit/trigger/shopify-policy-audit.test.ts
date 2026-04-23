/**
 * Phase 0 / §9.1 D2 — `shopify-policy-audit` tests.
 *
 * The cron itself is thin (loop over connections → `auditShopifyConnection`
 * → `persistConnectionReport`); the contract worth pinning is:
 *
 *   1. AUTHORITATIVE persistence — every Shopify variant we see updates the
 *      matching mapping's `last_inventory_policy` + `last_policy_check_at`,
 *      regardless of value. This is the audit confidence signal.
 *   2. Drift detection — `inventoryPolicy === 'CONTINUE'` AND
 *      `preorder_whitelist === false` MUST land in `driftSkus`.
 *      `preorder_whitelist === true` MUST NOT (legitimate exemption).
 *   3. HRD-03 backfill triage — mappings with no `remote_inventory_item_id`
 *      MUST be counted in `unmappedSkipped`, never silently dropped or
 *      counted as drift.
 *   4. Failure isolation — `ShopifyScopeError` returns `status='scope_error'`,
 *      not a thrown exception. The cron loop relies on this to keep
 *      auditing other connections after one fails.
 *
 * We mock the Shopify GraphQL transport at the module boundary
 * (`connectionShopifyGraphQL`) and supply an in-memory Supabase mock so
 * the test stays a pure unit (no network, no DB).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockGraphQL, mockUpdate } = vi.hoisted(() => ({
  mockGraphQL: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/server/shopify-connection-graphql", async () => {
  // ShopifyScopeError must remain a real class so `instanceof` checks
  // inside the audit body still work.
  const real = await vi.importActual<typeof import("@/lib/server/shopify-connection-graphql")>(
    "@/lib/server/shopify-connection-graphql",
  );
  return {
    ...real,
    connectionShopifyGraphQL: mockGraphQL,
  };
});

import { ShopifyScopeError } from "@/lib/server/shopify-connection-graphql";
import { auditShopifyConnection } from "@/trigger/tasks/shopify-policy-audit";

// ── Supabase mock ──────────────────────────────────────────────────────────

interface MappingRow {
  id: string;
  remote_inventory_item_id: string | null;
  remote_sku: string | null;
  preorder_whitelist: boolean;
  last_inventory_policy?: string | null;
  last_policy_check_at?: string | null;
}

function makeSupabase(mappings: MappingRow[]) {
  const tables: { client_store_sku_mappings: MappingRow[] } = {
    client_store_sku_mappings: [...mappings],
  };

  const supabase = {
    from(table: string) {
      if (table !== "client_store_sku_mappings") {
        throw new Error(`unexpected table in test: ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              data: tables.client_store_sku_mappings,
              error: null,
            }),
          }),
        }),
        update: (payload: Partial<MappingRow>) => {
          mockUpdate(payload);
          return {
            eq: (_col: string, value: string) => {
              const row = tables.client_store_sku_mappings.find((r) => r.id === value);
              if (row) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
    _tables: tables,
  };

  // The audit body is typed against the real Supabase service-role client;
  // unsafe-cast is fine — every method it actually invokes is stubbed.
  return supabase as unknown as Parameters<typeof auditShopifyConnection>[0] & {
    _tables: typeof tables;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  store_url: "https://shop.example.com",
  api_key: "shpat_xxx",
};

function variantsPage(
  vs: Array<{
    inventoryItemId: string;
    inventoryPolicy: "DENY" | "CONTINUE";
    sku?: string | null;
  }>,
) {
  return {
    products: {
      edges: vs.map((v, i) => ({
        node: {
          id: `gid://shopify/Product/${i}`,
          variants: {
            edges: [
              {
                node: {
                  id: `gid://shopify/ProductVariant/${i}`,
                  sku: v.sku ?? `SKU-${i}`,
                  inventoryPolicy: v.inventoryPolicy,
                  inventoryItem: { id: v.inventoryItemId, tracked: true },
                },
              },
            ],
          },
        },
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("shopify-policy-audit / auditShopifyConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists last_inventory_policy + last_policy_check_at for EVERY observed mapping (DENY + CONTINUE)", async () => {
    const supabase = makeSupabase([
      {
        id: "m1",
        remote_inventory_item_id: "gid://shopify/InventoryItem/1",
        remote_sku: "SKU-DENY",
        preorder_whitelist: false,
      },
      {
        id: "m2",
        remote_inventory_item_id: "gid://shopify/InventoryItem/2",
        remote_sku: "SKU-CONTINUE",
        preorder_whitelist: false,
      },
    ]);

    mockGraphQL.mockResolvedValueOnce(
      variantsPage([
        { inventoryItemId: "gid://shopify/InventoryItem/1", inventoryPolicy: "DENY" },
        { inventoryItemId: "gid://shopify/InventoryItem/2", inventoryPolicy: "CONTINUE" },
      ]),
    );

    const report = await auditShopifyConnection(supabase, CONNECTION);

    expect(report.status).toBe("ok");
    expect(report.variantsScanned).toBe(2);
    expect(report.mappingsUpdated).toBe(2);
    // BOTH mappings updated — DENY observations are ALSO persisted so the
    // Channels page can show "audited Xm ago" as a confidence signal.
    expect(supabase._tables.client_store_sku_mappings).toEqual([
      expect.objectContaining({
        id: "m1",
        last_inventory_policy: "DENY",
        last_policy_check_at: expect.any(String),
      }),
      expect.objectContaining({
        id: "m2",
        last_inventory_policy: "CONTINUE",
        last_policy_check_at: expect.any(String),
      }),
    ]);
  });

  it("flags ONLY CONTINUE+!preorder_whitelist as drift; preorder_whitelist=true CONTINUE is not drift", async () => {
    const supabase = makeSupabase([
      {
        id: "m1",
        remote_inventory_item_id: "gid://shopify/InventoryItem/1",
        remote_sku: "SKU-DRIFT",
        preorder_whitelist: false,
      },
      {
        id: "m2",
        remote_inventory_item_id: "gid://shopify/InventoryItem/2",
        remote_sku: "SKU-WHITELISTED-PREORDER",
        // Legitimate pre-order: customer can buy while we backorder.
        preorder_whitelist: true,
      },
    ]);

    mockGraphQL.mockResolvedValueOnce(
      variantsPage([
        { inventoryItemId: "gid://shopify/InventoryItem/1", inventoryPolicy: "CONTINUE" },
        { inventoryItemId: "gid://shopify/InventoryItem/2", inventoryPolicy: "CONTINUE" },
      ]),
    );

    const report = await auditShopifyConnection(supabase, CONNECTION);

    expect(report.status).toBe("ok");
    expect(report.driftCount).toBe(1);
    expect(report.driftSkus).toEqual(["SKU-DRIFT"]);
    // Preorder-whitelisted mapping is STILL audited (last_inventory_policy
    // recorded as CONTINUE) — we just don't raise.
    expect(supabase._tables.client_store_sku_mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "m2", last_inventory_policy: "CONTINUE" }),
      ]),
    );
  });

  it("HRD-03: mappings without remote_inventory_item_id count as unmappedSkipped, never as drift", async () => {
    const supabase = makeSupabase([
      {
        id: "m1",
        remote_inventory_item_id: null,
        remote_sku: "SKU-LEGACY",
        preorder_whitelist: false,
      },
      {
        id: "m2",
        remote_inventory_item_id: "gid://shopify/InventoryItem/2",
        remote_sku: "SKU-CONTINUE",
        preorder_whitelist: false,
      },
    ]);

    mockGraphQL.mockResolvedValueOnce(
      variantsPage([
        { inventoryItemId: "gid://shopify/InventoryItem/2", inventoryPolicy: "CONTINUE" },
      ]),
    );

    const report = await auditShopifyConnection(supabase, CONNECTION);

    expect(report.status).toBe("ok");
    expect(report.unmappedSkipped).toBe(1);
    expect(report.mappingsUpdated).toBe(1); // only m2 was joinable
    expect(report.driftCount).toBe(1);
    expect(report.driftSkus).toEqual(["SKU-CONTINUE"]);
  });

  it("returns status='scope_error' on ShopifyScopeError without throwing — keeps the cron loop alive", async () => {
    const supabase = makeSupabase([
      {
        id: "m1",
        remote_inventory_item_id: "gid://shopify/InventoryItem/1",
        remote_sku: "SKU-A",
        preorder_whitelist: false,
      },
    ]);

    mockGraphQL.mockRejectedValueOnce(new ShopifyScopeError("read_products", 403, "denied"));

    const report = await auditShopifyConnection(supabase, CONNECTION);

    expect(report.status).toBe("scope_error");
    expect(report.error).toMatch(/missing scope: read_products/);
    expect(report.variantsScanned).toBe(0);
    expect(report.mappingsUpdated).toBe(0);
  });

  it("returns status='skipped' when the connection has no api_key (never installed / token revoked)", async () => {
    const supabase = makeSupabase([]);
    const report = await auditShopifyConnection(supabase, { ...CONNECTION, api_key: null });
    expect(report.status).toBe("skipped");
    expect(report.error).toBe("no_access_token");
    // No GraphQL call attempted.
    expect(mockGraphQL).not.toHaveBeenCalled();
  });

  it("returns status='failed' on unexpected GraphQL errors (non-Shopify-scope)", async () => {
    const supabase = makeSupabase([
      {
        id: "m1",
        remote_inventory_item_id: "gid://shopify/InventoryItem/1",
        remote_sku: "SKU-A",
        preorder_whitelist: false,
      },
    ]);

    mockGraphQL.mockRejectedValueOnce(new Error("Shopify GraphQL: empty response data"));

    const report = await auditShopifyConnection(supabase, CONNECTION);
    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/empty response data/);
  });
});
