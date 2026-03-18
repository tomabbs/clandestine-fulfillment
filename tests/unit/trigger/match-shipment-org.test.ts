import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger before importing
vi.mock("@trigger.dev/sdk", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

// biome-ignore lint/suspicious/noExplicitAny: test mock
const mockFrom: ReturnType<typeof vi.fn<any>> = vi.fn();

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";

function makeSupabase() {
  return createServiceRoleClient();
}

describe("matchShipmentOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Tier 1: store mapping", () => {
    it("matches org via warehouse_shipstation_stores", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipstation_stores") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { org_id: "org-alpha", is_drop_ship: false },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), 12345, ["SKU-001"]);

      expect(result).toEqual({ orgId: "org-alpha", method: "store_mapping", isDropShip: false });
    });

    it("skips tier 1 when storeId is null", async () => {
      // Should fall through to SKU matching
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), null, []);
      expect(result).toBeNull();
    });

    it("falls through when store has no org_id", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipstation_stores") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), 99999, []);
      expect(result).toBeNull();
    });
  });

  describe("Tier 2: SKU matching", () => {
    it("matches org via SKU → product → org_id", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipstation_stores") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { sku: "LP-001", warehouse_products: { org_id: "org-beta" } },
                  { sku: "LP-002", warehouse_products: { org_id: "org-beta" } },
                ],
                error: null,
              }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), 99999, ["LP-001", "LP-002"]);

      expect(result).toEqual({ orgId: "org-beta", method: "sku_match", isDropShip: false });
    });

    it("picks majority org when SKUs map to multiple orgs", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipstation_stores") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { sku: "SKU-A", warehouse_products: { org_id: "org-majority" } },
                  { sku: "SKU-B", warehouse_products: { org_id: "org-majority" } },
                  { sku: "SKU-C", warehouse_products: { org_id: "org-minority" } },
                ],
                error: null,
              }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), null, ["SKU-A", "SKU-B", "SKU-C"]);

      expect(result).toEqual({ orgId: "org-majority", method: "sku_match", isDropShip: false });
    });

    it("filters out UNKNOWN and empty SKUs", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), null, ["UNKNOWN", "", "UNKNOWN"]);

      expect(result).toBeNull();
      // Should not even query variants since all SKUs are filtered out
    });
  });

  describe("Tier 3: no match", () => {
    it("returns null when all tiers fail", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipstation_stores") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const result = await matchShipmentOrg(makeSupabase(), 12345, ["NO-MATCH"]);
      expect(result).toBeNull();
    });

    it("returns null when no storeId and no SKUs", async () => {
      const result = await matchShipmentOrg(makeSupabase(), null, []);
      expect(result).toBeNull();
    });
  });
});
