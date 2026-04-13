import { describe, expect, it } from "vitest";
import { normalizeOrderNumber } from "@/lib/shared/order-utils";

describe("normalizeOrderNumber", () => {
  it("strips BC- prefix", () => {
    expect(normalizeOrderNumber("BC-12345")).toBe("12345");
  });

  it("strips bandcamp prefix with space", () => {
    expect(normalizeOrderNumber("bandcamp 12345")).toBe("12345");
  });

  it("strips # prefix", () => {
    expect(normalizeOrderNumber("#1042")).toBe("1042");
  });

  it("handles whitespace and noise around BC prefix", () => {
    // Leading whitespace prevents ^ anchor from matching BC prefix
    expect(normalizeOrderNumber("  BC--99  ")).toBe("bc99");
  });

  it("strips BC prefix only when at start of string", () => {
    expect(normalizeOrderNumber("BC--99")).toBe("99");
  });

  it("lowercases and preserves non-BC prefixed content", () => {
    // ABC doesn't match ^(bc|bandcamp), so full string is kept
    expect(normalizeOrderNumber("ABC-123")).toBe("abc123");
  });

  it("strips bc prefix case-insensitively", () => {
    expect(normalizeOrderNumber("Bc-55667788")).toBe("55667788");
  });

  it("strips bandcamp prefix case-insensitively with dash", () => {
    expect(normalizeOrderNumber("BANDCAMP-99887766")).toBe("99887766");
  });

  it("returns null for null", () => {
    expect(normalizeOrderNumber(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeOrderNumber(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeOrderNumber("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeOrderNumber("   ")).toBeNull();
  });

  it("returns null for prefix-only string", () => {
    expect(normalizeOrderNumber("BC-")).toBeNull();
  });

  it("preserves alphanumeric content with mixed separators", () => {
    expect(normalizeOrderNumber("ORD-2024-001")).toBe("ord2024001");
  });

  it("handles numeric-only input", () => {
    expect(normalizeOrderNumber("12345678")).toBe("12345678");
  });

  it("strips all non-alphanumeric characters", () => {
    expect(normalizeOrderNumber("BC 12.345-678")).toBe("12345678");
  });
});
