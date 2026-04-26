/**
 * Unit tests for src/lib/shared/utils.ts.
 *
 * Focused on the autonomous SKU-matcher-relevant exports added in
 * Phase 1. `normalizeProductText` is covered by a small round-trip
 * section; `isPlaceholderSku` gets full table coverage because it gates
 * promotion decisions in the ranker.
 */
import { describe, expect, it } from "vitest";
import { isPlaceholderSku, normalizeProductText } from "@/lib/shared/utils";

describe("isPlaceholderSku", () => {
  const truthy: Array<string | null | undefined> = [
    "",
    " ",
    "   ",
    "-",
    "--",
    "0",
    "n/a",
    "N/A",
    "na",
    "NA",
    "none",
    "NONE",
    "null",
    "tbd",
    "TBA",
    "unknown",
    "placeholder",
    "default",
    "test",
    "TEST",
    "sample",
    "1",
    "99",
    "123",
    "SQ12345",
    "sq0001",
    null,
    undefined,
  ];
  for (const v of truthy) {
    it(`treats ${JSON.stringify(v)} as placeholder`, () => {
      expect(isPlaceholderSku(v)).toBe(true);
    });
  }

  const falsy: string[] = [
    "ABC-123",
    "LP-001",
    "CD42",
    "CLD-REC-001",
    "BLACK-LP-0001",
    "1000",
    "9999",
    "test-sku-001",
    "SKU-test",
    "NA-LP-01",
    "SQ",
    "SQABC",
    "SQ-123",
  ];
  for (const v of falsy) {
    it(`treats ${JSON.stringify(v)} as a real SKU`, () => {
      expect(isPlaceholderSku(v)).toBe(false);
    });
  }
});

describe("normalizeProductText (sanity)", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeProductText("Black Sabbath — Vol. 4 (LP)")).toBe("black sabbath vol 4 lp");
  });

  it("expands ampersands to 'and'", () => {
    expect(normalizeProductText("Salt & Pepper")).toBe("salt and pepper");
  });

  it("preserves token order", () => {
    expect(normalizeProductText("Second Track First")).toBe("second track first");
  });

  it("returns an empty string for null/undefined", () => {
    expect(normalizeProductText(null)).toBe("");
    expect(normalizeProductText(undefined)).toBe("");
  });
});
