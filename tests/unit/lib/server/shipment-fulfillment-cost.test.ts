import { describe, expect, it, vi } from "vitest";
import {
  batchBuildFormatCostMaps,
  computeCostsFromMaps,
  computeFulfillmentCostBreakdown,
  extractFormatFromTitle,
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

  it("REGRESSION: null format_name in map triggers partial=true (not silent skip)", () => {
    // Root Cause B fix: before this patch, if(!fn) continue silently skipped null-format
    // SKUs, leaving partial=false. After fix, they are added to unknownSkus → partial=true.
    const vm = { "LP-001": null }; // SKU found but format unresolvable
    const fc = { LP: { pick_pack_cost: 2.5, material_cost: 1.0 } };
    const result = computeCostsFromMaps(10.0, [{ sku: "LP-001", quantity: 1 }], vm, fc);
    expect(result.partial).toBe(true); // amber dot — was incorrectly false before fix
    expect(result.materials).toBe(0);
    expect(result.pickPack).toBe(0);
    expect(result.total).toBe(10.0); // postage only
    expect(result.unknownSkus).toContain("LP-001");
  });
});

// === batchBuildFormatCostMaps ===

describe("batchBuildFormatCostMaps", () => {
  function makeSupabase(
    variantData: Array<{
      sku: string;
      format_name: string | null;
      warehouse_products?: { product_type: string | null } | null;
    }>,
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

  it("uses warehouse_products.product_type as fallback when format_name is null", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: null, warehouse_products: { product_type: "LP" } }],
      [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
    );
    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);
    expect(result.variantFormatMap["LP-001"]).toBe("LP");
    expect(result.unknownSkus).toEqual([]);
    expect(result.formatCostLookup.LP.pick_pack_cost).toBe(2.5);
  });

  it("stores null in variantFormatMap when both format_name and product_type are null", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: null, warehouse_products: { product_type: null } }],
      [],
    );
    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);
    // Variant was found so it is NOT in unknownSkus at this stage.
    // The null map value causes computeCostsFromMaps to add it to unknownSkus.
    expect(result.variantFormatMap).toHaveProperty("LP-001", null);
    expect(result.unknownSkus).toEqual([]); // batchBuild doesn't mark it unknown; computeCosts does
  });

  it("treats empty string product_type as null (|| not ??)", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: null, warehouse_products: { product_type: "" } }],
      [],
    );
    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);
    expect(result.variantFormatMap["LP-001"]).toBeNull();
  });

  it("treats whitespace-only product_type as null after trim", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: null, warehouse_products: { product_type: "   " } }],
      [],
    );
    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);
    // "   ".trim() = "" → falsy → null; must not reach formatCostLookup as "   "
    expect(result.variantFormatMap["LP-001"]).toBeNull();
  });

  it("respects explicit format_name even when product_type differs", async () => {
    const supabase = makeSupabase(
      [{ sku: "LP-001", format_name: "CD", warehouse_products: { product_type: "LP" } }],
      [{ format_name: "CD", pick_pack_cost: 1.5, material_cost: 0.75 }],
    );
    const result = await batchBuildFormatCostMaps("ws-1", ["LP-001"], supabase);
    expect(result.variantFormatMap["LP-001"]).toBe("CD"); // explicit format_name wins
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

  it("null format_name with product_type=LP fallback resolves full costs (not $0)", async () => {
    // End-to-end parity: exercises batchBuildFormatCostMaps FK join + computeCostsFromMaps.
    // Variant has format_name=null but product_type=LP via parent product FK join.
    // Expected: costs resolved correctly — materials and pick_pack NOT $0, partial=false.
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [
                    {
                      sku: "LP-001",
                      format_name: null,
                      warehouse_products: { product_type: "LP" },
                    },
                  ],
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
                  data: [{ format_name: "LP", pick_pack_cost: 2.0, material_cost: 1.32 }],
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
      6.5,
      [{ sku: "LP-001", quantity: 1 }],
      supabase,
    );

    expect(result.partial).toBe(false); // format resolved via product_type fallback
    expect(result.materials).toBeCloseTo(1.32);
    expect(result.pickPack).toBeCloseTo(2.0);
    expect(result.total).toBeCloseTo(9.82); // 6.50 + 1.32 + 2.00
    expect(result.skuFormatMap["LP-001"]).toBe("LP"); // fallback recorded in map
  });
});

// === extractFormatFromTitle ===

describe("extractFormatFromTitle", () => {
  it("extracts LP from various title patterns", () => {
    expect(extractFormatFromTitle("Joy Guidry - AMEN LP")).toBe("LP");
    expect(extractFormatFromTitle('Some Band - Great Album 12" Vinyl')).toBe("LP");
    expect(extractFormatFromTitle("Artist Name - Title Vinyl LP")).toBe("LP");
    expect(extractFormatFromTitle("Band - Album 2XLP")).toBe("LP");
    expect(extractFormatFromTitle("Double LP Record")).toBe("LP");
  });

  it("extracts CD", () => {
    expect(extractFormatFromTitle("Some Album CD")).toBe("CD");
    expect(extractFormatFromTitle("Best Of Compact Disc")).toBe("CD");
    expect(extractFormatFromTitle("Limited Edition CDR")).toBe("CD");
  });

  it("extracts Cassette", () => {
    expect(extractFormatFromTitle("Live At The Venue Cassette")).toBe("Cassette");
    expect(extractFormatFromTitle("Demo Tape")).toBe("Cassette");
  });

  it('extracts 7"', () => {
    expect(extractFormatFromTitle('Split 7" Single')).toBe('7"');
    expect(extractFormatFromTitle("Seven-Inch release")).toBe('7"');
  });

  it("extracts T-Shirt", () => {
    expect(extractFormatFromTitle("Band Logo T-Shirt")).toBe("T-Shirt");
    expect(extractFormatFromTitle("Tour Tee Black")).toBe("T-Shirt");
    expect(extractFormatFromTitle("Show Apparel")).toBe("T-Shirt");
  });

  it('prefers 7" over LP when both patterns present', () => {
    // 7" pattern runs first in the array
    expect(extractFormatFromTitle('7" Vinyl single')).toBe('7"');
  });

  it("returns null for unrecognised titles", () => {
    expect(extractFormatFromTitle("Poster Print")).toBeNull();
    expect(extractFormatFromTitle("")).toBeNull();
    expect(extractFormatFromTitle(null)).toBeNull();
    expect(extractFormatFromTitle(undefined)).toBeNull();
  });
});

// === batchBuildFormatCostMaps — title fallback (itemTitleMap) ===

describe("batchBuildFormatCostMaps — title-based fallback", () => {
  /** Supabase mock: variants returns empty (SKU not in catalog), products table for fuzzy match. */
  function makeTitleFallbackSupabase(productRows: Array<{ title: string; product_type: string }>) {
    return {
      from: vi.fn((table: string) => {
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "warehouse_products") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: productRows, error: null }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [
                    { format_name: "LP", pick_pack_cost: 2.0, material_cost: 1.32 },
                    { format_name: "CD", pick_pack_cost: 1.5, material_cost: 0.75 },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      }),
    };
  }

  it("resolves format via keyword extraction when SKU is absent from variants", async () => {
    const supabase = makeTitleFallbackSupabase([]);
    const result = await batchBuildFormatCostMaps("ws-1", ["SQ6720646"], supabase, {
      SQ6720646: "Joy Guidry - AMEN LP",
    });
    expect(result.variantFormatMap["SQ6720646"]).toBe("LP");
    expect(result.unknownSkus).not.toContain("SQ6720646");
  });

  it("resolves format via fuzzy product title match when keyword extraction misses", async () => {
    const supabase = makeTitleFallbackSupabase([
      { title: "Joy Guidry - AMEN", product_type: "LP" },
    ]);
    // Title has no format keyword, but matches a product title fuzzily
    const result = await batchBuildFormatCostMaps("ws-1", ["SQ4004064"], supabase, {
      SQ4004064: "Joy Guidry - AMEN",
    });
    expect(result.variantFormatMap["SQ4004064"]).toBe("LP");
    expect(result.unknownSkus).not.toContain("SQ4004064");
  });

  it("adds to unknownSkus when no title is provided for missing SKU", async () => {
    const supabase = makeTitleFallbackSupabase([]);
    const result = await batchBuildFormatCostMaps("ws-1", ["SQ9999999"], supabase, {
      SQ9999999: null,
    });
    expect(result.variantFormatMap["SQ9999999"]).toBeUndefined();
    expect(result.unknownSkus).toContain("SQ9999999");
  });

  it("does not run title fallback when itemTitleMap is omitted (backward compat)", async () => {
    const supabase = makeTitleFallbackSupabase([]);
    const result = await batchBuildFormatCostMaps("ws-1", ["SQ6720646"], supabase);
    // No itemTitleMap passed → should not call warehouse_products
    expect(result.unknownSkus).toContain("SQ6720646");
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(fromCalls).not.toContain("warehouse_products");
  });

  it("keyword fallback takes precedence over fuzzy match", async () => {
    // Title has "LP" → keyword pass resolves it; fuzzy pass should never run
    const supabase = makeTitleFallbackSupabase([
      { title: "Totally Different Album CD", product_type: "CD" },
    ]);
    const result = await batchBuildFormatCostMaps("ws-1", ["SQ0000001"], supabase, {
      SQ0000001: "Some Great LP",
    });
    expect(result.variantFormatMap["SQ0000001"]).toBe("LP");
  });

  it("end-to-end: Squarespace SKU with LP title resolves full costs (not $0)", async () => {
    const supabase = makeTitleFallbackSupabase([]);
    const result = await computeFulfillmentCostBreakdown(
      "ws-1",
      6.5,
      [{ sku: "SQ6720646", quantity: 1, product_title: "Joy Guidry - AMEN LP" }],
      supabase,
    );
    expect(result.partial).toBe(false);
    expect(result.materials).toBeCloseTo(1.32);
    expect(result.pickPack).toBeCloseTo(2.0);
    expect(result.skuFormatMap["SQ6720646"]).toBe("LP");
  });
});
