import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockDelete = vi.fn();
const mockInsert = vi.fn();
const mockSingle = vi.fn();
const mockOrder = vi.fn();
const mockIn = vi.fn();

// biome-ignore lint/suspicious/noExplicitAny: test mock
const mockFrom: ReturnType<typeof vi.fn<any>> = vi.fn(() => ({
  select: mockSelect,
  delete: mockDelete,
  insert: mockInsert,
}));

function wireChain() {
  const chain = {
    eq: mockEq,
    select: mockSelect,
    single: mockSingle,
    order: mockOrder,
    in: mockIn,
    delete: mockDelete,
    insert: mockInsert,
  };
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  mockOrder.mockResolvedValue({ data: [], error: null });
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockDelete.mockReturnValue(chain);
  mockInsert.mockResolvedValue({ error: null });
  mockIn.mockReturnValue(chain);
}

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn(() => Promise.resolve({ userId: "user-1" })),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: vi.fn(() => ({ from: mockFrom })),
}));

import {
  computeBundleAvailability,
  getBundleComponents,
  removeBundleComponent,
  setBundleComponents,
} from "@/actions/bundle-components";

const VARIANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VARIANT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VARIANT_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WORKSPACE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("bundle-components Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireChain();
  });

  describe("getBundleComponents", () => {
    it("returns empty array when no components", async () => {
      mockOrder.mockResolvedValue({ data: [], error: null });

      const result = await getBundleComponents(VARIANT_A);

      expect(mockFrom).toHaveBeenCalledWith("bundle_components");
      expect(result).toEqual([]);
    });
  });

  describe("setBundleComponents", () => {
    it("rejects invalid UUID in components (Zod validation)", async () => {
      await expect(
        setBundleComponents(VARIANT_A, [{ componentVariantId: "not-a-uuid", quantity: 1 }]),
      ).rejects.toThrow();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it("calls delete then insert for atomic replace", async () => {
      const opOrder: string[] = [];
      const variantChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null }),
      };
      const graphChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
      // Production now also validates that component variant rows exist + have inventory
      // levels before the atomic delete/insert (src/actions/bundle-components.ts §94-138).
      // Mock the two reads it issues: warehouse_product_variants + warehouse_inventory_levels.
      const componentVariantsChain = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ id: VARIANT_B, sku: "SKU-B" }], error: null }),
      };
      const inventoryLevelsChain = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ variant_id: VARIANT_B }], error: null }),
      };
      const deleteChain = {
        delete: vi.fn(() => {
          opOrder.push("delete");
          return deleteChain;
        }),
        eq: vi.fn().mockResolvedValue({ error: null }),
      };
      const insertTable = {
        insert: vi.fn().mockImplementation(async () => {
          opOrder.push("insert");
          return { error: null };
        }),
      };

      mockFrom
        .mockReturnValueOnce(variantChain)
        .mockReturnValueOnce(graphChain)
        .mockReturnValueOnce(componentVariantsChain)
        .mockReturnValueOnce(inventoryLevelsChain)
        .mockReturnValueOnce(deleteChain)
        .mockReturnValueOnce(insertTable);

      await setBundleComponents(VARIANT_A, [{ componentVariantId: VARIANT_B, quantity: 2 }]);

      expect(deleteChain.delete).toHaveBeenCalled();
      expect(deleteChain.eq).toHaveBeenCalledWith("bundle_variant_id", VARIANT_A);
      expect(insertTable.insert).toHaveBeenCalledWith([
        {
          workspace_id: WORKSPACE_ID,
          bundle_variant_id: VARIANT_A,
          component_variant_id: VARIANT_B,
          quantity: 2,
        },
      ]);
      expect(opOrder).toEqual(["delete", "insert"]);
    });

    it("detects direct cycle (A → B → A)", async () => {
      const variantChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null }),
      };
      const graphChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: [{ bundle_variant_id: VARIANT_B, component_variant_id: VARIANT_A }],
          error: null,
        }),
      };

      mockFrom.mockReturnValueOnce(variantChain).mockReturnValueOnce(graphChain);

      await expect(
        setBundleComponents(VARIANT_A, [{ componentVariantId: VARIANT_B, quantity: 1 }]),
      ).rejects.toThrow(/Circular reference detected/);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("allows diamond dependency (A → B → D, A → C → D)", async () => {
      const variantChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null }),
      };
      const graphChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: [
            { bundle_variant_id: VARIANT_B, component_variant_id: VARIANT_D },
            { bundle_variant_id: VARIANT_C, component_variant_id: VARIANT_D },
          ],
          error: null,
        }),
      };
      // Production validates component variant rows + inventory levels before the
      // atomic delete/insert — see "calls delete then insert" test for the same shape.
      const componentVariantsChain = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [
            { id: VARIANT_B, sku: "SKU-B" },
            { id: VARIANT_C, sku: "SKU-C" },
          ],
          error: null,
        }),
      };
      const inventoryLevelsChain = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [{ variant_id: VARIANT_B }, { variant_id: VARIANT_C }],
          error: null,
        }),
      };
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      };
      const insertTable = {
        insert: vi.fn().mockResolvedValue({ error: null }),
      };

      mockFrom
        .mockReturnValueOnce(variantChain)
        .mockReturnValueOnce(graphChain)
        .mockReturnValueOnce(componentVariantsChain)
        .mockReturnValueOnce(inventoryLevelsChain)
        .mockReturnValueOnce(deleteChain)
        .mockReturnValueOnce(insertTable);

      await expect(
        setBundleComponents(VARIANT_A, [
          { componentVariantId: VARIANT_B, quantity: 1 },
          { componentVariantId: VARIANT_C, quantity: 1 },
        ]),
      ).resolves.toBeUndefined();

      expect(insertTable.insert).toHaveBeenCalled();
    });
  });

  describe("removeBundleComponent", () => {
    it("calls delete with correct ID", async () => {
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      };
      mockFrom.mockReturnValueOnce(deleteChain);

      await removeBundleComponent("ffffffff-ffff-4fff-8fff-ffffffffffff");

      expect(mockFrom).toHaveBeenCalledWith("bundle_components");
      expect(deleteChain.delete).toHaveBeenCalled();
      expect(deleteChain.eq).toHaveBeenCalledWith("id", "ffffffff-ffff-4fff-8fff-ffffffffffff");
    });
  });

  describe("computeBundleAvailability", () => {
    it("computes MIN-based availability with bundle safety stock", async () => {
      const bundleVariantId = VARIANT_A;
      const workspaceId = WORKSPACE_ID;

      mockFrom
        .mockImplementationOnce(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { available: 10, safety_stock: 2 },
            error: null,
          }),
        }))
        .mockImplementationOnce(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { default_safety_stock: 3 }, error: null }),
        }))
        .mockImplementationOnce(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({
            data: [
              {
                component_variant_id: VARIANT_B,
                quantity: 2,
                warehouse_product_variants: {
                  sku: "SKU-X",
                  title: "X",
                  warehouse_inventory_levels: [{ available: 10 }],
                },
              },
              {
                component_variant_id: VARIANT_C,
                quantity: 1,
                warehouse_product_variants: {
                  sku: "SKU-Y",
                  title: "Y",
                  warehouse_inventory_levels: [{ available: 3 }],
                },
              },
            ],
            error: null,
          }),
        }));

      const result = await computeBundleAvailability(bundleVariantId, workspaceId);

      expect(result.rawAvailable).toBe(10);
      expect(result.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            componentVariantId: VARIANT_B,
            contributes: 5,
            quantityPerBundle: 2,
            available: 10,
          }),
          expect.objectContaining({
            componentVariantId: VARIANT_C,
            contributes: 3,
            quantityPerBundle: 1,
            available: 3,
          }),
        ]),
      );
      expect(result.effectiveAvailable).toBe(1);
      expect(result.constrainedBy).toEqual(
        expect.objectContaining({ componentVariantId: VARIANT_C, contributes: 3 }),
      );
    });
  });
});
