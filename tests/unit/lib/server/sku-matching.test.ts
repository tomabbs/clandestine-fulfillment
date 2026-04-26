import { describe, expect, it } from "vitest";
import type { RankSkuEvidenceContext, RemoteCatalogItem } from "@/lib/server/sku-matching";
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
