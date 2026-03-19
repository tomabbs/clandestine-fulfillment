import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Constants ---
const { WS_ID, PROD_ID, IMG_A, IMG_B, IMG_C } = vi.hoisted(() => ({
  WS_ID: "11111111-1111-4111-a111-111111111111",
  PROD_ID: "22222222-2222-4222-a222-222222222222",
  IMG_A: "33333333-3333-4333-a333-333333333333",
  IMG_B: "44444444-4444-4444-a444-444444444444",
  IMG_C: "55555555-5555-4555-a555-555555555555",
}));

// --- Mock requireAuth ---
vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    supabase: {},
    authUserId: "auth-user-1",
    userRecord: {
      id: "user-1",
      workspace_id: WS_ID,
      org_id: "org-1",
      role: "admin",
      email: "test@test.com",
      name: "Test User",
    },
    isStaff: true,
  }),
}));

const mockStorageUpload = vi.fn();
const mockStorageRemove = vi.fn();
const mockStorageGetPublicUrl = vi.fn();

const mockServiceClient = {
  from: vi.fn(),
  storage: {
    from: vi.fn(() => ({
      upload: mockStorageUpload,
      remove: mockStorageRemove,
      getPublicUrl: mockStorageGetPublicUrl,
    })),
  },
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockServiceClient,
}));

vi.mock("@/lib/clients/shopify-client", () => ({
  productUpdate: vi.fn().mockResolvedValue({ id: "gid://shopify/Product/1" }),
}));

import {
  deleteProductImage,
  reorderProductImages,
  setFeaturedImage,
  uploadProductImage,
} from "@/actions/product-images";
import { requireAuth } from "@/lib/server/auth-context";

// --- Helpers ---

function createMockFile(name = "test.jpg", size = 1024, type = "image/jpeg"): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

describe("product-images server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({
      supabase: {} as never,
      authUserId: "auth-user-1",
      userRecord: {
        id: "user-1",
        workspace_id: WS_ID,
        org_id: "org-1",
        role: "admin",
        email: "test@test.com",
        name: "Test User",
      },
      isStaff: true,
    });
  });

  describe("uploadProductImage", () => {
    function setupUploadMocks(opts?: { shopifyProductId?: string | null; position?: number }) {
      let productCallCount = 0;
      let imageCallCount = 0;

      mockStorageUpload.mockResolvedValue({ error: null });
      mockStorageGetPublicUrl.mockReturnValue({
        data: { publicUrl: `https://s.example.com/product-images/${WS_ID}/${PROD_ID}/img.jpg` },
      });

      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "warehouse_products") {
          productCallCount++;
          if (productCallCount === 1) {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: {
                        id: PROD_ID,
                        workspace_id: WS_ID,
                        shopify_product_id: opts?.shopifyProductId ?? null,
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === "warehouse_product_images") {
          imageCallCount++;
          if (imageCallCount === 1) {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ count: opts?.position ?? 0 }),
              }),
            };
          }
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: IMG_A,
                    product_id: PROD_ID,
                    workspace_id: WS_ID,
                    position: opts?.position ?? 0,
                    src: `https://s.example.com/product-images/${WS_ID}/${PROD_ID}/img.jpg`,
                    alt: "Alt text",
                    shopify_image_id: null,
                    created_at: "2026-03-18T00:00:00Z",
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return undefined;
      });
    }

    it("uploads file, inserts DB row, and returns image", async () => {
      setupUploadMocks();
      const fd = new FormData();
      fd.set("file", createMockFile());

      const result = await uploadProductImage({ productId: PROD_ID, alt: "Alt text" }, fd);

      expect(result.id).toBe(IMG_A);
      expect(result.position).toBe(0);
    });

    it("rejects files over 10 MB", async () => {
      setupUploadMocks();
      const fd = new FormData();
      fd.set("file", createMockFile("big.jpg", 11 * 1024 * 1024));

      await expect(uploadProductImage({ productId: PROD_ID }, fd)).rejects.toThrow(
        "File exceeds 10 MB limit",
      );
    });

    it("rejects unsupported file types", async () => {
      setupUploadMocks();
      const fd = new FormData();
      fd.set("file", createMockFile("doc.pdf", 1024, "application/pdf"));

      await expect(uploadProductImage({ productId: PROD_ID }, fd)).rejects.toThrow(
        "Unsupported file type",
      );
    });

    it("throws when no file is provided", async () => {
      setupUploadMocks();
      await expect(uploadProductImage({ productId: PROD_ID }, new FormData())).rejects.toThrow(
        "No file provided",
      );
    });

    it("throws when user is not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      const fd = new FormData();
      fd.set("file", createMockFile());
      await expect(uploadProductImage({ productId: PROD_ID }, fd)).rejects.toThrow("Unauthorized");
    });
  });

  describe("reorderProductImages", () => {
    it("updates positions and sets featured image", async () => {
      const updateCalls: Array<{ position: number }> = [];

      let imageCallCount = 0;

      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "warehouse_product_images") {
          imageCallCount++;
          if (imageCallCount <= 3) {
            // position updates
            return {
              update: vi.fn((data: { position: number }) => {
                updateCalls.push(data);
                return {
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({ error: null }),
                  }),
                };
              }),
            };
          }
          // First image lookup for featured URL
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { src: "https://example.com/b.jpg" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_products") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        return undefined;
      });

      const result = await reorderProductImages({
        productId: PROD_ID,
        imageIds: [IMG_A, IMG_B, IMG_C],
      });

      expect(result).toEqual({ success: true });
      expect(updateCalls).toHaveLength(3);
      expect(updateCalls[0].position).toBe(0);
      expect(updateCalls[1].position).toBe(1);
      expect(updateCalls[2].position).toBe(2);
    });
  });

  describe("deleteProductImage", () => {
    it("deletes from storage and DB, promotes next image", async () => {
      let imageCallCount = 0;

      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "warehouse_product_images") {
          imageCallCount++;
          if (imageCallCount === 1) {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: IMG_A,
                      product_id: PROD_ID,
                      src: `https://s.example.com/storage/v1/object/public/product-images/${WS_ID}/abc.jpg`,
                      position: 0,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (imageCallCount === 2) {
            return {
              delete: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: { src: "https://s.example.com/next.jpg" },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_products") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        return undefined;
      });

      mockStorageRemove.mockResolvedValue({ error: null });

      const result = await deleteProductImage({ imageId: IMG_A });
      expect(result).toEqual({ success: true });
    });

    it("throws when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(deleteProductImage({ imageId: IMG_A })).rejects.toThrow("Unauthorized");
    });
  });

  describe("setFeaturedImage", () => {
    it("moves target to position 0 and updates product", async () => {
      let imageCallCount = 0;

      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "warehouse_product_images") {
          imageCallCount++;
          if (imageCallCount === 1) {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({
                    data: [
                      { id: IMG_A, position: 0, src: "https://example.com/a.jpg" },
                      { id: IMG_B, position: 1, src: "https://example.com/b.jpg" },
                      { id: IMG_C, position: 2, src: "https://example.com/c.jpg" },
                    ],
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === "warehouse_products") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        return undefined;
      });

      const result = await setFeaturedImage({ productId: PROD_ID, imageId: IMG_B });
      expect(result).toEqual({ success: true });
    });

    it("throws when image not found", async () => {
      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "warehouse_product_images") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ id: IMG_A, position: 0, src: "https://example.com/a.jpg" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return undefined;
      });

      await expect(
        setFeaturedImage({
          productId: PROD_ID,
          imageId: "99999999-9999-4999-a999-999999999999",
        }),
      ).rejects.toThrow("Image not found for this product");
    });
  });
});
