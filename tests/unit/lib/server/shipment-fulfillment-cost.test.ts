import { describe, expect, it, vi } from "vitest";
import {
  batchBuildFormatCostMaps,
  computeCostsFromMaps,
  computeFulfillmentCostBreakdown,
  roundCents,
} from "@/lib/server/shipment-fulfillment-cost";

// === roundCents ===

describe("roundCents", () => {
  it("rounds to 2 decimal places", () => {
    // Use values whose float representation is unambiguous after * 100.
    expect(roundCents(1.456)).toBe(1.46); // 1.456 * 100 = 145.6 → 146 → 1.46
    expect(roundCents(1.234)).toBe(1.23); // 1.234 * 100 = 123.4 → 123 → 1.23
    expect(roundCents(1.999)).toBe(2.0);
    expect(roundCents(1.0)).toBe(1.0);
  });

  it("suppresses classic IEEE 754 drift", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in raw JS
    const result = roundCents(0.1 + 0.2);
    expect(result).toBe(0.3);
  });

  it("handles zero", () => {
    expect(roundCents(0)).toBe(0);
  });
});

// === computeCostsFromMaps ===

describe("computeCostsFromMaps", () => {
  const variantFormatMap = {
    "LP-001": "LP",
    "CD-001": "CD",
    "UNKNOWN-SKU": null,
  };
  const formatCostLookup = {
    LP: { pick_pack_cost: 2.5, material_cost: 1.0 },
    // CD intentionally absent
  };

  it("charges pick_pack and materials ONCE per format (not per item quantity)", () => {
    // Billing rule: pick_pack and material are flat per-shipment rates, not per-item.
    // A shipment with 2x LP-001 should charge the same as 1x LP-001.
    const result = computeCostsFromMaps(
      5.0,
      [{ sku: "LP-001", quantity: 2 }],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.pickPack).toBe(2.5); // flat once, NOT 2.5 * 2
    expect(result.materials).toBe(1.0); // flat once, NOT 1.0 * 2
    expect(result.total).toBe(8.5); // 5 + 2.5 + 1.0
    expect(result.partial).toBe(false);
    expect(result.unknownSkus).toEqual([]);
    expect(result.missingFormatCosts).toEqual([]);
  });

  it("charges each unique format once (not per quantity, not per SKU count)", () => {
    // 3 LP items (same format) → pick_pack charged once
    const result = computeCostsFromMaps(
      0,
      [
        { sku: "LP-001", quantity: 3 },
        { sku: "LP-001", quantity: 1 },
      ],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.pickPack).toBe(2.5); // LP charged once only
    expect(result.materials).toBe(1.0);
  });

  it("charges each distinct format once in a mixed shipment", () => {
    // LP + CD in same shipment → LP costs once + CD costs once (CD has no format cost → partial)
    const result = computeCostsFromMaps(
      5.0,
      [
        { sku: "LP-001", quantity: 1 }, // LP → resolved
        { sku: "CD-001", quantity: 1 }, // CD → format exists but no cost row
      ],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.pickPack).toBe(2.5); // only LP resolved
    expect(result.partial).toBe(true);
    expect(result.missingFormatCosts).toContain("CD");
  });

  it("marks partial=true for SKU not in variantFormatMap", () => {
    const result = computeCostsFromMaps(
      5.0,
      [{ sku: "NONEXISTENT", quantity: 1 }],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.partial).toBe(true);
    expect(result.unknownSkus).toContain("NONEXISTENT");
  });

  it("marks partial=true when format cost row is missing", () => {
    const result = computeCostsFromMaps(
      5.0,
      [{ sku: "CD-001", quantity: 1 }],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.partial).toBe(true);
    expect(result.missingFormatCosts).toContain("CD");
    // Cost is just postage since no format cost found
    expect(result.total).toBe(5.0);
  });

  it("skips null SKU items without marking partial", () => {
    const result = computeCostsFromMaps(
      5.0,
      [{ sku: null, quantity: 1 }],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.partial).toBe(false);
    expect(result.total).toBe(5.0);
  });

  it("does not double-count unknownSkus for repeated SKU", () => {
    const result = computeCostsFromMaps(
      0,
      [
        { sku: "NONEXISTENT", quantity: 1 },
        { sku: "NONEXISTENT", quantity: 2 },
      ],
      variantFormatMap,
      formatCostLookup,
    );
    expect(result.unknownSkus).toHaveLength(1);
  });

  it("accumulates in integer cents to avoid drift across multiple distinct formats", () => {
    // Each format costs 0.1; three distinct formats → 0.1 + 0.1 + 0.1 in float = drift.
    // Integer-cents: 10 + 10 + 10 = 30 cents exactly.
    const fc = {
      LP: { pick_pack_cost: 0.1, material_cost: 0.0 },
      CD: { pick_pack_cost: 0.1, material_cost: 0.0 },
      Cassette: { pick_pack_cost: 0.1, material_cost: 0.0 },
    };
    const vm = { "LP-001": "LP", "CD-001": "CD", "CS-001": "Cassette" };
    const items = [
      { sku: "LP-001", quantity: 1 },
      { sku: "CD-001", quantity: 1 },
      { sku: "CS-001", quantity: 1 },
    ];
    const result = computeCostsFromMaps(0, items, vm, fc);
    expect(result.pickPack).toBe(0.3); // 3 distinct formats × $0.10 each
    expect(result.total).toBe(0.3);
  });

  it("returns zero costs for empty items array", () => {
    const result = computeCostsFromMaps(7.5, [], variantFormatMap, formatCostLookup);
    expect(result.total).toBe(7.5);
    expect(result.materials).toBe(0);
    expect(result.pickPack).toBe(0);
    expect(result.partial).toBe(false);
  });
});

// === batchBuildFormatCostMaps ===

describe("batchBuildFormatCostMaps", () => {
  function makeSupabase(
    variantData: Array<{ sku: string; format_name: string | null }>,
    formatCostData: Array<{ format_name: string; pick_pack_cost: number; material_cost: number }>,
  ) {
    return {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: variantData, error: null }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: formatCostData, error: null }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ in: vi.fn() }) }),
        };
      }),
    };
  }

  it("builds correct maps for known SKUs", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: "LP" }],
      [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
    );

    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);

    expect(result.variantFormatMap).toEqual({ "LP-001": "LP" });
    expect(result.formatCostLookup.LP.pick_pack_cost).toBe(2.5);
    expect(result.unknownSkus).toEqual([]);
    expect(result.missingFormatCosts).toEqual([]);
  });

  it("reports unknownSkus when variant not found", async () => {
    const supabase = makeSupabase([], []);

    const result = await batchBuildFormatCostMaps("ws-1", ["GHOST-SKU"], supabase);

    expect(result.unknownSkus).toContain("GHOST-SKU");
    expect(result.variantFormatMap).toEqual({});
  });

  it("reports missingFormatCosts when format row absent", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: "LP" }],
      [], // no format cost rows
    );

    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);

    expect(result.missingFormatCosts).toContain("LP");
    expect(Object.keys(result.formatCostLookup)).toHaveLength(0);
  });

  it("handles empty SKU list without DB calls", async () => {
    const supabase = { from: vi.fn() };

    const result = await batchBuildFormatCostMaps("ws-1", [], supabase);

    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.variantFormatMap).toEqual({});
  });

  it("scopes variant query by workspace_id", async () => {
    const mockIn = vi.fn().mockResolvedValue({ data: [], error: null });
    const mockEq = vi.fn().mockReturnValue({ in: mockIn });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return { select: vi.fn().mockReturnValue({ eq: mockEq }) };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi
              .fn()
              .mockReturnValue({ in: vi.fn().mockResolvedValue({ data: [], error: null }) }),
          }),
        };
      }),
    };

    await batchBuildFormatCostMaps("ws-SPECIFIC", ["LP-001"], supabase);

    expect(mockEq).toHaveBeenCalledWith("workspace_id", "ws-SPECIFIC");
  });

  it("scopes format_cost query by workspace_id", async () => {
    const mockIn = vi.fn().mockResolvedValue({ data: [], error: null });
    const mockFcEq = vi.fn().mockReturnValue({ in: mockIn });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ sku: "LP-001", format_name: "LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return { select: vi.fn().mockReturnValue({ eq: mockFcEq }) };
        }
        return { select: vi.fn() };
      }),
    };

    await batchBuildFormatCostMaps("ws-SPECIFIC", ["LP-001"], supabase);

    expect(mockFcEq).toHaveBeenCalledWith("workspace_id", "ws-SPECIFIC");
  });
});

// === computeFulfillmentCostBreakdown ===

describe("computeFulfillmentCostBreakdown", () => {
  it("returns skuFormatMap for use by callers (eliminates second DB query)", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ sku: "LP-001", format_name: "LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      }),
    };

    const result = await computeFulfillmentCostBreakdown(
      "ws-1",
      5.0,
      [{ sku: "LP-001", quantity: 1 }],
      supabase,
    );

    expect(result.skuFormatMap["LP-001"]).toBe("LP");
    expect(result.total).toBe(8.5); // 5 + 2.5 + 1.0
    expect(result.partial).toBe(false);
  });

  it("returns partial=true and dropShip/insurance=0", async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      })),
    };

    const result = await computeFulfillmentCostBreakdown(
      "ws-1",
      10.0,
      [{ sku: "GHOST", quantity: 1 }],
      supabase,
    );

    expect(result.partial).toBe(true);
    expect(result.unknownSkus).toContain("GHOST");
    expect(result.dropShip).toBe(0);
    expect(result.insurance).toBe(0);
    expect(result.total).toBe(10.0); // only postage when no costs resolved
  });
});

// === Contract: list fulfillment_total === detail costBreakdown.total ===

describe("List vs detail contract", () => {
  it("computeCostsFromMaps produces same total as computeFulfillmentCostBreakdown with same inputs", async () => {
    const variantFormatMap = { "LP-001": "LP" };
    const formatCostLookup = { LP: { pick_pack_cost: 2.5, material_cost: 1.0 } };
    // quantity=2 but pick_pack and materials should be charged once (per-shipment flat rate)
    const items = [{ sku: "LP-001", quantity: 2 }];
    const postage = 5.99;

    // List path (uses pre-built maps)
    const listResult = computeCostsFromMaps(postage, items, variantFormatMap, formatCostLookup);

    // Detail path (async, builds maps internally)
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ sku: "LP-001", format_name: "LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      }),
    };

    const detailResult = await computeFulfillmentCostBreakdown("ws-1", postage, items, supabase);

    expect(listResult.total).toBe(detailResult.total);
    expect(listResult.materials).toBe(detailResult.materials);
    expect(listResult.pickPack).toBe(detailResult.pickPack);
    expect(listResult.partial).toBe(detailResult.partial);
  });
});
