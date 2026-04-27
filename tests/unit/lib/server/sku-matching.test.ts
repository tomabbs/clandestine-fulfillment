import { describe, expect, it } from "vitest";
import type { RankSkuEvidenceContext, RemoteCatalogItem } from "@/lib/server/sku-matching";
import {
  buildCandidateFingerprint,
  pickPrimaryBandcampMapping,
  rankSkuCandidates,
  selectConnectionScopedRemoteTarget,
} from "@/lib/server/sku-matching";

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

  it("is order-insensitive for disqualifier arrays", () => {
    const first = buildCandidateFingerprint({
      variantId: "var_1",
      canonicalSku: "TP-001-LP",
      canonicalBarcode: null,
      remoteProductId: "prod_1",
      remoteVariantId: "var_remote_1",
      remoteInventoryItemId: null,
      remoteSku: "TP-001-LP",
      existingMappingId: null,
      existingMappingUpdatedAt: null,
      disqualifiers: ["duplicate_sku", "missing_barcode"],
    });
    const second = buildCandidateFingerprint({
      variantId: "var_1",
      canonicalSku: "TP-001-LP",
      canonicalBarcode: null,
      remoteProductId: "prod_1",
      remoteVariantId: "var_remote_1",
      remoteInventoryItemId: null,
      remoteSku: "TP-001-LP",
      existingMappingId: null,
      existingMappingUpdatedAt: null,
      disqualifiers: ["missing_barcode", "duplicate_sku"],
    });

    expect(first).toBe(second);
  });
});

describe("pickPrimaryBandcampMapping", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    bandcamp_url: null,
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: null,
  };

  it("accepts object, array, and null relationship shapes", () => {
    expect(pickPrimaryBandcampMapping(base)?.id).toBe(base.id);
    expect(pickPrimaryBandcampMapping([base])?.id).toBe(base.id);
    expect(pickPrimaryBandcampMapping(null)).toBeNull();
  });

  it("prefers URL-bearing rows, then newest timestamp, then id desc", () => {
    const olderWithUrl = {
      ...base,
      id: "00000000-0000-4000-8000-000000000002",
      bandcamp_url: "https://band.example/older",
      created_at: "2026-04-21T00:00:00.000Z",
    };
    const newerWithoutUrl = {
      ...base,
      id: "00000000-0000-4000-8000-000000000003",
      created_at: "2026-04-22T00:00:00.000Z",
    };
    const newestWithUrl = {
      ...base,
      id: "00000000-0000-4000-8000-000000000004",
      bandcamp_url: "https://band.example/newer",
      updated_at: "2026-04-23T00:00:00.000Z",
    };

    expect(pickPrimaryBandcampMapping([olderWithUrl, newerWithoutUrl, newestWithUrl])?.id).toBe(
      newestWithUrl.id,
    );
  });

  it("uses deterministic descending id fallback when timestamps tie", () => {
    const lowId = { ...base, id: "00000000-0000-4000-8000-000000000010" };
    const highId = { ...base, id: "00000000-0000-4000-8000-000000000011" };

    expect(pickPrimaryBandcampMapping([lowId, highId])?.id).toBe(highId.id);
  });
});

describe("selectConnectionScopedRemoteTarget", () => {
  const productSmall: RemoteCatalogItem = {
    platform: "shopify",
    remoteProductId: "prod-1",
    remoteVariantId: "var-small",
    remoteInventoryItemId: "inv-small",
    remoteSku: "SHIRT-S",
    productTitle: "Label Shirt",
    variantTitle: "Small",
    combinedTitle: "Label Shirt - Small",
    productType: "T-Shirt",
    productUrl: null,
    price: 25,
    barcode: null,
    quantity: null,
  };
  const productMedium = {
    ...productSmall,
    remoteVariantId: "var-medium",
    remoteInventoryItemId: "inv-medium",
    remoteSku: "SHIRT-M",
    variantTitle: "Medium",
    combinedTitle: "Label Shirt - Medium",
  };

  it("chooses inventory item before variant and product fallbacks", () => {
    const result = selectConnectionScopedRemoteTarget({
      items: [productSmall, productMedium],
      remoteInventoryItemId: "inv-medium",
      remoteVariantId: "var-small",
      remoteProductId: "prod-1",
      remoteSku: "SHIRT-S",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.target?.remoteInventoryItemId).toBe("inv-medium");
  });

  it("uses remote SKU to disambiguate product-level fallback", () => {
    const result = selectConnectionScopedRemoteTarget({
      items: [productSmall, productMedium],
      remoteProductId: "prod-1",
      remoteSku: "shirt-m",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.target?.remoteVariantId).toBe("var-medium");
  });

  it("returns an ambiguity error for SKU-less multi-variant product fallback", () => {
    const result = selectConnectionScopedRemoteTarget({
      items: [
        { ...productSmall, remoteSku: null },
        { ...productMedium, remoteSku: null },
      ],
      remoteProductId: "prod-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ambiguous_remote_target");
    expect(result.message).toContain("Please add SKUs in Shopify before matching");
  });
});

describe("rankSkuCandidates — evidenceContext (additive)", () => {
  // Canonical row used in both "legacy" and "evidence" evocations. The
  // LP / Black / size-12 / 12in slots match the default shopify remote
  // in each test so the happy path actually satisfies every variant
  // slot (unknowns route to shadow instead of pass).
  const canonical = {
    variantId: "var_1",
    sku: "TP-001-LP",
    barcode: "123456789012",
    artist: "True Panther",
    title: "Blue Vinyl Standard Edition 12in LP Black",
    bandcampTitle: "Blue Vinyl Standard Edition 12in LP Black",
    format: "LP",
    variantTitle: "LP Black Standard",
    optionValue: "Black",
    isPreorder: false,
    price: 24,
    bandcampOptionId: null,
    bandcampOptionTitle: "Black",
    bandcampOriginQuantities: null,
  } as const;

  const matchingRemote: RemoteCatalogItem = {
    platform: "shopify",
    remoteProductId: "prod-sku",
    remoteVariantId: "var-sku",
    remoteInventoryItemId: "inv-sku",
    remoteSku: "tp-001-lp",
    productTitle: "True Panther - Blue Vinyl 12in LP",
    variantTitle: "LP Black Standard Edition",
    combinedTitle: "True Panther - Blue Vinyl 12in LP - LP Black Standard Edition",
    productType: "LP",
    productUrl: null,
    price: 24,
    barcode: "123456789012",
    quantity: 5,
  };

  it("is zero-break: omitting evidenceContext preserves legacy shape exactly", () => {
    const ranked = rankSkuCandidates(canonical, [matchingRemote]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.evidence).toBeUndefined();
    expect(ranked[0]?.evidenceGates).toBeUndefined();
    expect(ranked[0]?.disqualifierCodes).toBeUndefined();
    expect(ranked[0]?.reasons).toContain("Exact SKU match");
  });

  it("attaches evidence + gates + disqualifier codes when evidenceContext is supplied", () => {
    const ctx: RankSkuEvidenceContext = {
      identity: {
        canonicalSkuUniqueWithinOrg: true,
        remoteSkuUniqueWithinConnection: () => true,
        verifiedRemoteId: () => true,
      },
      operational: {
        warehouseStock: {
          value: 12,
          source: "warehouse_inventory_levels",
          observedAt: "2026-04-25T10:00:00.000Z",
          observedAtLocal: "2026-04-25T10:00:00.000Z",
          tier: "authoritative",
        },
        remoteStock: () => ({
          value: 5,
          source: "shopify_graphql",
          observedAt: "2026-04-25T10:00:05.000Z",
          observedAtLocal: "2026-04-25T10:00:05.000Z",
          tier: "fresh_remote",
        }),
        stockedAtDefaultLocation: () => true,
      },
    };

    const ranked = rankSkuCandidates(canonical, [matchingRemote], ctx);
    expect(ranked).toHaveLength(1);
    const r = ranked[0];
    expect(r).toBeDefined();
    if (!r) throw new Error("unreachable");
    expect(r.evidence).toBeDefined();
    expect(r.evidenceGates).toBeDefined();
    expect(r.disqualifierCodes).toBeDefined();
    expect(r.evidence?.identity.exactSku).toBe(true);
    expect(r.evidence?.identity.exactSkuSafe).toBe(true);
    expect(r.evidence?.operational.warehouseAvailable).toBe(12);
    expect(r.evidenceGates?.identity).toBe("pass");
    expect(r.evidenceGates?.operational).toBe("pass");
    expect(r.evidenceGates?.overall).toBe("pass");
    expect(r.disqualifierCodes?.length ?? 0).toBe(0);
  });

  it("reports hard negatives (placeholder SKU) via disqualifierCodes, overall='reject'", () => {
    const placeholderCandidate = canonical;
    const placeholderRemote = { ...matchingRemote, remoteSku: "N/A" };
    const ctx: RankSkuEvidenceContext = {
      identity: { canonicalSkuUniqueWithinOrg: true },
      operational: {
        warehouseStock: {
          value: 12,
          source: "warehouse_inventory_levels",
          observedAt: "2026-04-25T10:00:00.000Z",
          observedAtLocal: "2026-04-25T10:00:00.000Z",
          tier: "authoritative",
        },
        stockedAtDefaultLocation: () => true,
      },
    };
    const ranked = rankSkuCandidates(placeholderCandidate, [placeholderRemote], ctx);
    expect(ranked).toHaveLength(1);
    const r = ranked[0];
    if (!r) throw new Error("unreachable");
    expect(r.evidence?.negative.placeholderSku).toBe(true);
    expect(r.evidenceGates?.overall).toBe("reject");
    expect(r.disqualifierCodes).toContain("negative_placeholder_sku");
  });

  it("records operational_no_positive_warehouse_stock when warehouse is zero", () => {
    const ctx: RankSkuEvidenceContext = {
      identity: {
        canonicalSkuUniqueWithinOrg: true,
        remoteSkuUniqueWithinConnection: () => true,
      },
      operational: {
        warehouseStock: {
          value: 0,
          source: "warehouse_inventory_levels",
          observedAt: "2026-04-25T10:00:00.000Z",
          observedAtLocal: "2026-04-25T10:00:00.000Z",
          tier: "authoritative",
        },
        remoteStock: () => null,
        stockedAtDefaultLocation: () => true,
      },
    };
    const ranked = rankSkuCandidates(canonical, [matchingRemote], ctx);
    const r = ranked[0];
    if (!r) throw new Error("unreachable");
    expect(r.evidenceGates?.operational).toBe("fail_stock_only");
    expect(r.evidenceGates?.overall).toBe("identity_only");
    expect(r.disqualifierCodes).toContain("operational_no_positive_warehouse_stock");
  });

  it("derives canonical descriptors from title when context omits them", () => {
    const ctx: RankSkuEvidenceContext = {
      identity: {
        canonicalSkuUniqueWithinOrg: true,
        remoteSkuUniqueWithinConnection: () => true,
      },
      operational: {
        warehouseStock: {
          value: 12,
          source: "warehouse_inventory_levels",
          observedAt: "2026-04-25T10:00:00.000Z",
          observedAtLocal: "2026-04-25T10:00:00.000Z",
          tier: "authoritative",
        },
        stockedAtDefaultLocation: () => true,
      },
    };
    const ranked = rankSkuCandidates(canonical, [matchingRemote], ctx);
    const r = ranked[0];
    if (!r) throw new Error("unreachable");
    expect(r.evidence?.variant.formatAgrees).toBe(true);
  });

  it("platform defaults to each candidate's remote.platform for gate evaluation", () => {
    const wooCandidate: RemoteCatalogItem = {
      ...matchingRemote,
      platform: "woocommerce",
      remoteInventoryItemId: null,
    };
    const ctx: RankSkuEvidenceContext = {
      identity: {
        canonicalSkuUniqueWithinOrg: true,
        remoteSkuUniqueWithinConnection: () => true,
      },
      operational: {
        warehouseStock: {
          value: 12,
          source: "warehouse_inventory_levels",
          observedAt: "2026-04-25T10:00:00.000Z",
          observedAtLocal: "2026-04-25T10:00:00.000Z",
          tier: "authoritative",
        },
        // Woo doesn't expose stockedAtDefaultLocation — gate must still pass.
        stockedAtDefaultLocation: () => null,
      },
    };
    const ranked = rankSkuCandidates(canonical, [wooCandidate], ctx);
    const r = ranked[0];
    if (!r) throw new Error("unreachable");
    expect(r.evidenceGates?.operational).toBe("pass");
    expect(r.evidenceGates?.overall).toBe("pass");
  });
});
