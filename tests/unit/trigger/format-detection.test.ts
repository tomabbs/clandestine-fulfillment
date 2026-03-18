import { describe, expect, it } from "vitest";
import { detectFormat, detectShipmentFormat } from "@/trigger/lib/format-detection";

describe("detectFormat", () => {
  it("detects LP from SKU prefix", () => {
    const result = detectFormat({ sku: "LP-AV!-064", name: "Some Album" });
    expect(result.formatKey).toBe("LP");
    expect(result.confidence).toBe("high");
    expect(result.matchedBy).toContain("sku_prefix");
  });

  it("detects CD from SKU prefix", () => {
    const result = detectFormat({ sku: "CD-MT-091", name: "Album CD" });
    expect(result.formatKey).toBe("CD");
    expect(result.confidence).toBe("high");
  });

  it("detects Cassette from CS- prefix", () => {
    const result = detectFormat({ sku: "CS-NOV-102", name: "Demo Tape" });
    expect(result.formatKey).toBe("Cassette");
    expect(result.confidence).toBe("high");
  });

  it("detects 7 inch from SKU prefix", () => {
    const result = detectFormat({ sku: "7IN-001", name: "B-Side Single" });
    expect(result.formatKey).toBe('7"');
    expect(result.confidence).toBe("high");
  });

  it("detects LP from title keyword when no SKU match", () => {
    const result = detectFormat({ sku: "MISC-001", name: "Deluxe Vinyl Edition" });
    expect(result.formatKey).toBe("LP");
    expect(result.confidence).toBe("medium");
    expect(result.matchedBy).toContain("title_keyword");
  });

  it("detects Cassette from title keyword", () => {
    const result = detectFormat({ sku: "MISC-002", name: "Limited Cassette Release" });
    expect(result.formatKey).toBe("Cassette");
    expect(result.confidence).toBe("medium");
  });

  it("falls back to weight heuristic for heavy items", () => {
    const result = detectFormat({ sku: "MISC-003", name: "Something", weight: 15 });
    expect(result.formatKey).toBe("LP");
    expect(result.confidence).toBe("low");
    expect(result.matchedBy).toContain("weight");
  });

  it("falls back to weight heuristic for light items", () => {
    const result = detectFormat({ sku: "MISC-004", name: "Something", weight: 4 });
    expect(result.formatKey).toBe("CD");
    expect(result.confidence).toBe("low");
  });

  it("returns unknown for null item", () => {
    const result = detectFormat(null);
    expect(result.formatKey).toBe("unknown");
    expect(result.confidence).toBe("none");
  });

  it("returns unknown when no rules match and no weight", () => {
    const result = detectFormat({ sku: "MISC-005", name: "Sticker Pack" });
    expect(result.formatKey).toBe("unknown");
    expect(result.confidence).toBe("none");
  });

  it("is case insensitive for SKU prefix", () => {
    const result = detectFormat({ sku: "lp-test-001" });
    expect(result.formatKey).toBe("LP");
  });

  it("is case insensitive for title keywords", () => {
    const result = detectFormat({ sku: "X-001", name: "CASSETTE EDITION" });
    expect(result.formatKey).toBe("Cassette");
  });
});

describe("detectShipmentFormat", () => {
  it("returns highest priority format from mixed items", () => {
    const result = detectShipmentFormat([
      { sku: "CD-100", name: "Album CD" },
      { sku: "CD-101", name: "EP CD" },
      { sku: "LP-200", name: "Deluxe Vinyl" },
    ]);
    expect(result.formatKey).toBe("LP");
    expect(result.itemFormats).toHaveLength(3);
    expect(result.itemFormats[0].formatKey).toBe("CD");
    expect(result.itemFormats[2].formatKey).toBe("LP");
  });

  it("returns CD when all items are CDs", () => {
    const result = detectShipmentFormat([
      { sku: "CD-001", name: "Album 1" },
      { sku: "CD-002", name: "Album 2" },
    ]);
    expect(result.formatKey).toBe("CD");
  });

  it("returns unknown for empty items", () => {
    const result = detectShipmentFormat([]);
    expect(result.formatKey).toBe("unknown");
    expect(result.itemFormats).toHaveLength(0);
  });

  it("tracks per-item format breakdown", () => {
    const result = detectShipmentFormat([
      { sku: "LP-001", name: "Vinyl" },
      { sku: "CS-001", name: "Tape" },
      { sku: "CD-001", name: "Disc" },
    ]);
    expect(result.itemFormats[0].formatKey).toBe("LP");
    expect(result.itemFormats[1].formatKey).toBe("Cassette");
    expect(result.itemFormats[2].formatKey).toBe("CD");
  });
});
