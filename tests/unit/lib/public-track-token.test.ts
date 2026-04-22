// Phase 12 — Public tracking token generator tests.

import { describe, expect, it } from "vitest";
import { buildPublicTrackUrl, generatePublicTrackToken } from "@/lib/shared/public-track-token";

describe("generatePublicTrackToken (Phase 12)", () => {
  it("produces 22-char URL-safe base64 strings", () => {
    for (let i = 0; i < 50; i++) {
      const t = generatePublicTrackToken();
      expect(t).toHaveLength(22);
      // base64url alphabet only — no +, /, or =
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("does not collide across N samples (128-bit entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const t = generatePublicTrackToken();
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });
});

describe("buildPublicTrackUrl (Phase 12)", () => {
  it("joins host + token cleanly", () => {
    expect(buildPublicTrackUrl("abc", "https://app.example.com")).toBe(
      "https://app.example.com/track/abc",
    );
  });
  it("strips trailing slashes from host", () => {
    expect(buildPublicTrackUrl("abc", "https://app.example.com//")).toBe(
      "https://app.example.com/track/abc",
    );
  });
});
