import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/actions/sku-matching.ts"), "utf8");

describe("sku-matching Server Action source contract", () => {
  it("selects deterministic Bandcamp mapping fields required by the primary selector", () => {
    const bandcampSelect = source.match(/bandcamp_product_mappings\(([\s\S]*?)\)/)?.[1] ?? "";

    expect(bandcampSelect).toContain("id");
    expect(bandcampSelect).toContain("bandcamp_url");
    expect(bandcampSelect).toContain("created_at");
    expect(bandcampSelect).toContain("updated_at");
  });

  it("does not use returned relation order for Bandcamp mappings", () => {
    expect(source).toContain("pickPrimaryBandcampMapping(canonical.bandcamp_product_mappings)");
    expect(source).not.toMatch(/Array\.isArray\([^)]*bandcamp_product_mappings[\s\S]*?\[0\]/);
  });

  it("keeps stale-review fingerprints behind the owner helper", () => {
    expect(source).toContain("buildCandidateFingerprint({");
    expect(source).not.toContain("createHash(");
  });

  it("uses ordered connection-scoped remote target selection before preview and accept", () => {
    expect(source).toContain("selectConnectionScopedRemoteTarget({");
    expect(source).toContain("remoteInventoryItemId: parsed.remoteInventoryItemId");
    expect(source).toContain("remoteVariantId: parsed.remoteVariantId");
    expect(source).toContain("remoteProductId: parsed.remoteProductId");
    expect(source).toContain("remoteSku: parsed.remoteSku");
    expect(source).toContain("preview.targetError.code");
  });

  it("continues to persist accepts through the RPC boundary", () => {
    expect(source).toContain('supabase.rpc("persist_sku_match"');
    expect(source).toContain("p_candidate_fingerprint: parsed.fingerprint");
    expect(source).not.toContain('.from("client_store_sku_mappings").insert');
    expect(source).not.toContain('.from("client_store_sku_mappings").update');
  });

  it("keeps manual candidate rejection out of the live alias table", () => {
    expect(source).toContain("searchSkuRemoteCatalog");
    expect(source).toContain("rejectSkuMatchCandidate");
    expect(source).toContain('.from("sku_match_candidate_rejections").insert');
    expect(source).toContain("isRemoteRejected(item, rejections");
  });

  it("does not run Shopify readiness during accept persistence validation", () => {
    expect(source).toContain("includeShopifyReadiness: false");
    expect(source).toContain("emitPerfEvent: false");
  });
});
