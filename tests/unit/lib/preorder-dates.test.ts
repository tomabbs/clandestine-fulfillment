import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveStreetDateAndPreorder,
  extractDateOnly,
  getTodayNY,
  isDaysAfterRelease,
  isFutureReleaseDate,
  isStreetDateOnOrBefore,
} from "@/lib/shared/preorder-dates";

// Fix the clock to 2026-04-10T14:00:00Z (10 AM Eastern = UTC-4 in spring)
const FIXED_NOW = new Date("2026-04-10T14:00:00Z");
const FIXED_TODAY_NY = "2026-04-10";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getTodayNY", () => {
  it("returns YYYY-MM-DD in New York timezone", () => {
    expect(getTodayNY()).toBe(FIXED_TODAY_NY);
  });
});

describe("extractDateOnly", () => {
  it("handles ISO timestamp", () => {
    expect(extractDateOnly("2026-05-01T00:00:00Z")).toBe("2026-05-01");
  });
  it("handles date-only string", () => {
    expect(extractDateOnly("2026-05-01")).toBe("2026-05-01");
  });
  it("returns null for null/undefined", () => {
    expect(extractDateOnly(null)).toBeNull();
    expect(extractDateOnly(undefined)).toBeNull();
  });
});

describe("isFutureReleaseDate", () => {
  it("tomorrow is a future release date", () => {
    expect(isFutureReleaseDate("2026-04-11")).toBe(true);
  });
  it("today is NOT a future release date (releases today → should release)", () => {
    expect(isFutureReleaseDate("2026-04-10")).toBe(false);
  });
  it("yesterday is not a future release date", () => {
    expect(isFutureReleaseDate("2026-04-09")).toBe(false);
  });
  it("handles null/undefined", () => {
    expect(isFutureReleaseDate(null)).toBe(false);
    expect(isFutureReleaseDate(undefined)).toBe(false);
  });
  it("handles ISO timestamp", () => {
    expect(isFutureReleaseDate("2026-04-15T00:00:00Z")).toBe(true);
  });
});

describe("isStreetDateOnOrBefore", () => {
  it("today is on-or-before (should release)", () => {
    expect(isStreetDateOnOrBefore("2026-04-10")).toBe(true);
  });
  it("yesterday is on-or-before", () => {
    expect(isStreetDateOnOrBefore("2026-04-09")).toBe(true);
  });
  it("tomorrow is NOT on-or-before", () => {
    expect(isStreetDateOnOrBefore("2026-04-11")).toBe(false);
  });
});

describe("isDaysAfterRelease", () => {
  it("45 days ago qualifies", () => {
    const d45 = new Date(FIXED_NOW);
    d45.setDate(d45.getDate() - 45);
    expect(isDaysAfterRelease(d45.toISOString().slice(0, 10), 45)).toBe(true);
  });
  it("44 days ago does not qualify for 45-day threshold", () => {
    const d44 = new Date(FIXED_NOW);
    d44.setDate(d44.getDate() - 44);
    expect(isDaysAfterRelease(d44.toISOString().slice(0, 10), 45)).toBe(false);
  });

  // NY-timezone hardening (Phase 0.1): the function MUST anchor on getTodayNY,
  // not on the server's UTC clock. These cases would have failed under the old
  // UTC-only impl when the UTC day differed from the NY day.
  it("today (N=0) qualifies — releases today are 0 days after release", () => {
    expect(isDaysAfterRelease(FIXED_TODAY_NY, 0)).toBe(true);
  });

  it("yesterday qualifies for N=1", () => {
    expect(isDaysAfterRelease("2026-04-09", 1)).toBe(true);
  });

  it("today does NOT qualify for N=1", () => {
    expect(isDaysAfterRelease(FIXED_TODAY_NY, 1)).toBe(false);
  });

  it("tomorrow does not qualify for any N >= 0", () => {
    expect(isDaysAfterRelease("2026-04-11", 0)).toBe(false);
    expect(isDaysAfterRelease("2026-04-11", 7)).toBe(false);
  });

  it("exactly N days after the release date qualifies", () => {
    // Release 7 days before today = 2026-04-03 (NY)
    expect(isDaysAfterRelease("2026-04-03", 7)).toBe(true);
    // 6 days before today = 2026-04-04 — does NOT meet the 7-day threshold
    expect(isDaysAfterRelease("2026-04-04", 7)).toBe(false);
  });

  it("DST forward jump (spring): cutoff still anchors on NY calendar", () => {
    // Spring DST 2026 in NY = Sun Mar 8. Pin clock to right after the jump.
    vi.setSystemTime(new Date("2026-03-09T15:00:00Z")); // 11 AM EDT (UTC-4)
    // "today NY" = 2026-03-09. Release 7 days before = 2026-03-02 — qualifies.
    expect(isDaysAfterRelease("2026-03-02", 7)).toBe(true);
    expect(isDaysAfterRelease("2026-03-03", 7)).toBe(false);
  });

  it("DST fall back (autumn): cutoff still anchors on NY calendar", () => {
    // Fall DST 2026 in NY = Sun Nov 1. Pin clock to right after the fall back.
    vi.setSystemTime(new Date("2026-11-02T15:00:00Z")); // 10 AM EST (UTC-5)
    // "today NY" = 2026-11-02. Release 7 days before = 2026-10-26 — qualifies.
    expect(isDaysAfterRelease("2026-10-26", 7)).toBe(true);
    expect(isDaysAfterRelease("2026-10-27", 7)).toBe(false);
  });

  it("UTC-vs-NY day boundary: late-evening NY (early-morning UTC next day) still uses NY calendar", () => {
    // 03:30 UTC on 2026-04-11 is 23:30 EDT on 2026-04-10 — NY is still on the 10th.
    vi.setSystemTime(new Date("2026-04-11T03:30:00Z"));
    // "today NY" should be 2026-04-10. Release 1 day before = 2026-04-09 qualifies for N=1.
    expect(isDaysAfterRelease("2026-04-09", 1)).toBe(true);
    // Release "today NY" (2026-04-10) does NOT qualify for N=1 — would have erroneously
    // qualified under the old UTC impl because UTC says it's already 2026-04-11.
    expect(isDaysAfterRelease("2026-04-10", 1)).toBe(false);
  });
});

describe("deriveStreetDateAndPreorder", () => {
  it("uses scraperReleaseDate first (highest priority)", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: "2026-05-01",
      apiNewDate: "2026-06-01",
      merchNewDate: "2026-07-01",
      authorityStatus: "bandcamp_initial",
    });
    expect(result.street_date).toBe("2026-05-01");
    expect(result.is_preorder).toBe(true);
  });

  it("falls back to apiNewDate when no scraper date", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: null,
      apiNewDate: "2026-05-15",
      authorityStatus: "bandcamp_initial",
    });
    expect(result.street_date).toBe("2026-05-15");
    expect(result.is_preorder).toBe(true);
  });

  it("falls back to merchNewDate last", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: null,
      apiNewDate: null,
      merchNewDate: "2026-05-20",
      authorityStatus: "bandcamp_initial",
    });
    expect(result.street_date).toBe("2026-05-20");
    expect(result.is_preorder).toBe(true);
  });

  it("past date → is_preorder = false", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: "2026-01-01",
      authorityStatus: "bandcamp_initial",
    });
    expect(result.is_preorder).toBe(false);
  });

  it("today → is_preorder = false (releases today)", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: "2026-04-10",
      authorityStatus: "bandcamp_initial",
    });
    expect(result.is_preorder).toBe(false);
  });

  it("bandcampIsPreorder=true overrides date arithmetic for future date", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: "2026-05-01",
      bandcampIsPreorder: true,
      authorityStatus: "bandcamp_initial",
    });
    expect(result.is_preorder).toBe(true);
  });

  it("does NOT overwrite street_date when authority is warehouse-owned", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: "2026-07-01",
      apiNewDate: "2026-07-15",
      currentStreetDate: "2026-06-01",
      authorityStatus: "warehouse",
    });
    // warehouse-owned → keep existing date, only fill if empty
    expect(result.street_date).toBe("2026-06-01");
  });

  it("fills empty street_date even when warehouse-owned", () => {
    const result = deriveStreetDateAndPreorder({
      scraperReleaseDate: "2026-07-01",
      currentStreetDate: null,
      authorityStatus: "warehouse",
    });
    expect(result.street_date).toBe("2026-07-01");
  });

  it("returns null street_date and false is_preorder when no dates available", () => {
    const result = deriveStreetDateAndPreorder({});
    expect(result.street_date).toBeNull();
    expect(result.is_preorder).toBe(false);
  });
});
