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
