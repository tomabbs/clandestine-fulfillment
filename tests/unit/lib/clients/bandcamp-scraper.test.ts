import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTralbumData, parseV1, parseV2 } from "@/lib/clients/bandcamp-scraper";

// Load fixture once (Rule #18: snapshot tests against saved HTML)
const fixtureHtml = readFileSync(
  resolve(__dirname, "../../../fixtures/bandcamp-album-page.html"),
  "utf-8",
);

describe("bandcamp-scraper", () => {
  describe("parseV1 (data-tralbum attribute)", () => {
    it("extracts TralbumData from data-tralbum attribute", () => {
      const result = parseV1(fixtureHtml);

      expect(result).not.toBeNull();
      expect(result?.item_type).toBe("album");
      expect(result?.release_date).toBe("01 Mar 2026 00:00:00 GMT");
    });

    it("extracts current object", () => {
      const result = parseV1(fixtureHtml);

      expect(result?.current?.type).toBe("album");
      expect(result?.current?.title).toBe("Test Album");
      expect(result?.current?.release_date).toBe("01 Mar 2026 00:00:00 GMT");
    });

    it("extracts packages with type_name and SKU", () => {
      const result = parseV1(fixtureHtml);

      expect(result?.packages).toHaveLength(3);
      expect(result?.packages?.[0]).toMatchObject({
        type_name: "Compact Disc (CD)",
        title: "Test Album CD",
        sku: "TA-CD-001",
      });
      expect(result?.packages?.[1]).toMatchObject({
        type_name: "Vinyl Record",
        title: "Test Album LP",
        sku: "TA-LP-001",
      });
      expect(result?.packages?.[2]).toMatchObject({
        type_name: "Cassette",
        title: "Test Album Cassette",
        sku: "TA-CASS-001",
      });
    });

    it("returns null for HTML without data-tralbum", () => {
      const result = parseV1("<html><body>No data here</body></html>");
      expect(result).toBeNull();
    });
  });

  describe("parseV2 (inline script var)", () => {
    const v2Html = `
<html>
<head><title>V2 Test</title></head>
<body>
<script>
var TralbumData = {"item_type":"track","release_date":"15 Jun 2026 00:00:00 GMT","current":{"type":"track","release_date":"15 Jun 2026 00:00:00 GMT","title":"Single Track"},"packages":[]};
var defined = true;
</script>
</body>
</html>`;

    it("extracts TralbumData from inline script var", () => {
      const result = parseV2(v2Html);

      expect(result).not.toBeNull();
      expect(result?.item_type).toBe("track");
      expect(result?.current?.title).toBe("Single Track");
    });

    it("returns null when no TralbumData var exists", () => {
      const result = parseV2("<html><script>var other = {};</script></html>");
      expect(result).toBeNull();
    });
  });

  describe("parseTralbumData (combined)", () => {
    it("parses V1 fixture and returns structured data", () => {
      const result = parseTralbumData(fixtureHtml);

      expect(result.parserVersion).toBe("v1");
      expect(result.metadataIncomplete).toBe(false);
      expect(result.typeName).toBe("album");
      expect(result.title).toBe("Test Album");
      expect(result.releaseDate).toBe("01 Mar 2026 00:00:00 GMT");
    });

    it("returns packages with correct data", () => {
      const result = parseTralbumData(fixtureHtml);

      expect(result.packages).toHaveLength(3);
      expect(result.packages[0]).toEqual({
        typeName: "Compact Disc (CD)",
        title: "Test Album CD",
        newDate: "01 Mar 2026 00:00:00 GMT",
        url: "https://testartist.bandcamp.com/album/test-album",
        sku: "TA-CD-001",
      });
    });

    it("defaults to Merch on parse failure (Rule #24)", () => {
      const result = parseTralbumData("<html><body>Nothing here</body></html>");

      expect(result.typeName).toBe("Merch");
      expect(result.releaseDate).toBeNull();
      expect(result.metadataIncomplete).toBe(true);
      expect(result.raw).toBeNull();
    });

    it("marks metadata incomplete when type is missing", () => {
      const htmlNoType = `<div data-tralbum="{&quot;release_date&quot;:&quot;01 Jan 2026 00:00:00 GMT&quot;,&quot;current&quot;:{&quot;release_date&quot;:&quot;01 Jan 2026 00:00:00 GMT&quot;,&quot;title&quot;:&quot;No Type&quot;}}"></div>`;
      const result = parseTralbumData(htmlNoType);

      expect(result.metadataIncomplete).toBe(true);
      expect(result.typeName).toBe("Merch");
    });

    it("snapshot: full fixture parse output", () => {
      const result = parseTralbumData(fixtureHtml);

      expect(result).toMatchSnapshot();
    });
  });
});
