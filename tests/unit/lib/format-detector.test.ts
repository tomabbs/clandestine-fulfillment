import { describe, expect, it } from "vitest";
import { detectFormat } from "@/lib/clients/format-detector";
import type { WarehouseFormatRule } from "@/lib/shared/types";

function makeRule(pattern: string, name: string, priority: number): WarehouseFormatRule {
  return {
    id: crypto.randomUUID(),
    workspace_id: "ws-1",
    format_pattern: pattern,
    format_name: name,
    priority,
    created_at: new Date().toISOString(),
  };
}

const RULES: WarehouseFormatRule[] = [
  makeRule('\\bLP\\b|vinyl|12"', "LP", 10),
  makeRule("\\bCD\\b|compact disc", "CD", 8),
  makeRule('7"|seven inch', '7"', 7),
  makeRule("\\bcassette\\b|tape", "Cassette", 6),
  makeRule("\\bt-shirt\\b|tee|hoodie|poster|tote", "Merch", 3),
];

describe("detectFormat", () => {
  it("matches LP from title", () => {
    expect(detectFormat("Limited LP Edition", null, [], RULES)).toBe("LP");
  });

  it("matches CD from title", () => {
    expect(detectFormat("CD Digipak", null, [], RULES)).toBe("CD");
  });

  it('matches 7" from title', () => {
    expect(detectFormat('7" Single', null, [], RULES)).toBe('7"');
  });

  it("matches Cassette from title", () => {
    expect(detectFormat("Cassette Edition", null, [], RULES)).toBe("Cassette");
  });

  it("matches Merch from title", () => {
    expect(detectFormat("Tour T-Shirt XL", null, [], RULES)).toBe("Merch");
  });

  it("matches from SKU when title has no match", () => {
    expect(detectFormat("Some Album", "LP-001", [], RULES)).toBe("LP");
  });

  it("matches from tags", () => {
    expect(detectFormat("Some Album", "SKU-999", ["cassette", "limited"], RULES)).toBe("Cassette");
  });

  it("returns Unknown when nothing matches", () => {
    expect(detectFormat("Digital Download", "DIG-001", [], RULES)).toBe("Unknown");
  });

  it("returns Unknown for null inputs with no matches", () => {
    expect(detectFormat(null, null, [], RULES)).toBe("Unknown");
  });

  it("returns Unknown when no rules provided", () => {
    expect(detectFormat("LP Vinyl", null, [], [])).toBe("Unknown");
  });

  it("respects priority ordering — higher priority wins", () => {
    // A title that could match both LP (priority 10) and Merch (priority 3)
    const rules = [makeRule("special", "Merch", 3), makeRule("special", "LP", 10)];
    expect(detectFormat("Special Edition", null, [], rules)).toBe("LP");
  });

  it("handles invalid regex gracefully with fallback to includes", () => {
    const rules = [makeRule("[invalid(regex", "Broken", 10)];
    // The pattern "[invalid(regex" is invalid regex; includes check uses full pattern string
    // so it won't match partial substrings — returns Unknown
    expect(detectFormat("This has [invalid(regex in it", null, [], rules)).toBe("Broken");
  });

  it("is case-insensitive", () => {
    expect(detectFormat("lp vinyl record", null, [], RULES)).toBe("LP");
  });
});
