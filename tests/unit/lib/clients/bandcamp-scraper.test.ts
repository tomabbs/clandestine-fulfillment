import { describe, expect, it } from "vitest";
import {
  bandcampAlbumArtUrl,
  bandcampMerchImageUrl,
  parseBandcampPage,
} from "@/lib/clients/bandcamp-scraper";

// ─── Fixture builder for about/credits/upc/trackinfo tests ───────────────────

function makeHtml(currentExtra: Record<string, unknown> = {}, trackinfo: unknown[] = []): string {
  const json = JSON.stringify({
    art_id: 1234567890,
    is_preorder: false,
    album_is_preorder: false,
    current: {
      title: "Test Album",
      release_date: "01 Mar 2026 00:00:00 GMT",
      art_id: 1234567890,
      ...currentExtra,
    },
    packages: [
      {
        type_name: "Vinyl LP",
        type_id: 15,
        sku: "LP-TST-001",
        release_date: "01 Mar 2026 00:00:00 GMT",
        image_id: null,
        arts: [{ image_id: 87654321 }],
      },
    ],
    trackinfo,
  });
  const encoded = json.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<html><body data-tralbum="${encoded}"></body></html>`;
}

// Updated to use parseBandcampPage (new API).
// parseV1/parseV2 are internal implementation details — no longer exported.
// parseTralbumData is kept as a deprecated compat shim for old callers.
//
// Key change confirmed in Step 0 live audit (2026-03-29):
// pkg.image_id is ALWAYS NULL on real Bandcamp pages.
// Primary package image comes from arts[0].image_id.

const _FIXTURE_HTML = `<div data-tralbum="&quot;art_id&quot;:1234567890,&quot;is_preorder&quot;:false,&quot;album_is_preorder&quot;:false,&quot;current&quot;:{&quot;type&quot;:&quot;album&quot;,&quot;release_date&quot;:&quot;01 Mar 2026 00:00:00 GMT&quot;,&quot;title&quot;:&quot;Test Album&quot;},&quot;packages&quot;:[{&quot;type_name&quot;:&quot;Compact Disc (CD)&quot;,&quot;type_id&quot;:1,&quot;sku&quot;:&quot;TA-CD-001&quot;,&quot;release_date&quot;:&quot;01 Mar 2026 00:00:00 GMT&quot;,&quot;image_id&quot;:null,&quot;arts&quot;:[{&quot;image_id&quot;:1110001},{&quot;image_id&quot;:1110002}]},{&quot;type_name&quot;:&quot;2 x Vinyl LP&quot;,&quot;type_id&quot;:15,&quot;sku&quot;:&quot;TA-LP-001&quot;,&quot;image_id&quot;:null,&quot;arts&quot;:[{&quot;image_id&quot;:2220001}]}]"></div>`;

// Properly formed data-tralbum with braces
const FIXTURE_HTML_FULL = `<div data-tralbum="{&quot;art_id&quot;:1234567890,&quot;is_preorder&quot;:false,&quot;album_is_preorder&quot;:false,&quot;current&quot;:{&quot;type&quot;:&quot;album&quot;,&quot;release_date&quot;:&quot;01 Mar 2026 00:00:00 GMT&quot;,&quot;title&quot;:&quot;Test Album&quot;},&quot;packages&quot;:[{&quot;type_name&quot;:&quot;Compact Disc (CD)&quot;,&quot;type_id&quot;:1,&quot;sku&quot;:&quot;TA-CD-001&quot;,&quot;release_date&quot;:&quot;01 Mar 2026 00:00:00 GMT&quot;,&quot;image_id&quot;:null,&quot;arts&quot;:[{&quot;image_id&quot;:1110001},{&quot;image_id&quot;:1110002}]},{&quot;type_name&quot;:&quot;2 x Vinyl LP&quot;,&quot;type_id&quot;:15,&quot;sku&quot;:&quot;TA-LP-001&quot;,&quot;image_id&quot;:null,&quot;arts&quot;:[{&quot;image_id&quot;:2220001}]}]}"></div>`;

describe("bandcamp-scraper (parseBandcampPage)", () => {
  it("returns null when no data-tralbum attribute exists", () => {
    expect(parseBandcampPage("<html><body>Nothing</body></html>")).toBeNull();
  });

  it("parses top-level fields", () => {
    const result = parseBandcampPage(FIXTURE_HTML_FULL);
    expect(result).not.toBeNull();
    expect(result?.artId).toBe(1234567890);
    expect(result?.isPreorder).toBe(false);
    expect(result?.title).toBe("Test Album");
    expect(result?.albumArtUrl).toBe("https://f4.bcbits.com/img/a1234567890_10.jpg");
  });

  it("parses releaseDate as Date object", () => {
    const result = parseBandcampPage(FIXTURE_HTML_FULL);
    expect(result?.releaseDate).toBeInstanceOf(Date);
    expect(result?.releaseDate?.getFullYear()).toBe(2026);
    expect(result?.releaseDate?.getUTCMonth()).toBe(2); // March = 2 (0-indexed, UTC)
  });

  it("parses packages with type_id and SKU", () => {
    const result = parseBandcampPage(FIXTURE_HTML_FULL);
    expect(result?.packages).toHaveLength(2);

    const cd = result?.packages[0];
    expect(cd?.typeName).toBe("Compact Disc (CD)");
    expect(cd?.typeId).toBe(1);
    expect(cd?.sku).toBe("TA-CD-001");
  });

  it("primary package image comes from arts[0].imageId (not image_id)", () => {
    // Step 0 confirmed: pkg.image_id is ALWAYS NULL on real Bandcamp pages.
    // Primary image = arts[0].image_id.
    const result = parseBandcampPage(FIXTURE_HTML_FULL);
    const cd = result?.packages[0];

    // arts array populated
    expect(cd?.arts).toHaveLength(2);
    expect(cd?.arts[0].imageId).toBe(1110001);
    expect(cd?.arts[0].url).toBe("https://f4.bcbits.com/img/1110001_10.jpg");

    // imageId/imageUrl derived from arts[0] (since pkg.image_id is null)
    expect(cd?.imageId).toBe(1110001);
    expect(cd?.imageUrl).toBe("https://f4.bcbits.com/img/1110001_10.jpg");
  });

  it("LP package has correct type_id and arts", () => {
    const result = parseBandcampPage(FIXTURE_HTML_FULL);
    const lp = result?.packages[1];
    expect(lp?.typeName).toBe("2 x Vinyl LP");
    expect(lp?.typeId).toBe(15);
    expect(lp?.sku).toBe("TA-LP-001");
    expect(lp?.imageId).toBe(2220001);
  });

  it("marks metadataIncomplete when no releaseDate", () => {
    const html = `<div data-tralbum="{&quot;art_id&quot;:123}"></div>`;
    const result = parseBandcampPage(html);
    expect(result?.metadataIncomplete).toBe(true);
    expect(result?.releaseDate).toBeNull();
  });
});

describe("parseBandcampPage — about / credits / upc", () => {
  it("extracts about, credits, and upc from data-tralbum.current", () => {
    const result = parseBandcampPage(
      makeHtml({
        about: "An incredible debut album.",
        credits: "Recorded by Jane Smith at Studio A.",
        upc: "703610875463",
      }),
    );
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

  it("trims leading/trailing whitespace", () => {
    const result = parseBandcampPage(
      makeHtml({
        about: "\n\nDescription with leading newlines.\n",
        credits: "\nRecorded by someone.\n\n",
        upc: " 634457226203 ",
      }),
    );
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
    expect(result?.tracks[2].title).toBe("Finale");
  });

  it("formats duration seconds as M:SS", () => {
    const result = parseBandcampPage(makeHtml({}, sampleTracks));
    expect(result?.tracks[0].durationFormatted).toBe("3:45"); // 225s
    expect(result?.tracks[1].durationFormatted).toBe("5:46"); // 345.621s → 346s
    expect(result?.tracks[2].durationFormatted).toBe("1:12"); // 72.4s → 72s
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
      { track_num: 2, title: null, duration: 180 },
      { track_num: 3, title: "Also Good", duration: null },
    ];
    const result = parseBandcampPage(makeHtml({}, mixed));
    expect(result?.tracks).toHaveLength(1);
    expect(result?.tracks[0].title).toBe("Good Track");
  });
});

describe("image URL helpers", () => {
  it("bandcampAlbumArtUrl constructs URL with 'a' prefix", () => {
    expect(bandcampAlbumArtUrl(1234567890)).toBe("https://f4.bcbits.com/img/a1234567890_10.jpg");
  });

  it("bandcampAlbumArtUrl supports custom size", () => {
    expect(bandcampAlbumArtUrl(1234567890, 5)).toBe("https://f4.bcbits.com/img/a1234567890_5.jpg");
  });

  it("bandcampAlbumArtUrl returns null for null/undefined", () => {
    expect(bandcampAlbumArtUrl(null)).toBeNull();
    expect(bandcampAlbumArtUrl(undefined)).toBeNull();
  });

  it("bandcampMerchImageUrl constructs URL without 'a' prefix", () => {
    expect(bandcampMerchImageUrl(9876543210)).toBe("https://f4.bcbits.com/img/9876543210_10.jpg");
  });

  it("bandcampMerchImageUrl returns null for null/undefined", () => {
    expect(bandcampMerchImageUrl(null)).toBeNull();
    expect(bandcampMerchImageUrl(undefined)).toBeNull();
  });
});
