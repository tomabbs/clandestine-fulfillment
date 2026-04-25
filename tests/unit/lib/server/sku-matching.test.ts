import { describe, expect, it } from "vitest";
import { buildCandidateFingerprint, rankSkuCandidates } from "@/lib/server/sku-matching";

describe("rankSkuCandidates", () => {
  const canonical = {
    variantId: "var_1",
    sku: "TP-001-LP",
    barcode: "123456789012",
    artist: "True Panther",
    title: "Blue Vinyl",
    bandcampTitle: "Blue Vinyl",
    format: "LP",
    variantTitle: "Blue LP",
    optionValue: "Blue",
    isPreorder: false,
    price: 24,
    bandcampOptionId: null,
    bandcampOptionTitle: "Blue",
    bandcampOriginQuantities: null,
  } as const;

  it("prefers exact SKU matches over title-only matches", () => {
    const ranked = rankSkuCandidates(canonical, [
      {
        platform: "shopify",
        remoteProductId: "prod-title",
        remoteVariantId: "var-title",
        remoteInventoryItemId: "inv-title",
        remoteSku: null,
        productTitle: "True Panther - Blue Vinyl LP",
        variantTitle: "Blue",
        combinedTitle: "True Panther - Blue Vinyl LP - Blue",
        productType: "LP",
        productUrl: null,
        price: 24,
        barcode: null,
        quantity: 1,
      },
      {
        platform: "shopify",
        remoteProductId: "prod-sku",
        remoteVariantId: "var-sku",
        remoteInventoryItemId: "inv-sku",
        remoteSku: "tp-001-lp",
        productTitle: "Different title",
        variantTitle: "Blue",
        combinedTitle: "Different title - Blue",
        productType: "LP",
        productUrl: null,
        price: 24,
        barcode: "123456789012",
        quantity: 1,
      },
    ]);

    expect(ranked[0]?.remote.remoteProductId).toBe("prod-sku");
    expect(ranked[0]?.confidenceTier).toBe("deterministic");
    expect(ranked[0]?.reasons).toContain("Exact SKU match");
  });

  it("adds a disqualifier when a remote item has neither sku nor barcode", () => {
    const ranked = rankSkuCandidates(canonical, [
      {
        platform: "woocommerce",
        remoteProductId: "prod-1",
        remoteVariantId: "var-1",
        remoteInventoryItemId: null,
        remoteSku: null,
        productTitle: "True Panther - Blue Vinyl",
        variantTitle: null,
        combinedTitle: "True Panther - Blue Vinyl",
        productType: "LP",
        productUrl: null,
        price: 24,
        barcode: null,
        quantity: 3,
      },
    ]);

    expect(ranked[0]?.disqualifiers).toContain("blank_sku_no_other_id");
    expect(ranked[0]?.confidenceTier).toBe("conflict");
  });
});

describe("buildCandidateFingerprint", () => {
  it("stays stable for equivalent normalized input", () => {
    const a = buildCandidateFingerprint({
      variantId: "var_1",
      canonicalSku: " tp-001-lp ",
      canonicalBarcode: "123-456-789-012",
      remoteProductId: "prod_1",
      remoteVariantId: "var_remote_1",
      remoteInventoryItemId: "gid://shopify/InventoryItem/123",
      remoteSku: "TP-001-LP",
      existingMappingId: "map_1",
      existingMappingUpdatedAt: "2026-04-25T12:00:00.000Z",
      conflictCount: 0,
    });

    const b = buildCandidateFingerprint({
      variantId: "var_1",
      canonicalSku: "TP-001-LP",
      canonicalBarcode: "123456789012",
      remoteProductId: "prod_1",
      remoteVariantId: "var_remote_1",
      remoteInventoryItemId: "gid://shopify/InventoryItem/123",
      remoteSku: " tp-001-lp ",
      existingMappingId: "map_1",
      existingMappingUpdatedAt: "2026-04-25T12:00:00.000Z",
      conflictCount: 0,
    });

    expect(a).toBe(b);
  });

  it("changes when the remote identity changes", () => {
    const base = buildCandidateFingerprint({
      variantId: "var_1",
      canonicalSku: "TP-001-LP",
      canonicalBarcode: null,
      remoteProductId: "prod_1",
      remoteVariantId: "var_remote_1",
      remoteInventoryItemId: null,
      remoteSku: "TP-001-LP",
      existingMappingId: null,
      existingMappingUpdatedAt: null,
      conflictCount: 0,
    });
    const changed = buildCandidateFingerprint({
      variantId: "var_1",
      canonicalSku: "TP-001-LP",
      canonicalBarcode: null,
      remoteProductId: "prod_2",
      remoteVariantId: "var_remote_1",
      remoteInventoryItemId: null,
      remoteSku: "TP-001-LP",
      existingMappingId: null,
      existingMappingUpdatedAt: null,
      conflictCount: 0,
    });

    expect(base).not.toBe(changed);
  });
});
