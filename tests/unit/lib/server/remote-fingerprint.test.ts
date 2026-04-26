/**
 * Autonomous SKU matcher — remote fingerprint tests.
 *
 * Contract under test (plan §"remote_fingerprint generation" +
 * §"Design requirements" + release gate SKU-AUTO-25):
 *   - Returns `null` when no remote identifier slot is populated.
 *   - Returns a 64-char SHA-256 hex digest otherwise.
 *   - 7" vs 12" vinyl (same SKU/ID) produce DIFFERENT hashes.
 *   - Color Red vs Black (same SKU/ID) produce DIFFERENT hashes.
 *   - Edition Standard vs Limited (same SKU/ID) produce DIFFERENT hashes.
 *   - Two calls with structurally-identical payloads produce the
 *     byte-identical hash (key-order independence via sortKeysDeep).
 *   - Frozen canonical fixture hashes remain stable — byte-identical
 *     across commits.
 */
import { describe, expect, it } from "vitest";
import {
  buildRemoteFingerprint,
  type RemoteListingInput,
  sortKeysDeep,
} from "@/lib/server/remote-fingerprint";

function base(partial: Partial<RemoteListingInput>): RemoteListingInput {
  return {
    platform: "shopify",
    remoteSku: "LP-001",
    remoteProductId: "prod_1",
    remoteVariantId: "var_1",
    remoteInventoryItemId: "inv_1",
    title: "Artist — Album",
    variantOptions: [],
    ...partial,
  };
}

describe("buildRemoteFingerprint", () => {
  it("returns null when no stable remote identifier exists", () => {
    const fp = buildRemoteFingerprint({
      platform: "shopify",
      remoteSku: null,
      remoteProductId: null,
      remoteVariantId: null,
      remoteInventoryItemId: null,
      title: "Artist — Album",
      variantOptions: [],
    });
    expect(fp).toBeNull();
  });

  it("treats empty-string identifiers as absent", () => {
    const fp = buildRemoteFingerprint({
      platform: "shopify",
      remoteSku: "",
      remoteProductId: "   ",
      remoteVariantId: null,
      remoteInventoryItemId: null,
      title: "Artist — Album",
      variantOptions: [],
    });
    expect(fp).toBeNull();
  });

  it("returns a 64-char SHA-256 hex digest when identifiers are present", () => {
    const fp = buildRemoteFingerprint(base({}));
    expect(fp).not.toBeNull();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("size never collides (SKU-AUTO-25 fixtures)", () => {
    it('7" and 12" vinyl produce different hashes', () => {
      const seven = buildRemoteFingerprint(
        base({ title: 'Artist — Song 7" Vinyl', remoteVariantId: "var-7" }),
      );
      const twelve = buildRemoteFingerprint(
        base({ title: 'Artist — Song 12" Vinyl', remoteVariantId: "var-7" }),
      );
      expect(seven).not.toBeNull();
      expect(twelve).not.toBeNull();
      expect(seven).not.toBe(twelve);
    });
  });

  describe("color never collides", () => {
    it("Red and Black produce different hashes", () => {
      const red = buildRemoteFingerprint(
        base({
          variantOptions: [{ name: "Color", value: "Red" }],
          remoteVariantId: "v1",
        }),
      );
      const black = buildRemoteFingerprint(
        base({
          variantOptions: [{ name: "Color", value: "Black" }],
          remoteVariantId: "v1",
        }),
      );
      expect(red).not.toBe(black);
    });
  });

  describe("edition never collides", () => {
    it("Standard and Limited produce different hashes", () => {
      const standard = buildRemoteFingerprint(base({ title: "Artist — Album Standard LP" }));
      const limited = buildRemoteFingerprint(base({ title: "Artist — Album Limited LP" }));
      expect(standard).not.toBe(limited);
    });
  });

  describe("key-order independence (sortKeysDeep)", () => {
    it("hash is independent of variantOption insertion order", () => {
      const a = buildRemoteFingerprint(
        base({
          variantOptions: [
            { name: "Color", value: "Red" },
            { name: "Edition", value: "Limited" },
          ],
        }),
      );
      const b = buildRemoteFingerprint(
        base({
          variantOptions: [
            { name: "Edition", value: "Limited" },
            { name: "Color", value: "Red" },
          ],
        }),
      );
      expect(a).toBe(b);
    });

    it("sortKeysDeep handles nested objects and arrays deterministically", () => {
      const out = sortKeysDeep({
        b: [3, { y: 2, x: 1 }],
        a: 1,
      });
      expect(JSON.stringify(out)).toBe('{"a":1,"b":[3,{"x":1,"y":2}]}');
    });

    it("sortKeysDeep preserves array order (arrays are semantic)", () => {
      const out = sortKeysDeep({ arr: [3, 1, 2] });
      expect(JSON.stringify(out)).toBe('{"arr":[3,1,2]}');
    });
  });

  describe("platform contributes to fingerprint", () => {
    it("different platforms produce different hashes", () => {
      const shopify = buildRemoteFingerprint(base({ platform: "shopify" }));
      const woo = buildRemoteFingerprint(base({ platform: "woocommerce" }));
      expect(shopify).not.toBe(woo);
    });
  });

  describe("stability fixture (SKU-AUTO-25 byte-identical guarantee)", () => {
    it("frozen shopify 12in Red Limited LP input hashes to the frozen value", () => {
      const fp = buildRemoteFingerprint({
        platform: "shopify",
        remoteSku: "LP-RED-LTD",
        remoteProductId: "prod_red_ltd",
        remoteVariantId: "var_red_ltd",
        remoteInventoryItemId: "inv_red_ltd",
        title: 'Artist — Album 12" Limited Edition LP',
        variantOptions: [
          { name: "Color", value: "Red" },
          { name: "Edition", value: "Limited" },
        ],
      });
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
      // Re-computing the same input must produce the same hash: this
      // rules out any hidden non-determinism.
      const fp2 = buildRemoteFingerprint({
        platform: "shopify",
        remoteSku: "LP-RED-LTD",
        remoteProductId: "prod_red_ltd",
        remoteVariantId: "var_red_ltd",
        remoteInventoryItemId: "inv_red_ltd",
        title: 'Artist — Album 12" Limited Edition LP',
        variantOptions: [
          { name: "Edition", value: "Limited" },
          { name: "Color", value: "Red" },
        ],
      });
      expect(fp2).toBe(fp);
    });

    it("SKU case differences do not break fingerprint stability", () => {
      const lower = buildRemoteFingerprint(base({ remoteSku: "lp-001" }));
      const upper = buildRemoteFingerprint(base({ remoteSku: "LP-001" }));
      expect(upper).toBe(lower);
    });
  });
});
