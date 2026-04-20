// Phase 11.1 — sanitizeBuyerText safety tests.
//
// Locks in:
//   - HTML tags appear as literal text (React handles this automatically;
//     here we just verify the helper doesn't mutate them).
//   - Bidi-override chars (RLO U+202E etc.) are stripped — those can
//     reverse the visual order of subsequent characters and make a slip
//     unreadable / spoof an artist name.
//   - Zero-width chars (U+200B/C/D, U+FEFF) are stripped — invisible in
//     print but inflate length and break SKU/barcode scanners if they ever
//     made it into a SKU field downstream.
//   - Length cap kicks in cleanly.
//   - CRLF newlines normalized to LF.
//   - Emoji + multi-byte unicode preserved.

import { describe, expect, it } from "vitest";
import {
  MAX_BUYER_TEXT_LEN,
  sanitizeBuyerText,
} from "@/lib/shared/sanitize-buyer-text";

describe("sanitizeBuyerText (Phase 11.1)", () => {
  it("returns '' for null / undefined / empty", () => {
    expect(sanitizeBuyerText(null)).toBe("");
    expect(sanitizeBuyerText(undefined)).toBe("");
    expect(sanitizeBuyerText("")).toBe("");
  });

  it("preserves HTML tags as literal text (React escaping does the rest)", () => {
    expect(sanitizeBuyerText("<script>alert(1)</script>")).toBe(
      "<script>alert(1)</script>",
    );
  });

  it("strips bidi-override chars (RLO U+202E + LRE/RLE/PDF)", () => {
    const sneaky = `Please ship to JOHN\u202EDOE\u202C`;
    const out = sanitizeBuyerText(sneaky);
    expect(out).toBe("Please ship to JOHNDOE");
  });

  it("strips Unicode bidi isolate chars (U+2066..U+2069)", () => {
    const out = sanitizeBuyerText("a\u2066b\u2067c\u2068d\u2069e");
    expect(out).toBe("abcde");
  });

  it("strips zero-width + BOM chars", () => {
    const out = sanitizeBuyerText("a\u200Bb\u200Cc\u200Dd\uFEFFe");
    expect(out).toBe("abcde");
  });

  it("normalizes CRLF → LF", () => {
    const out = sanitizeBuyerText("line1\r\nline2\r\nline3");
    expect(out).toBe("line1\nline2\nline3");
  });

  it("preserves multi-byte unicode + emoji", () => {
    const out = sanitizeBuyerText("Thanks 🙏 — for the 黒い vinyl");
    expect(out).toBe("Thanks 🙏 — for the 黒い vinyl");
  });

  it("caps at MAX_BUYER_TEXT_LEN with ellipsis", () => {
    const long = "x".repeat(MAX_BUYER_TEXT_LEN + 50);
    const out = sanitizeBuyerText(long);
    expect(out.length).toBe(MAX_BUYER_TEXT_LEN + 1); // +1 for ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("does NOT cap when input is under the limit", () => {
    const exact = "x".repeat(MAX_BUYER_TEXT_LEN);
    expect(sanitizeBuyerText(exact)).toBe(exact);
  });

  it("strips chars BEFORE measuring length", () => {
    // 800 visible chars but with a bunch of ZWSPs sprinkled in — must stay
    // under cap because the strip happens first.
    const padded = "x".repeat(MAX_BUYER_TEXT_LEN) + "\u200B".repeat(50);
    const out = sanitizeBuyerText(padded);
    expect(out).toBe("x".repeat(MAX_BUYER_TEXT_LEN));
    expect(out.endsWith("…")).toBe(false);
  });
});
