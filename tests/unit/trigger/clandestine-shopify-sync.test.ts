import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeCreateDistroProduct } from "@/trigger/tasks/clandestine-shopify-sync";

/**
 * Phase 0.7 distro discriminator.
 *
 * `maybeCreateDistroProduct` decides whether a Shopify product is "distro"
 * (Clandestine-owned, no client org, no Bandcamp upstream) and, if so,
 * creates a `warehouse_products` row with `org_id = NULL`. The classification
 * rules (already-exists short-circuit, Bandcamp-overlap short-circuit, and
 * the distro insert) are pure functions of (Shopify product, DB state), so
 * we can mock the Supabase chains and assert the branches without touching
 * the network or the schedule wrapper.
 */

type ChainedQuery = {
  // biome-ignore lint/suspicious/noExplicitAny: test scaffold
  [key: string]: any;
};

type SupabaseStub = {
  from: ReturnType<typeof vi.fn>;
};

interface ShopifyProductFixture {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  tags: string[];
  handle: string | null;
  variants: { edges: Array<{ node: VariantFixture }> };
}

interface VariantFixture {
  id: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  compareAtPrice: string | null;
  barcode: string | null;
  inventoryItem: { id: string | null; measurement: null } | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

function makeShopifyProduct(overrides: Partial<ShopifyProductFixture> = {}): ShopifyProductFixture {
  return {
    id: "gid://shopify/Product/1",
    title: "Test Distro Product",
    vendor: "Clandestine",
    productType: "Merch",
    status: "ACTIVE",
    tags: [],
    handle: "test-distro",
    variants: {
      edges: [
        {
          node: {
            id: "gid://shopify/ProductVariant/100",
            sku: "DISTRO-001",
            title: "Default",
            price: "20.00",
            compareAtPrice: null,
            barcode: null,
            inventoryItem: { id: "gid://shopify/InventoryItem/200", measurement: null },
            selectedOptions: [],
          },
        },
      ],
    },
    ...overrides,
  };
}

function chain(result: { data: unknown; error: unknown }): ChainedQuery {
  // The chain is also a thenable so `await chain(...)` returns the result —
  // matches Supabase's PostgREST builder which lazily resolves on await.
  const obj: ChainedQuery = {
    select: () => chain(result),
    eq: () => chain(result),
    in: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: mirroring PostgREST builder
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return obj;
}

describe("maybeCreateDistroProduct (Phase 0.7)", () => {
  let supabase: SupabaseStub;
  let fromCalls: Array<{ table: string; op: string; payload?: unknown }>;

  beforeEach(() => {
    fromCalls = [];
  });

  it("skips when warehouse_products already has the shopify_product_id", async () => {
    supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_products") {
          fromCalls.push({ table, op: "select" });
          return chain({ data: { id: "existing" }, error: null });
        }
        throw new Error(`Unexpected table read: ${table}`);
      }),
    };

    const result = await maybeCreateDistroProduct(
      // biome-ignore lint/suspicious/noExplicitAny: stubbed supabase
      supabase as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural shape only
      makeShopifyProduct() as any,
      "ws-1",
    );

    expect(result).toEqual({ createdProduct: false, createdVariants: 0 });
    expect(fromCalls.map((c) => c.table)).toEqual(["warehouse_products"]);
  });

  it("skips when product has no SKUs at all", async () => {
    supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_products") {
          return chain({ data: null, error: null });
        }
        throw new Error(`Unexpected table read: ${table}`);
      }),
    };

    const result = await maybeCreateDistroProduct(
      // biome-ignore lint/suspicious/noExplicitAny: stubbed supabase
      supabase as any,
      makeShopifyProduct({
        variants: {
          edges: [{ node: { ...makeShopifyProduct().variants.edges[0].node, sku: null } }],
        },
        // biome-ignore lint/suspicious/noExplicitAny: structural shape only
      }) as any,
      "ws-1",
    );

    expect(result).toEqual({ createdProduct: false, createdVariants: 0 });
  });

  it("skips when ANY variant SKU is already a Bandcamp mapping (= client product)", async () => {
    supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_products") {
          return chain({ data: null, error: null });
        }
        if (table === "warehouse_product_variants") {
          return chain({
            data: [{ id: "v-1", bandcamp_product_mappings: { id: "bc-1" } }],
            error: null,
          });
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await maybeCreateDistroProduct(
      // biome-ignore lint/suspicious/noExplicitAny: stubbed supabase
      supabase as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural shape only
      makeShopifyProduct() as any,
      "ws-1",
    );

    expect(result).toEqual({ createdProduct: false, createdVariants: 0 });
  });

  it("creates warehouse_products with org_id=NULL when product is truly distro", async () => {
    let insertedProductPayload: Record<string, unknown> | undefined;
    let upsertedVariantPayload: Record<string, unknown> | undefined;

    supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_products") {
          return {
            select: () => chain({ data: null, error: null }),
            eq: () => chain({ data: null, error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            insert: (payload: Record<string, unknown>) => {
              insertedProductPayload = payload;
              return {
                select: () => ({
                  single: () => Promise.resolve({ data: { id: "new-prod" }, error: null }),
                }),
              };
            },
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: () => chain({ data: [], error: null }),
            eq: () => chain({ data: [], error: null }),
            in: () => chain({ data: [], error: null }),
            upsert: (payload: Record<string, unknown>) => {
              upsertedVariantPayload = payload;
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await maybeCreateDistroProduct(
      // biome-ignore lint/suspicious/noExplicitAny: stubbed supabase
      supabase as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural shape only
      makeShopifyProduct() as any,
      "ws-1",
    );

    expect(result).toEqual({ createdProduct: true, createdVariants: 1 });
    expect(insertedProductPayload).toMatchObject({
      workspace_id: "ws-1",
      org_id: null,
      shopify_product_id: "gid://shopify/Product/1",
      title: "Test Distro Product",
      status: "active",
    });
    expect(upsertedVariantPayload).toMatchObject({
      workspace_id: "ws-1",
      sku: "DISTRO-001",
      product_id: "new-prod",
    });
  });
});
