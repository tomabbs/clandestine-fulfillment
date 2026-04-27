import { describe, expect, it } from "vitest";
import { selectDryRunDecision, serializeTopCandidates } from "@/lib/server/sku-autonomous-dry-run";
import type { RankedSkuCandidate } from "@/lib/server/sku-matching";

function candidate(
  confidenceTier: RankedSkuCandidate["confidenceTier"],
  overrides: Partial<RankedSkuCandidate> = {},
): RankedSkuCandidate {
  return {
    remote: {
      platform: "shopify",
      remoteProductId: "product-1",
      remoteVariantId: "variant-1",
      remoteInventoryItemId: "inventory-1",
      remoteSku: "ABC-123",
      productTitle: "Artist - Album",
      variantTitle: "LP",
      combinedTitle: "Artist - Album - LP",
      productType: "Vinyl",
      productUrl: "https://example.test/product",
      price: 22,
      barcode: "123456789012",
      quantity: 4,
    },
    score: confidenceTier === "deterministic" ? 100 : 70,
    matchMethod: "exact_sku",
    confidenceTier,
    reasons: ["exact_sku"],
    disqualifiers: [],
    ...overrides,
  };
}

describe("sku autonomous dry-run decision shaping", () => {
  it("treats existing active aliases as live aliases without proposing identity writes", () => {
    const decision = selectDryRunDecision({
      existingMapping: {
        id: "mapping-1",
        variant_id: "variant-1",
        remote_sku: "ABC-123",
        remote_product_id: "product-1",
        remote_variant_id: "variant-1",
        remote_inventory_item_id: "inventory-1",
        match_method: null,
        match_confidence: null,
      },
      ranked: [candidate("deterministic")],
      fetchStatus: "ok",
    });

    expect(decision).toMatchObject({
      outcomeState: "auto_live_inventory_alias",
      reasonCode: "existing_live_alias",
      matchMethod: "existing_mapping",
      matchConfidence: "deterministic",
      candidatesWithNoMatch: false,
      candidatesWithDisqualifiers: false,
    });
  });

  it("promotes deterministic and strong candidates only to dry-run identity-match decisions", () => {
    expect(
      selectDryRunDecision({
        existingMapping: null,
        ranked: [candidate("deterministic")],
        fetchStatus: "ok",
      }),
    ).toMatchObject({
      outcomeState: "auto_database_identity_match",
      reasonCode: "exact_sku_match",
      matchConfidence: "deterministic",
    });

    expect(
      selectDryRunDecision({
        existingMapping: null,
        ranked: [candidate("strong", { matchMethod: "title_vendor_format" })],
        fetchStatus: "ok",
      }),
    ).toMatchObject({
      outcomeState: "auto_database_identity_match",
      reasonCode: "strong_candidate_match",
      matchConfidence: "strong",
    });
  });

  it("holds weak/possible candidates and rejects conflicts without mutating any source table", () => {
    expect(
      selectDryRunDecision({
        existingMapping: null,
        ranked: [candidate("possible")],
        fetchStatus: "ok",
      }),
    ).toMatchObject({
      outcomeState: "auto_holdout_for_evidence",
      reasonCode: "insufficient_confidence",
      matchConfidence: "possible",
    });

    expect(
      selectDryRunDecision({
        existingMapping: null,
        ranked: [candidate("conflict", { disqualifiers: ["placeholder_sku"] })],
        fetchStatus: "ok",
      }),
    ).toMatchObject({
      outcomeState: "auto_reject_non_match",
      reasonCode: "candidate_disqualified",
      candidatesWithDisqualifiers: true,
    });
  });

  it("records fetch failures and no-candidate rows as audit decisions", () => {
    expect(
      selectDryRunDecision({
        existingMapping: null,
        ranked: [],
        fetchStatus: "timeout",
      }),
    ).toMatchObject({
      outcomeState: "fetch_incomplete_holdout",
      reasonCode: "fetch_timeout",
      candidatesWithNoMatch: true,
      candidatesWithDisqualifiers: true,
    });

    expect(
      selectDryRunDecision({
        existingMapping: null,
        ranked: [],
        fetchStatus: "ok",
      }),
    ).toMatchObject({
      outcomeState: "auto_reject_non_match",
      reasonCode: "no_remote_candidate",
      candidatesWithNoMatch: true,
    });
  });

  it("serializes a bounded top-candidate payload for decision audit replay", () => {
    const serialized = serializeTopCandidates([
      candidate("deterministic"),
      candidate("strong", { score: 75 }),
    ]);

    expect(serialized).toHaveLength(2);
    expect(serialized[0]).toMatchObject({
      score: 100,
      match_method: "exact_sku",
      confidence_tier: "deterministic",
      remote: {
        remote_product_id: "product-1",
        remote_inventory_item_id: "inventory-1",
        remote_sku: "ABC-123",
      },
    });
  });
});
