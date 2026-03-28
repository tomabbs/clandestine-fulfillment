import { describe, expect, it } from "vitest";
import { buildBandcampAlbumUrl } from "@/lib/clients/bandcamp-scraper";

// Tests import from the real implementation — not a local copy.
// Step 0 validated: "Birds & Beasts" → "birds-beasts" → live Bandcamp page ✓

describe("buildBandcampAlbumUrl", () => {
  it("basic ASCII title", () => {
    expect(buildBandcampAlbumUrl("nsr", "Normal Album")).toBe(
      "https://nsr.bandcamp.com/album/normal-album",
    );
  });

  it("real example: Birds & Beasts (confirmed working in Step 0)", () => {
    expect(buildBandcampAlbumUrl("suss", "Birds & Beasts")).toBe(
      "https://suss.bandcamp.com/album/birds-beasts",
    );
  });

  it("accented characters (café → cafe)", () => {
    expect(buildBandcampAlbumUrl("nsr", "Café Sessions")).toBe(
      "https://nsr.bandcamp.com/album/cafe-sessions",
    );
  });

  it("punctuation and parentheses", () => {
    expect(buildBandcampAlbumUrl("nsr", "Vol. 1 (Remaster)")).toBe(
      "https://nsr.bandcamp.com/album/vol-1-remaster",
    );
  });

  it("leading number", () => {
    expect(buildBandcampAlbumUrl("nsr", "2020 Demos")).toBe(
      "https://nsr.bandcamp.com/album/2020-demos",
    );
  });

  it("mixed case collapses", () => {
    expect(buildBandcampAlbumUrl("nsr", "The NECKS Live")).toBe(
      "https://nsr.bandcamp.com/album/the-necks-live",
    );
  });

  it("empty string returns null", () => {
    expect(buildBandcampAlbumUrl("nsr", "")).toBeNull();
  });

  it("whitespace-only returns null", () => {
    expect(buildBandcampAlbumUrl("nsr", "   ")).toBeNull();
  });

  it("all-punctuation returns null", () => {
    expect(buildBandcampAlbumUrl("nsr", "---")).toBeNull();
  });

  it("multiple spaces collapse to single hyphen", () => {
    expect(buildBandcampAlbumUrl("nsr", "Album  Title  Here")).toBe(
      "https://nsr.bandcamp.com/album/album-title-here",
    );
  });

  it("ampersand stripped", () => {
    expect(buildBandcampAlbumUrl("suss", "Salt & Time")).toBe(
      "https://suss.bandcamp.com/album/salt-time",
    );
  });
});
