/**
 * Autonomous SKU matcher — music-variant descriptor parser tests.
 *
 * Contract under test (plan: §"Music-specific descriptor parsing"):
 *   - Format detection covers: lp, 7inch, 10inch, 12inch, cassette, cd,
 *     digital, shirt, hoodie, other, unknown.
 *   - Size is preserved numerically: 7" / 7in / 7 inch ↔ "7in"; and
 *     12" / 12in ↔ "12in". "7" and "12" never collapse to the same bucket.
 *   - Structured variant options outrank title regex.
 *   - Pure function: same input ⇒ same output for all tested cases.
 *   - Apparel (T-shirt / hoodie) uses variant-option size (S/M/L/...),
 *     not vinyl size.
 */
import { describe, expect, it } from "vitest";
import {
  type MusicVariantDescriptors,
  parseMusicVariantDescriptors,
} from "@/lib/server/music-variant-descriptors";

function descriptor(partial: Partial<MusicVariantDescriptors>): MusicVariantDescriptors {
  return {
    format: "unknown",
    size: null,
    color: null,
    pressing: null,
    edition: null,
    catalogId: null,
    signed: false,
    bundle: false,
    preorder: false,
    variantOptions: [],
    ...partial,
  };
}

describe("parseMusicVariantDescriptors", () => {
  describe("format detection from title", () => {
    it('parses 7" vinyl with straight quote', () => {
      const result = parseMusicVariantDescriptors({ title: 'Artist — Song 7"' });
      expect(result.format).toBe("7inch");
      expect(result.size).toBe("7in");
    });

    it('parses 7" vinyl with curly quote', () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Song 7”" });
      expect(result.format).toBe("7inch");
      expect(result.size).toBe("7in");
    });

    it("parses 7 inch vinyl", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Song 7 inch" });
      expect(result.format).toBe("7inch");
      expect(result.size).toBe("7in");
    });

    it('parses 12" vinyl separately from 7"', () => {
      const result = parseMusicVariantDescriptors({ title: 'Artist — Album 12"' });
      expect(result.format).toBe("12inch");
      expect(result.size).toBe("12in");
    });

    it("parses 10 inch vinyl", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — EP 10 inch" });
      expect(result.format).toBe("10inch");
      expect(result.size).toBe("10in");
    });

    it("parses LP without explicit size", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album LP" });
      expect(result.format).toBe("lp");
      expect(result.size).toBeNull();
    });

    it("parses vinyl as LP fallback", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album Vinyl" });
      expect(result.format).toBe("lp");
    });

    it("parses cassette", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album Cassette" });
      expect(result.format).toBe("cassette");
    });

    it("parses CS as cassette", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album CS" });
      expect(result.format).toBe("cassette");
    });

    it("parses CD", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album CD" });
      expect(result.format).toBe("cd");
    });

    it("parses digital download", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album Digital Download" });
      expect(result.format).toBe("digital");
    });

    it("parses T-shirt as shirt", () => {
      const result = parseMusicVariantDescriptors({ title: "Band T-Shirt" });
      expect(result.format).toBe("shirt");
    });

    it("parses hoodie", () => {
      const result = parseMusicVariantDescriptors({ title: "Band Hoodie" });
      expect(result.format).toBe("hoodie");
    });

    it("falls through to unknown for unrecognized formats", () => {
      const result = parseMusicVariantDescriptors({ title: "Band Flag Sticker Pack" });
      expect(result.format).toBe("unknown");
    });
  });

  describe("size never collapses", () => {
    it('7" and 12" produce different size values', () => {
      const seven = parseMusicVariantDescriptors({ title: 'Artist — Song 7"' });
      const twelve = parseMusicVariantDescriptors({ title: 'Artist — Song 12"' });
      expect(seven.size).toBe("7in");
      expect(twelve.size).toBe("12in");
      expect(seven.size).not.toBe(twelve.size);
    });
  });

  describe("color detection", () => {
    it("extracts plain color from title", () => {
      const result = parseMusicVariantDescriptors({ title: "Artist — Album Red Vinyl" });
      expect(result.color).toBe("red");
    });

    it("preserves slash-joined color pairs as distinct canonical values", () => {
      const result = parseMusicVariantDescriptors({
        title: "Artist — Album Red/Black Splatter Vinyl",
      });
      expect(result.color).toContain("red");
    });

    it("prefers variant-option color over title color", () => {
      const result = parseMusicVariantDescriptors({
        title: "Artist — Album Red Vinyl",
        variantOptions: [{ name: "Color", value: "Blue" }],
      });
      expect(result.color).toBe("blue");
    });
  });

  describe("variant-option priority over title", () => {
    it("variant-option format outranks title format", () => {
      const result = parseMusicVariantDescriptors({
        title: "Artist — Album",
        variantOptions: [{ name: "Format", value: "Cassette" }],
      });
      expect(result.format).toBe("cassette");
    });

    it("apparel size comes from Size variant option", () => {
      const result = parseMusicVariantDescriptors({
        title: "Band T-Shirt",
        variantOptions: [{ name: "Size", value: "XL" }],
      });
      expect(result.format).toBe("shirt");
      expect(result.size).toBe("XL");
    });
  });

  describe("edition detection", () => {
    it("matches Limited edition from title", () => {
      const result = parseMusicVariantDescriptors({
        title: "Artist — Album Limited Edition LP",
      });
      expect(result.edition).toBe("limited");
    });

    it("matches Standard edition from title", () => {
      const result = parseMusicVariantDescriptors({
        title: "Artist — Album Standard LP",
      });
      expect(result.edition).toBe("standard");
    });

    it("prefers variant-option edition over title edition", () => {
      const result = parseMusicVariantDescriptors({
        title: "Artist — Album Standard LP",
        variantOptions: [{ name: "Edition", value: "Deluxe" }],
      });
      expect(result.edition).toBe("deluxe");
    });
  });

  describe("flags", () => {
    it("detects signed from title", () => {
      const r = parseMusicVariantDescriptors({ title: "Signed Limited LP" });
      expect(r.signed).toBe(true);
      expect(r.edition).toBe("limited");
    });

    it("detects bundle from title", () => {
      const r = parseMusicVariantDescriptors({ title: "Album + T-Shirt Bundle" });
      expect(r.bundle).toBe(true);
    });

    it("detects preorder from title", () => {
      const r = parseMusicVariantDescriptors({ title: "Album (Pre-order) LP" });
      expect(r.preorder).toBe(true);
    });
  });

  describe("determinism (purity contract for SKU-AUTO-25)", () => {
    it("returns structurally identical output for repeated calls", () => {
      const input = {
        title: 'Artist — Album 12" Limited Red Vinyl',
        variantOptions: [
          { name: "Color", value: "Red" },
          { name: "Edition", value: "Limited" },
        ],
      };
      const a = parseMusicVariantDescriptors(input);
      const b = parseMusicVariantDescriptors(input);
      expect(a).toStrictEqual(b);
    });

    it("sorts variantOptions by name then value", () => {
      const r = parseMusicVariantDescriptors({
        title: "Album",
        variantOptions: [
          { name: "Edition", value: "Limited" },
          { name: "Color", value: "Red" },
        ],
      });
      expect(r.variantOptions).toEqual([
        { name: "Color", value: "Red" },
        { name: "Edition", value: "Limited" },
      ]);
    });

    it("returns descriptors matching the empty baseline when input is empty", () => {
      const r = parseMusicVariantDescriptors({});
      expect(r).toStrictEqual(descriptor({ format: "unknown" }));
    });
  });
});
