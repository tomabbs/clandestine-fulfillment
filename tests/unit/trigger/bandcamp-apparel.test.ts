import { describe, expect, it } from "vitest";
import { buildShopifyVariantInput } from "@/lib/clients/shopify-variant-input";
import {
  detectMultiVariantOptions,
  inferOptionName,
  optionDisplayValue,
} from "@/trigger/lib/bandcamp-apparel";

describe("detectMultiVariantOptions", () => {
  it("returns null for null/empty input", () => {
    expect(detectMultiVariantOptions(null)).toBeNull();
    expect(detectMultiVariantOptions(undefined)).toBeNull();
    expect(detectMultiVariantOptions([])).toBeNull();
  });

  it("returns null for single-option packages", () => {
    expect(
      detectMultiVariantOptions([
        { option_id: 1, sku: "ABC-001", title: "One Size", quantity_available: 5 },
      ]),
    ).toBeNull();
  });

  it("returns null when only one unique SKU repeats across options", () => {
    expect(
      detectMultiVariantOptions([
        { option_id: 1, sku: "PKG-001", title: "Small", quantity_available: 3 },
        { option_id: 2, sku: "pkg-001", title: "Medium", quantity_available: 4 },
      ]),
    ).toBeNull();
  });

  it("ignores options with empty/whitespace SKUs", () => {
    expect(
      detectMultiVariantOptions([
        { option_id: 1, sku: "ABC-S", title: "Small", quantity_available: 1 },
        { option_id: 2, sku: "   ", title: "Medium", quantity_available: 2 },
      ]),
    ).toBeNull();
  });

  it("normalizes a multi-SKU apparel package to ordered options", () => {
    const result = detectMultiVariantOptions([
      { option_id: 11, sku: "TEE-S", title: "Small", quantity_available: 3 },
      { option_id: 12, sku: " TEE-M ", title: "Medium", quantity_available: 5 },
      { option_id: 13, sku: "TEE-L", title: "Large", quantity_available: null },
    ]);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result?.[0]).toEqual({
      optionId: 11,
      sku: "TEE-S",
      title: "Small",
      quantityAvailable: 3,
    });
    expect(result?.[1].sku).toBe("TEE-M");
    expect(result?.[2].quantityAvailable).toBe(0);
  });

  it("dedupes by uppercase SKU but preserves distinct entries", () => {
    const result = detectMultiVariantOptions([
      { option_id: 1, sku: "Tee-S", title: "Small", quantity_available: 2 },
      { option_id: 2, sku: "tee-s", title: "Small (dup)", quantity_available: 9 },
      { option_id: 3, sku: "TEE-M", title: "Medium", quantity_available: 4 },
    ]);
    expect(result).toHaveLength(2);
    expect(result?.[0].sku).toBe("Tee-S");
    expect(result?.[0].quantityAvailable).toBe(2);
    expect(result?.[1].sku).toBe("TEE-M");
  });
});

describe("inferOptionName", () => {
  it("returns Size for clear size token sets", () => {
    expect(inferOptionName(["Small", "Medium", "Large", "XL"])).toBe("Size");
    expect(inferOptionName(["S", "M", "L"])).toBe("Size");
  });

  it("returns Color when color tokens dominate", () => {
    expect(inferOptionName(["Black", "White", "Red"])).toBe("Color");
  });

  it("falls back to Variant for unknown tokens", () => {
    expect(inferOptionName(["Standard Edition", "Deluxe Edition"])).toBe("Variant");
  });

  it("never returns Title (would collapse Shopify variants)", () => {
    expect(inferOptionName(["Small", "Medium"])).not.toBe("Title");
    expect(inferOptionName([])).not.toBe("Title");
    expect(inferOptionName([])).toBe("Variant");
  });
});

describe("optionDisplayValue", () => {
  it("uses title when present", () => {
    expect(
      optionDisplayValue({ optionId: 1, sku: "X", title: "Small", quantityAvailable: 0 }, 0),
    ).toBe("Small");
  });

  it("falls back to indexed label when title is empty", () => {
    expect(optionDisplayValue({ optionId: 1, sku: "X", title: "", quantityAvailable: 0 }, 2)).toBe(
      "Option 3",
    );
  });
});

describe("buildShopifyVariantInput (option-aware)", () => {
  it("preserves legacy single-variant behavior by default", () => {
    const out = buildShopifyVariantInput({ sku: "ABC-001", price: 25 });
    expect(out.optionValues).toEqual([{ optionName: "Title", name: "Default Title" }]);
    expect(out.sku).toBe("ABC-001");
  });

  it("emits Size/Small for apparel options", () => {
    const out = buildShopifyVariantInput({
      sku: "TEE-S",
      optionName: "Size",
      optionValue: "Small",
      price: 30,
    });
    expect(out.optionValues).toEqual([{ optionName: "Size", name: "Small" }]);
    expect(out.sku).toBe("TEE-S");
    // Always tracked + DENY oversell — non-negotiable invariants.
    expect(out.inventoryItem.tracked).toBe(true);
    expect(out.inventoryPolicy).toBe("DENY");
  });
});
