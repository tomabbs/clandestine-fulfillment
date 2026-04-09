import { describe, expect, it } from "vitest";
import { buildBandcampAlbumUrl, parseBandcampPage } from "@/lib/clients/bandcamp-scraper";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHtml(currentExtra: Record<string, unknown> = {}, trackinfo: unknown[] = []): string {
  const json = JSON.stringify({
    art_id: 12345678,
    is_preorder: false,
    album_is_preorder: false,
    current: {
      title: "Test Album",
      release_date: "01 Jan 2025 00:00:00 GMT",
      art_id: 12345678,
      ...currentExtra,
    },
    packages: [
      {
        type_name: "Vinyl LP",
        type_id: 15,
        title: "Standard Black LP",
        sku: "LP-TST-001",
        release_date: "01 Jan 2025 00:00:00 GMT",
        new_date: null,
        image_id: null,
        arts: [{ image_id: 87654321 }],
      },
    ],
    trackinfo,
  });
  const encoded = json.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<html><body data-tralbum="${encoded}"></body></html>`;
}

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

describe("parseBandcampPage — about / credits / upc", () => {
  it("extracts about, credits, and upc from data-tralbum.current", () => {
    const html = makeHtml({
      about: "An incredible debut album.",
      credits: "Recorded by Jane Smith at Studio A.",
      upc: "703610875463",
    });
    const result = parseBandcampPage(html);
    expect(result).not.toBeNull();
    expect(result?.about).toBe("An incredible debut album.");
    expect(result?.credits).toBe("Recorded by Jane Smith at Studio A.");
    expect(result?.upc).toBe("703610875463");
  });

  it("returns null for about/credits/upc when absent", () => {
    const result = parseBandcampPage(makeHtml());
    expect(result?.about).toBeNull();
    expect(result?.credits).toBeNull();
    expect(result?.upc).toBeNull();
  });

  it("trims leading/trailing whitespace from about, credits, and upc", () => {
    const html = makeHtml({
      about: "\n\nDescription with leading newlines.\n",
      credits: "\nRecorded by someone.\n\n",
      upc: " 634457226203 ",
    });
    const result = parseBandcampPage(html);
    expect(result?.about).toBe("Description with leading newlines.");
    expect(result?.credits).toBe("Recorded by someone.");
    expect(result?.upc).toBe("634457226203");
  });
});

describe("parseBandcampPage — trackinfo", () => {
  const sampleTracks = [
    { track_num: 1, title: "Opening Track", duration: 225.0 },
    { track_num: 2, title: "Second Movement", duration: 345.621 },
    { track_num: 3, title: "Finale", duration: 72.4 },
  ];

  it("parses trackinfo into sorted ScrapedTrack array", () => {
    const result = parseBandcampPage(makeHtml({}, sampleTracks));
    expect(result?.tracks).toHaveLength(3);
    expect(result?.tracks[0].title).toBe("Opening Track");
    expect(result?.tracks[0].trackNum).toBe(1);
    expect(result?.tracks[1].title).toBe("Second Movement");
    expect(result?.tracks[2].title).toBe("Finale");
  });

  it("formats duration seconds as M:SS", () => {
    const result = parseBandcampPage(makeHtml({}, sampleTracks));
    expect(result?.tracks[0].durationFormatted).toBe("3:45"); // 225s
    expect(result?.tracks[1].durationFormatted).toBe("5:46"); // 345.621s rounds to 346s
    expect(result?.tracks[2].durationFormatted).toBe("1:12"); // 72.4s rounds to 72s
  });

  it("returns empty array when trackinfo absent", () => {
    const result = parseBandcampPage(makeHtml());
    expect(result?.tracks).toEqual([]);
  });

  it("sorts tracks by track_num regardless of input order", () => {
    const shuffled = [sampleTracks[2], sampleTracks[0], sampleTracks[1]];
    const result = parseBandcampPage(makeHtml({}, shuffled));
    expect(result?.tracks.map((t) => t.trackNum)).toEqual([1, 2, 3]);
  });

  it("skips tracks with missing title or duration", () => {
    const mixed = [
      { track_num: 1, title: "Good Track", duration: 200 },
      { track_num: 2, title: null, duration: 180 }, // no title — skipped
      { track_num: 3, title: "Also Good", duration: null }, // no duration — skipped
    ];
    const result = parseBandcampPage(makeHtml({}, mixed));
    expect(result?.tracks).toHaveLength(1);
    expect(result?.tracks[0].title).toBe("Good Track");
  });
});
