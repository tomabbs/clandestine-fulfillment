/**
 * Order Pages Transition Phase 0 — `normalizeStoreKey` contract tests.
 *
 * Drift between the webhook handler's normalizer and the poller's
 * normalizer is the silent failure mode for the platform_order_ingest
 * ownership lookup. These tests freeze the canonical shape so any future
 * tweak shows up as a failing test rather than a webhook race.
 */
import { describe, expect, it } from "vitest";
import { normalizeStoreKey } from "@/lib/shared/store-key";

describe("normalizeStoreKey — shopify", () => {
  const cases: Array<[string, string]> = [
    ["foo-store.myshopify.com", "foo-store.myshopify.com"],
    ["FOO-STORE.MYSHOPIFY.COM", "foo-store.myshopify.com"],
    ["https://foo-store.myshopify.com", "foo-store.myshopify.com"],
    ["https://foo-store.myshopify.com/", "foo-store.myshopify.com"],
    ["https://www.foo-store.myshopify.com/admin", "foo-store.myshopify.com"],
    ["http://foo-store.myshopify.com?foo=bar", "foo-store.myshopify.com"],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes "${input}" → "${expected}"`, () => {
      expect(normalizeStoreKey("shopify", input)).toBe(expected);
    });
  }

  it("rejects non-myshopify domains", () => {
    expect(() => normalizeStoreKey("shopify", "foo-store.com")).toThrow(/myshopify/);
  });

  it("rejects empty input", () => {
    expect(() => normalizeStoreKey("shopify", "  ")).toThrow(/empty/);
  });
});

describe("normalizeStoreKey — woocommerce / squarespace", () => {
  for (const platform of ["woocommerce", "squarespace"] as const) {
    it(`${platform}: normalizes URL with protocol/path/trailing slash`, () => {
      expect(normalizeStoreKey(platform, "HTTPS://Shop.Example.COM/wp-json/?foo=1")).toBe(
        "shop.example.com",
      );
    });
    it(`${platform}: strips www`, () => {
      expect(normalizeStoreKey(platform, "https://www.shop.example.com")).toBe("shop.example.com");
    });
  }
});

describe("normalizeStoreKey — bandcamp", () => {
  const cases: Array<[string, string]> = [
    ["northern-spy", "northern-spy"],
    ["NORTHERN-SPY", "northern-spy"],
    ["https://northern-spy.bandcamp.com", "northern-spy"],
    ["https://www.northern-spy.bandcamp.com/", "northern-spy"],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes "${input}" → "${expected}"`, () => {
      expect(normalizeStoreKey("bandcamp", input)).toBe(expected);
    });
  }

  it("rejects invalid characters in bare slug", () => {
    expect(() => normalizeStoreKey("bandcamp", "northern_spy!")).toThrow(/invalid/);
  });
});

describe("normalizeStoreKey — manual", () => {
  it("lowercases and trims", () => {
    expect(normalizeStoreKey("manual", "  Hand-Mailorder  ")).toBe("hand-mailorder");
  });
});
