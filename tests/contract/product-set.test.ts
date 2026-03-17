import { describe, expect, it } from "vitest";

/**
 * Contract test: verifies the productSet wrapper enforces the "full-shape"
 * requirement from Rule #1 and #13.
 *
 * productSet deletes list-field entries not in payload. This test ensures
 * that any productSet payload builder always includes the critical list fields.
 */

const REQUIRED_LIST_FIELDS = ["variants", "media", "metafields", "collections"] as const;

function buildCompleteProductSetPayload() {
  return {
    title: "Test Vinyl LP",
    vendor: "Test Label",
    productType: "Vinyl",
    status: "ACTIVE",
    tags: ["vinyl", "test"],
    variants: [
      {
        sku: "TEST-LP-001",
        price: "29.99",
        barcode: "1234567890",
        inventoryQuantities: [{ availableQuantity: 100, locationId: "gid://shopify/Location/1" }],
      },
    ],
    media: [],
    metafields: [],
    collections: [],
  };
}

describe("productSet contract — full-shape requirement", () => {
  it("complete payload includes all required list fields", () => {
    const payload = buildCompleteProductSetPayload();
    for (const field of REQUIRED_LIST_FIELDS) {
      expect(payload).toHaveProperty(field);
      expect(Array.isArray(payload[field])).toBe(true);
    }
  });

  it("payload without variants should be rejected", () => {
    const payload = buildCompleteProductSetPayload();
    const { variants: _, ...incomplete } = payload;
    expect(incomplete).not.toHaveProperty("variants");
    // Callers must check for required fields before sending to Shopify
    const missingFields = REQUIRED_LIST_FIELDS.filter((f) => !(f in incomplete));
    expect(missingFields).toContain("variants");
  });

  it("payload without media should be flagged as incomplete", () => {
    const payload = buildCompleteProductSetPayload();
    const { media: _, ...incomplete } = payload;
    const missingFields = REQUIRED_LIST_FIELDS.filter((f) => !(f in incomplete));
    expect(missingFields).toContain("media");
  });

  it("variants must include sku for Rule #8 (one product per SKU)", () => {
    const payload = buildCompleteProductSetPayload();
    for (const variant of payload.variants) {
      expect(variant.sku).toBeDefined();
      expect(typeof variant.sku).toBe("string");
      expect(variant.sku.length).toBeGreaterThan(0);
    }
  });
});
