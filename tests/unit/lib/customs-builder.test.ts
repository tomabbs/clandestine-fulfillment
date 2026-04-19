import { describe, expect, it } from "vitest";
import {
  aggregateParcelDimensions,
  buildCustomsItems,
  HS_CODE_DEFAULTS,
  HS_CODE_GLOBAL_FALLBACK,
  resolveHsCode,
  type VariantCustomsData,
  type VariantDimensions,
} from "@/lib/shared/customs-builder";

describe("resolveHsCode (Phase 0.5.5)", () => {
  it("uses explicit hs_tariff_code when present", () => {
    expect(resolveHsCode({ sku: "X", hsTariffCode: "8523.49.4000" })).toBe("8523.49.4000");
  });

  it("falls back to category default when hs_tariff_code is null", () => {
    expect(resolveHsCode({ sku: "X", hsTariffCode: null, productCategory: "vinyl" })).toBe(
      HS_CODE_DEFAULTS.vinyl,
    );
    expect(resolveHsCode({ sku: "X", hsTariffCode: null, productCategory: "tshirt" })).toBe(
      HS_CODE_DEFAULTS.tshirt,
    );
  });

  it("falls back to global vinyl-music default when no variant or category match", () => {
    expect(resolveHsCode({ sku: "X", hsTariffCode: null, productCategory: "unknown" })).toBe(
      HS_CODE_GLOBAL_FALLBACK,
    );
    expect(resolveHsCode(null)).toBe(HS_CODE_GLOBAL_FALLBACK);
    expect(resolveHsCode(undefined)).toBe(HS_CODE_GLOBAL_FALLBACK);
  });

  it("category lookup is case-insensitive and trimmed", () => {
    expect(resolveHsCode({ sku: "X", hsTariffCode: null, productCategory: "  VINYL  " })).toBe(
      HS_CODE_DEFAULTS.vinyl,
    );
  });
});

describe("buildCustomsItems (Phase 0.5.4)", () => {
  const variantsBySku = new Map<string, VariantCustomsData>([
    ["LP-001", { sku: "LP-001", hsTariffCode: "8523.80.4000", productCategory: "vinyl" }],
    ["CD-001", { sku: "CD-001", hsTariffCode: null, productCategory: "cd" }],
  ]);

  it("returns empty array for empty input", () => {
    expect(buildCustomsItems({ lineItems: [], variantsBySku, totalWeightOz: 16 })).toEqual([]);
  });

  it("builds line-item declarations from order data", () => {
    const items = buildCustomsItems({
      lineItems: [
        { sku: "LP-001", title: "Album One", quantity: 2, unitPrice: 25 },
        { sku: "CD-001", title: "Album Two CD", quantity: 1, unitPrice: 12 },
      ],
      variantsBySku,
      totalWeightOz: 30,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      description: "Album One",
      quantity: 2,
      value: 50, // 2 × 25
      hsTariffNumber: "8523.80.4000",
      originCountry: "US",
    });
    expect(items[1]).toMatchObject({
      description: "Album Two CD",
      quantity: 1,
      value: 12,
      hsTariffNumber: HS_CODE_DEFAULTS.cd,
    });
  });

  it("distributes total weight proportionally to quantity", () => {
    const items = buildCustomsItems({
      lineItems: [
        { sku: "LP-001", title: "Album One", quantity: 3, unitPrice: 25 },
        { sku: "CD-001", title: "Album Two", quantity: 1, unitPrice: 12 },
      ],
      variantsBySku,
      totalWeightOz: 32,
    });
    // 3/4 of 32 = 24, 1/4 of 32 = 8
    expect(items[0]?.weight).toBe(24);
    expect(items[1]?.weight).toBe(8);
  });

  it("uses customs description override when present", () => {
    const items = buildCustomsItems({
      lineItems: [
        {
          sku: "LP-001",
          title: "Some Funky Album Name 2026",
          quantity: 1,
          unitPrice: 25,
          customsDescriptionOverride: "Vinyl Record - 1 piece",
        },
      ],
      variantsBySku,
      totalWeightOz: 16,
    });
    expect(items[0]?.description).toBe("Vinyl Record - 1 piece");
  });

  it("falls through to global HS fallback for unknown SKUs", () => {
    const items = buildCustomsItems({
      lineItems: [{ sku: "MYSTERY-X", title: "Unknown thing", quantity: 1, unitPrice: 5 }],
      variantsBySku,
      totalWeightOz: 16,
    });
    expect(items[0]?.hsTariffNumber).toBe(HS_CODE_GLOBAL_FALLBACK);
  });

  it("filters out zero-quantity lines", () => {
    const items = buildCustomsItems({
      lineItems: [
        { sku: "LP-001", title: "A", quantity: 0, unitPrice: 25 },
        { sku: "CD-001", title: "B", quantity: 1, unitPrice: 12 },
      ],
      variantsBySku,
      totalWeightOz: 16,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("B");
  });

  it("never declares zero weight per line (minimum 0.1oz)", () => {
    const items = buildCustomsItems({
      lineItems: [{ sku: "LP-001", title: "A", quantity: 1, unitPrice: 25 }],
      variantsBySku,
      totalWeightOz: 0,
    });
    expect(items[0]?.weight).toBeGreaterThan(0);
  });
});

describe("aggregateParcelDimensions (Phase 0.5.6)", () => {
  const dimsBySku = new Map<string, VariantDimensions>([
    ["LP-001", { sku: "LP-001", lengthIn: 13, widthIn: 13, heightIn: 0.5 }],
    ["7IN-001", { sku: "7IN-001", lengthIn: 7.5, widthIn: 7.5, heightIn: 0.25 }],
    ["BOXSET-001", { sku: "BOXSET-001", lengthIn: 14, widthIn: 14, heightIn: 4 }],
    ["CD-001", { sku: "CD-001", lengthIn: 5.5, widthIn: 5, heightIn: 0.4 }],
  ]);

  it("returns null result when no variant has dimensions", () => {
    expect(aggregateParcelDimensions(["UNKNOWN"], dimsBySku)).toEqual({
      length: null,
      width: null,
      height: null,
    });
  });

  it("returns the variant's dimensions when only one variant in shipment", () => {
    expect(aggregateParcelDimensions(["LP-001"], dimsBySku)).toEqual({
      length: 13,
      width: 13,
      height: 0.5,
    });
  });

  it("takes MAX on each axis across multiple variants (LP + 7-inch + CD)", () => {
    const result = aggregateParcelDimensions(["LP-001", "7IN-001", "CD-001"], dimsBySku);
    expect(result).toEqual({ length: 13, width: 13, height: 0.5 });
  });

  it("box set wins over LP (taller + slightly larger footprint)", () => {
    const result = aggregateParcelDimensions(["LP-001", "BOXSET-001"], dimsBySku);
    expect(result).toEqual({ length: 14, width: 14, height: 4 });
  });

  it("ignores null/undefined SKUs in the input list", () => {
    const result = aggregateParcelDimensions(["LP-001", null, undefined, "CD-001"], dimsBySku);
    expect(result).toEqual({ length: 13, width: 13, height: 0.5 });
  });
});
