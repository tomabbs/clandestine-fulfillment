import { describe, expect, it } from "vitest";
import {
  classifyProduct,
  isAlbumLinkedBundle,
  CATEGORY_EXPECTED_FIELDS,
  ALBUM_FORMAT_CATEGORIES,
  NON_ALBUM_CATEGORIES,
} from "@/lib/shared/product-categories";

describe("classifyProduct", () => {
  it("classifies vinyl from typeName", () => {
    expect(classifyProduct("Vinyl LP", null, null)).toBe("vinyl");
    expect(classifyProduct("Record/Vinyl", null, null)).toBe("vinyl");
  });

  it("classifies CD from typeName", () => {
    expect(classifyProduct("Compact Disc", null, null)).toBe("cd");
    expect(classifyProduct(null, null, "Album CD")).toBe("cd");
  });

  it("classifies cassette", () => {
    expect(classifyProduct("Cassette", null, null)).toBe("cassette");
    expect(classifyProduct(null, null, "limited tape release")).toBe("cassette");
  });

  it("classifies apparel from title", () => {
    expect(classifyProduct(null, null, "Band T-Shirt Black")).toBe("apparel");
    expect(classifyProduct(null, null, "Hoodie — XL")).toBe("apparel");
    expect(classifyProduct(null, null, "Longsleeve Tour Shirt")).toBe("apparel");
  });

  it("classifies merch from title", () => {
    expect(classifyProduct(null, null, "Tote Bag")).toBe("merch");
    expect(classifyProduct(null, null, "Sticker Pack")).toBe("merch");
    expect(classifyProduct(null, null, "Enamel Pin")).toBe("merch");
  });

  it("classifies bundles", () => {
    expect(classifyProduct(null, null, "LP + CD Bundle")).toBe("bundle");
    expect(classifyProduct(null, null, "2-Pack Combo")).toBe("bundle");
  });

  it("falls back to URL path for merch pages", () => {
    expect(classifyProduct(null, "https://band.bandcamp.com/merch/cool-thing", null)).toBe("merch");
  });

  it("defaults to other for unrecognizable items", () => {
    expect(classifyProduct(null, null, null)).toBe("other");
    expect(classifyProduct(null, "https://band.bandcamp.com/album/something", null)).toBe("other");
  });

  it("handles NFKC normalization", () => {
    expect(classifyProduct("Ｖｉｎｙｌ", null, null)).toBe("vinyl");
  });

  it("bundle pattern takes precedence over format keywords", () => {
    expect(classifyProduct(null, null, "Vinyl LP + CD Bundle")).toBe("bundle");
  });

  it("apparel keyword in merch URL still returns apparel", () => {
    expect(classifyProduct(null, "https://band.bandcamp.com/merch/t-shirt", "T-Shirt")).toBe("apparel");
  });
});

describe("isAlbumLinkedBundle", () => {
  it("returns true for bundles at /album/ paths", () => {
    expect(isAlbumLinkedBundle("https://band.bandcamp.com/album/cool-album", "bundle")).toBe(true);
  });

  it("returns false for bundles at /merch/ paths", () => {
    expect(isAlbumLinkedBundle("https://band.bandcamp.com/merch/bundle-thing", "bundle")).toBe(false);
  });

  it("returns false for non-bundle categories", () => {
    expect(isAlbumLinkedBundle("https://band.bandcamp.com/album/cool-album", "vinyl")).toBe(false);
    expect(isAlbumLinkedBundle("https://band.bandcamp.com/album/cool-album", "apparel")).toBe(false);
  });

  it("returns false for null URL", () => {
    expect(isAlbumLinkedBundle(null, "bundle")).toBe(false);
  });

  it("returns false for malformed URL", () => {
    expect(isAlbumLinkedBundle("not-a-url", "bundle")).toBe(false);
  });
});

describe("CATEGORY_EXPECTED_FIELDS", () => {
  it("album formats expect all fields", () => {
    for (const cat of ALBUM_FORMAT_CATEGORIES) {
      const exp = CATEGORY_EXPECTED_FIELDS[cat];
      expect(exp.about).toBe(true);
      expect(exp.credits).toBe(true);
      expect(exp.tracks).toBe(true);
      expect(exp.art).toBe(true);
      expect(exp.tags).toBe(true);
    }
  });

  it("apparel/merch expect only art", () => {
    for (const cat of ["apparel", "merch"] as const) {
      const exp = CATEGORY_EXPECTED_FIELDS[cat];
      expect(exp.about).toBe(false);
      expect(exp.credits).toBe(false);
      expect(exp.tracks).toBe(false);
      expect(exp.art).toBe(true);
      expect(exp.tags).toBe(false);
    }
  });

  it("bundles expect about + art + tags but not credits/tracks", () => {
    const exp = CATEGORY_EXPECTED_FIELDS.bundle;
    expect(exp.about).toBe(true);
    expect(exp.credits).toBe(false);
    expect(exp.tracks).toBe(false);
    expect(exp.art).toBe(true);
    expect(exp.tags).toBe(true);
  });
});

describe("category arrays", () => {
  it("ALBUM_FORMAT_CATEGORIES contains vinyl, cd, cassette", () => {
    expect(ALBUM_FORMAT_CATEGORIES).toEqual(["vinyl", "cd", "cassette"]);
  });

  it("NON_ALBUM_CATEGORIES contains apparel, merch, bundle, other", () => {
    expect(NON_ALBUM_CATEGORIES).toEqual(["apparel", "merch", "bundle", "other"]);
  });
});
