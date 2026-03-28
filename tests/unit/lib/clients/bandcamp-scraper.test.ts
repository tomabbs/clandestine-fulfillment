import { describe, expect, it } from "vitest";
import {
  bandcampAlbumArtUrl,
  bandcampMerchImageUrl,
  parseBandcampPage,
} from "@/lib/clients/bandcamp-scraper";

// Updated to use parseBandcampPage (new API).
// parseV1/parseV2 are internal implementation details — no longer exported.
// parseTralbumData is kept as a deprecated compat shim for old callers.
//
// Key change confirmed in Step 0 live audit (2026-03-29):
// pkg.image_id is ALWAYS NULL on real Bandcamp pages.
// Primary package image comes from arts[0].image_id.

const FIXTURE_HTML = `<div data-tralbum="&quot;art_id&quot;:1234567890,&quot;is_preorder&quot;:false,&quot;album_is_preorder&quot;:false,&quot;current&quot;:{&quot;type&quot;:&quot;album&quot;,&quot;release_date&quot;:&quot;01 Mar 2026 00:00:00 GMT&quot;,&quot;title&quot;:&quot;Test Album&quot;},&quot;packages&quot;:[{&quot;type_name&quot;:&quot;Compact Disc (CD)&quot;,&quot;type_id&quot;:1,&quot;sku&quot;:&quot;TA-CD-001&quot;,&quot;release_date&quot;:&quot;01 Mar 2026 00:00:00 GMT&quot;,&quot;image_id&quot;:null,&quot;arts&quot;:[{&quot;image_id&quot;:1110001},{&quot;image_id&quot;:1110002}]},{&quot;type_name&quot;:&quot;2 x Vinyl LP&quot;,&quot;type_id&quot;:15,&quot;sku&quot;:&quot;TA-LP-001&quot;,&quot;image_id&quot;:null,&quot;arts&quot;:[{&quot;image_id&quot;:2220001}]}]"></div>`;

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
    expect(result?.releaseDate?.getMonth()).toBe(2); // March = 2 (0-indexed)
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
