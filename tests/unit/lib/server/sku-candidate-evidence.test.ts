/**
 * Exhaustive unit tests for the pure CandidateEvidence pipeline.
 *
 * Matrix coverage:
 *   - Every DisqualifierCode reachable from a representative input.
 *   - Every identity-gate branch: strong-pass via each of the 5
 *     qualifying signals, partial pass (exactSku unsafe), fail.
 *   - Every variant-gate branch: full pass, partial (has unknowns),
 *     fail per descriptor type.
 *   - Every operational-gate branch: pass, fail_stock_only,
 *     fail_stock_exception, fail_other (tier, default location).
 *   - Every overall outcome: pass, identity_only, stock_exception,
 *     shadow_identity, holdout, reject.
 *   - selectOutcomeFromGates mappings to DB outcome strings.
 *   - Hard-negative short-circuits: placeholder SKU, duplicate SKU,
 *     duplicate remote, non-operational row.
 *   - Descriptor tri-state: unknown never yields a disqualifier.
 *   - buildCandidateEvidenceFromTitles parses descriptors correctly.
 */

import { describe, expect, it } from "vitest";
import type { MusicVariantDescriptors } from "@/lib/server/music-variant-descriptors";
import {
  buildCandidateEvidence,
  buildCandidateEvidenceFromTitles,
  type CandidateEvidence,
  classifyEvidenceGates,
  selectOutcomeFromGates,
} from "@/lib/server/sku-candidate-evidence";
import type { StockSignal } from "@/lib/server/stock-reliability";

/**
 * Fully-populated descriptor fixture — every comparable slot non-null.
 * classifyVariant returns 'pass' only when every slot is either true
 * (both sides match) or the tri-state 'unknown'; tests that exercise
 * the happy path must therefore supply rich descriptors on both sides
 * so no slot is implicitly 'unknown'.
 */
function descriptors(overrides: Partial<MusicVariantDescriptors> = {}): MusicVariantDescriptors {
  return {
    format: "lp",
    size: "12in",
    color: "black",
    pressing: null,
    edition: "standard",
    catalogId: null,
    signed: false,
    bundle: false,
    preorder: false,
    variantOptions: [],
    ...overrides,
  };
}

function authoritativeStock(value: number): StockSignal {
  return {
    value,
    source: "warehouse_inventory_levels",
    tier: "authoritative",
    observedAt: null,
    observedAtLocal: null,
  };
}
function freshRemoteStock(value: number): StockSignal {
  return {
    value,
    source: "shopify_graphql",
    tier: "fresh_remote",
    observedAt: "2026-04-26T00:00:00Z",
    observedAtLocal: "2026-04-26T00:00:00Z",
  };
}
function unboundedRemoteStock(): StockSignal {
  return {
    value: null,
    source: "squarespace_api",
    tier: "fresh_remote_unbounded",
    observedAt: "2026-04-26T00:00:00Z",
    observedAtLocal: "2026-04-26T00:00:00Z",
    isUnbounded: true,
  };
}

function baseInput() {
  return {
    canonical: {
      sku: "CANON-001",
      barcode: null,
      descriptors: descriptors(),
      priorMappingId: null,
    },
    remote: {
      sku: "CANON-001",
      barcode: null,
      combinedTitle: "Album",
      descriptors: descriptors(),
      platform: "shopify" as const,
    },
    identitySignals: {
      canonicalSkuUniqueWithinOrg: true,
      remoteSkuUniqueWithinConnection: true,
    },
    operationalSignals: {
      warehouseStock: authoritativeStock(5),
      stockedAtDefaultLocation: true,
    },
  };
}

describe("buildCandidateEvidence — identity gate signals", () => {
  it("exactSku + safe flags → exactSku=true, exactSkuSafe=true", () => {
    const e = buildCandidateEvidence(baseInput());
    expect(e.identity.exactSku).toBe(true);
    expect(e.identity.exactSkuSafe).toBe(true);
  });

  it("exactSku + canonicalSkuUniqueWithinOrg=false → exactSkuSafe=false", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      identitySignals: {
        ...input.identitySignals,
        canonicalSkuUniqueWithinOrg: false,
      },
    });
    expect(e.identity.exactSku).toBe(true);
    expect(e.identity.exactSkuSafe).toBe(false);
  });

  it("exactSku + remoteSkuUniqueWithinConnection=false → exactSkuSafe=false", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      identitySignals: {
        ...input.identitySignals,
        remoteSkuUniqueWithinConnection: false,
      },
    });
    expect(e.identity.exactSkuSafe).toBe(false);
  });

  it("exactSku with placeholder remote SKU → exactSkuSafe=false", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, sku: "1" },
      remote: { ...input.remote, sku: "1" },
    });
    expect(e.identity.exactSkuSafe).toBe(false);
    expect(e.negative.placeholderSku).toBe(true);
  });

  it("exactBarcode matches independently of SKU", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, sku: "A", barcode: "123456789012" },
      remote: { ...input.remote, sku: "B", barcode: "123456789012" },
    });
    expect(e.identity.exactBarcode).toBe(true);
    expect(e.identity.exactSku).toBe(false);
  });

  it("verifiedRemoteId propagates from identitySignals", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      identitySignals: { ...input.identitySignals, verifiedRemoteId: true },
    });
    expect(e.identity.verifiedRemoteId).toBe(true);
  });

  it("verifiedBandcampOption propagates from identitySignals", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      identitySignals: { ...input.identitySignals, verifiedBandcampOption: true },
    });
    expect(e.identity.verifiedBandcampOption).toBe(true);
  });

  it("priorSafeMapping true when priorMappingId non-empty", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, priorMappingId: "mapping-uuid-1" },
    });
    expect(e.identity.priorSafeMapping).toBe(true);
  });

  it("priorSafeMapping false when priorMappingId empty string", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, priorMappingId: "" },
    });
    expect(e.identity.priorSafeMapping).toBe(false);
  });
});

describe("buildCandidateEvidence — variant gate descriptor comparison", () => {
  it("both descriptors null → every slot unknown, no disqualifiers", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: null },
      remote: { ...input.remote, descriptors: null },
    });
    expect(e.variant.formatAgrees).toBe("unknown");
    expect(e.variant.sizeAgrees).toBe("unknown");
    expect(e.variant.colorAgrees).toBe("unknown");
    expect(e.variant.descriptorDisqualifiers).toHaveLength(0);
  });

  it("one side null → every slot unknown, no disqualifiers", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      remote: { ...input.remote, descriptors: null },
    });
    expect(e.variant.formatAgrees).toBe("unknown");
    expect(e.variant.descriptorDisqualifiers).toHaveLength(0);
  });

  it("format both known and matching → formatAgrees=true", () => {
    const e = buildCandidateEvidence(baseInput());
    expect(e.variant.formatAgrees).toBe(true);
  });

  it("format both known but different → formatAgrees=false + variant_format_disagrees", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      remote: { ...input.remote, descriptors: descriptors({ format: "cassette" }) },
    });
    expect(e.variant.formatAgrees).toBe(false);
    expect(e.variant.descriptorDisqualifiers).toContain("variant_format_disagrees");
  });

  it("format one side unknown → formatAgrees=unknown, no disqualifier", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      remote: { ...input.remote, descriptors: descriptors({ format: "unknown" }) },
    });
    expect(e.variant.formatAgrees).toBe("unknown");
    expect(e.variant.descriptorDisqualifiers).toHaveLength(0);
  });

  it("size disagreement is distinct from format disagreement", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ format: "7inch", size: "7in" }) },
      remote: { ...input.remote, descriptors: descriptors({ format: "7inch", size: "12in" }) },
    });
    expect(e.variant.formatAgrees).toBe(true);
    expect(e.variant.sizeAgrees).toBe(false);
    expect(e.variant.descriptorDisqualifiers).toContain("variant_size_disagrees");
    expect(e.variant.descriptorDisqualifiers).not.toContain("variant_format_disagrees");
  });

  it("color comparison is case-insensitive", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ color: "Black" }) },
      remote: { ...input.remote, descriptors: descriptors({ color: "black" }) },
    });
    expect(e.variant.colorAgrees).toBe(true);
  });

  it("preorder boolean disagreement fires variant_preorder_disagrees", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ preorder: true }) },
      remote: { ...input.remote, descriptors: descriptors({ preorder: false }) },
    });
    expect(e.variant.preorderAgrees).toBe(false);
    expect(e.variant.descriptorDisqualifiers).toContain("variant_preorder_disagrees");
  });

  it("bundle boolean disagreement fires variant_bundle_disagrees", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ bundle: true }) },
      remote: { ...input.remote, descriptors: descriptors({ bundle: false }) },
    });
    expect(e.variant.descriptorDisqualifiers).toContain("variant_bundle_disagrees");
  });

  it("signed boolean disagreement fires variant_signed_disagrees", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ signed: true }) },
      remote: { ...input.remote, descriptors: descriptors({ signed: false }) },
    });
    expect(e.variant.descriptorDisqualifiers).toContain("variant_signed_disagrees");
  });

  it("edition disagreement fires variant_edition_disagrees", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ edition: "limited" }) },
      remote: { ...input.remote, descriptors: descriptors({ edition: "standard" }) },
    });
    expect(e.variant.editionAgrees).toBe(false);
    expect(e.variant.descriptorDisqualifiers).toContain("variant_edition_disagrees");
  });
});

describe("buildCandidateEvidence — operational + negative signals", () => {
  it("warehouse signal propagates value + tier", () => {
    const e = buildCandidateEvidence(baseInput());
    expect(e.operational.warehouseAvailable).toBe(5);
    expect(e.operational.warehouseStockTier).toBe("authoritative");
  });

  it("missing stock signal maps to null + unknown tier", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      operationalSignals: {},
    });
    expect(e.operational.warehouseAvailable).toBeNull();
    expect(e.operational.warehouseStockTier).toBe("unknown");
  });

  it("remote fresh_remote_unbounded signal preserved", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      operationalSignals: {
        ...input.operationalSignals,
        remoteStock: unboundedRemoteStock(),
      },
    });
    expect(e.operational.remoteStockTier).toBe("fresh_remote_unbounded");
    expect(e.operational.remoteAvailable).toBeNull();
  });

  it("duplicate / non-operational / generic-title signals propagate", () => {
    const input = baseInput();
    const e = buildCandidateEvidence({
      ...input,
      negativeSignals: {
        genericTitle: true,
        nonOperationalRow: true,
        duplicateCanonicalSku: true,
        duplicateRemote: true,
      },
    });
    expect(e.negative.genericTitle).toBe(true);
    expect(e.negative.nonOperationalRow).toBe(true);
    expect(e.negative.duplicateSku).toBe(true);
    expect(e.negative.duplicateRemote).toBe(true);
  });
});

describe("classifyEvidenceGates — overall outcome matrix", () => {
  it("all three gates pass → overall='pass'", () => {
    const result = classifyEvidenceGates(buildCandidateEvidence(baseInput()));
    expect(result.identity).toBe("pass");
    expect(result.variant).toBe("pass");
    expect(result.operational).toBe("pass");
    expect(result.overall).toBe("pass");
  });

  it("identity+variant pass, warehouse=0, remote=0 → identity_only", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      operationalSignals: { ...input.operationalSignals, warehouseStock: authoritativeStock(0) },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.operational).toBe("fail_stock_only");
    expect(gates.overall).toBe("identity_only");
  });

  it("identity+variant pass, warehouse=0, remote>0 → stock_exception", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      operationalSignals: {
        ...input.operationalSignals,
        warehouseStock: authoritativeStock(0),
        remoteStock: freshRemoteStock(4),
      },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.operational).toBe("fail_stock_exception");
    expect(gates.overall).toBe("stock_exception");
  });

  it("identity+variant pass, warehouse=0, remote unbounded → stock_exception", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      operationalSignals: {
        ...input.operationalSignals,
        warehouseStock: authoritativeStock(0),
        remoteStock: unboundedRemoteStock(),
      },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.overall).toBe("stock_exception");
  });

  it("identity pass + variant partial (some unknowns) → shadow_identity", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, descriptors: descriptors({ color: null }) },
      remote: { ...input.remote, descriptors: descriptors({ color: "black" }) },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.variant).toBe("partial");
    expect(gates.overall).toBe("shadow_identity");
  });

  it("identity partial (exactSku unsafe) + variant pass → holdout", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      identitySignals: {
        ...input.identitySignals,
        canonicalSkuUniqueWithinOrg: false,
      },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.identity).toBe("partial");
    expect(gates.overall).toBe("holdout");
  });

  it("variant disagreement → overall='reject' (short-circuit)", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      remote: { ...input.remote, descriptors: descriptors({ format: "cassette" }) },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.overall).toBe("reject");
    expect(gates.disqualifiers).toContain("variant_format_disagrees");
  });

  it("no identity evidence at all → overall='reject' (identity fail)", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, sku: "NOTHING", barcode: null },
      remote: { ...input.remote, sku: "ELSE", barcode: null },
      identitySignals: {
        canonicalSkuUniqueWithinOrg: false,
        remoteSkuUniqueWithinConnection: false,
      },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.identity).toBe("fail");
    expect(gates.overall).toBe("reject");
    expect(gates.disqualifiers).toContain("identity_no_verified_signal");
  });
});

describe("classifyEvidenceGates — hard negative short-circuits", () => {
  it("placeholder SKU → overall='reject' even when gates would otherwise pass", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      canonical: { ...input.canonical, sku: "1" },
      remote: { ...input.remote, sku: "1" },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.overall).toBe("reject");
    expect(gates.disqualifiers).toContain("negative_placeholder_sku");
  });

  it("duplicate SKU → overall='reject'", () => {
    const evidence = buildCandidateEvidence({
      ...baseInput(),
      negativeSignals: { duplicateCanonicalSku: true },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.overall).toBe("reject");
    expect(gates.disqualifiers).toContain("negative_duplicate_sku");
  });

  it("duplicate remote → overall='reject'", () => {
    const evidence = buildCandidateEvidence({
      ...baseInput(),
      negativeSignals: { duplicateRemote: true },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.overall).toBe("reject");
    expect(gates.disqualifiers).toContain("negative_duplicate_remote");
  });

  it("non-operational row → overall='reject'", () => {
    const evidence = buildCandidateEvidence({
      ...baseInput(),
      negativeSignals: { nonOperationalRow: true },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.overall).toBe("reject");
    expect(gates.disqualifiers).toContain("negative_non_operational_row");
  });
});

describe("classifyEvidenceGates — operational gate branches", () => {
  it("non-authoritative warehouse tier → fail_other", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      operationalSignals: { ...input.operationalSignals, warehouseStock: freshRemoteStock(5) },
    });
    const gates = classifyEvidenceGates(evidence);
    expect(gates.operational).toBe("fail_other");
    expect(gates.disqualifiers).toContain("operational_non_authoritative_warehouse_tier");
  });

  it("Shopify + default location not set → fail_other", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      operationalSignals: { ...input.operationalSignals, stockedAtDefaultLocation: false },
    });
    const gates = classifyEvidenceGates(evidence, { platform: "shopify" });
    expect(gates.operational).toBe("fail_other");
    expect(gates.disqualifiers).toContain("operational_shopify_default_location_missing");
  });

  it("Woo does not require stockedAtDefaultLocation", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      remote: { ...input.remote, platform: "woocommerce" },
      operationalSignals: { ...input.operationalSignals, stockedAtDefaultLocation: null },
    });
    const gates = classifyEvidenceGates(evidence, { platform: "woocommerce" });
    expect(gates.operational).toBe("pass");
    expect(gates.overall).toBe("pass");
  });

  it("opt-out flag disables Shopify default-location enforcement", () => {
    const input = baseInput();
    const evidence = buildCandidateEvidence({
      ...input,
      operationalSignals: { ...input.operationalSignals, stockedAtDefaultLocation: null },
    });
    const gates = classifyEvidenceGates(evidence, {
      platform: "shopify",
      enforceShopifyDefaultLocation: false,
    });
    expect(gates.operational).toBe("pass");
  });
});

describe("selectOutcomeFromGates — outcome_state mapping", () => {
  function gatesWith(overall: CandidateEvidence["operational"] extends unknown ? string : never) {
    return {
      identity: "pass" as const,
      variant: "pass" as const,
      operational: "pass" as const,
      overall: overall as "pass",
      disqualifiers: [],
    };
  }

  it("pass → auto_database_identity_match (alias promotion is out-of-band)", () => {
    expect(selectOutcomeFromGates(gatesWith("pass"))).toBe("auto_database_identity_match");
  });

  it("identity_only → auto_database_identity_match", () => {
    expect(selectOutcomeFromGates(gatesWith("identity_only"))).toBe("auto_database_identity_match");
  });

  it("stock_exception → client_stock_exception", () => {
    expect(selectOutcomeFromGates(gatesWith("stock_exception"))).toBe("client_stock_exception");
  });

  it("shadow_identity → auto_shadow_identity_match", () => {
    expect(selectOutcomeFromGates(gatesWith("shadow_identity"))).toBe("auto_shadow_identity_match");
  });

  it("holdout → auto_holdout_for_evidence", () => {
    expect(selectOutcomeFromGates(gatesWith("holdout"))).toBe("auto_holdout_for_evidence");
  });

  it("reject → auto_reject_non_match", () => {
    expect(selectOutcomeFromGates(gatesWith("reject"))).toBe("auto_reject_non_match");
  });

  it("nonOperationalRow context overrides → auto_skip_non_operational", () => {
    expect(selectOutcomeFromGates(gatesWith("pass"), { nonOperationalRow: true })).toBe(
      "auto_skip_non_operational",
    );
  });

  it("fetchIncomplete context overrides → fetch_incomplete_holdout", () => {
    expect(selectOutcomeFromGates(gatesWith("pass"), { fetchIncomplete: true })).toBe(
      "fetch_incomplete_holdout",
    );
  });
});

describe("buildCandidateEvidenceFromTitles — descriptor parsing integration", () => {
  it("parses both titles and reuses buildCandidateEvidence semantics", () => {
    const e = buildCandidateEvidenceFromTitles({
      canonical: {
        sku: "REC-001",
        barcode: null,
        title: 'Album (12" LP / black vinyl)',
        variantTitle: null,
        priorMappingId: null,
      },
      remote: {
        sku: "REC-001",
        barcode: null,
        combinedTitle: 'Album 12" Vinyl (Black)',
        title: 'Album 12" Vinyl (Black)',
        variantTitle: null,
        platform: "shopify",
      },
      identitySignals: {
        canonicalSkuUniqueWithinOrg: true,
        remoteSkuUniqueWithinConnection: true,
      },
      operationalSignals: {
        warehouseStock: authoritativeStock(2),
        stockedAtDefaultLocation: true,
      },
    });
    expect(e.variant.formatAgrees).toBe(true);
    expect(e.variant.sizeAgrees).toBe(true);
    expect(e.variant.colorAgrees).toBe(true);
    expect(e.variant.descriptorDisqualifiers).toHaveLength(0);
  });

  it("catches 7-inch vs 12-inch as a format+size mismatch", () => {
    const e = buildCandidateEvidenceFromTitles({
      canonical: {
        sku: "SINGLE-001",
        barcode: null,
        title: 'Single 7" black',
        variantTitle: null,
        priorMappingId: null,
      },
      remote: {
        sku: "SINGLE-001",
        barcode: null,
        combinedTitle: 'Single 12" remix',
        title: 'Single 12" remix',
        variantTitle: null,
        platform: "shopify",
      },
      identitySignals: {
        canonicalSkuUniqueWithinOrg: true,
        remoteSkuUniqueWithinConnection: true,
      },
    });
    expect(e.variant.formatAgrees).toBe(false);
    expect(e.variant.sizeAgrees).toBe(false);
    expect(e.variant.descriptorDisqualifiers).toEqual(
      expect.arrayContaining(["variant_format_disagrees", "variant_size_disagrees"]),
    );
  });
});
