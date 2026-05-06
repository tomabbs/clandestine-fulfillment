import { describe, expect, it } from "vitest";
import {
  classifyBandcampPreorderSignal,
  getRecentBandcampProductDate,
  getRecentBandcampProductDateEvidence,
  isRecentBandcampProduct,
  summarizeBandcampPreorderSignals,
} from "@/lib/server/bandcamp-preorder-dashboard";

describe("bandcamp preorder dashboard helpers", () => {
  const today = "2026-05-06";

  it("classifies future scraped release dates as current upcoming", () => {
    expect(
      classifyBandcampPreorderSignal({
        today,
        bandcampReleaseDate: "2026-06-19T00:00:00+00:00",
        bandcampNewDate: "2026-04-01",
        bandcampIsPreorder: true,
      }),
    ).toBe("current_upcoming");
  });

  it("classifies future API new_date as current upcoming fallback", () => {
    expect(
      classifyBandcampPreorderSignal({
        today,
        bandcampReleaseDate: null,
        bandcampNewDate: "2026-05-15",
        bandcampIsPreorder: null,
      }),
    ).toBe("current_upcoming");
  });

  it("keeps past Bandcamp preorder flags out of current upcoming counts", () => {
    expect(
      classifyBandcampPreorderSignal({
        today,
        bandcampReleaseDate: "2026-04-24T00:00:00+00:00",
        bandcampNewDate: "2026-02-19",
        bandcampIsPreorder: true,
      }),
    ).toBe("stale_historical");
  });

  it("surfaces explicit preorder flags with no dates for review", () => {
    expect(
      classifyBandcampPreorderSignal({
        today,
        bandcampReleaseDate: null,
        bandcampNewDate: null,
        bandcampIsPreorder: true,
      }),
    ).toBe("needs_release_date");
  });

  it("summarizes signal buckets", () => {
    expect(
      summarizeBandcampPreorderSignals([
        { signalKind: "current_upcoming" },
        { signalKind: "current_upcoming" },
        { signalKind: "stale_historical" },
        { signalKind: "needs_release_date" },
        { signalKind: "not_preorder" },
      ]),
    ).toEqual({
      currentUpcoming: 2,
      staleHistorical: 1,
      needsReleaseDate: 1,
    });
  });

  it("treats Bandcamp release/new dates, not mapping creation time, as recent product evidence", () => {
    expect(
      isRecentBandcampProduct({
        today,
        windowStart: "2026-04-06",
        bandcampReleaseDate: "2026-04-24T00:00:00+00:00",
        bandcampNewDate: "2018-02-01",
      }),
    ).toBe(true);

    expect(
      isRecentBandcampProduct({
        today,
        windowStart: "2026-04-06",
        bandcampReleaseDate: "2018-04-24T00:00:00+00:00",
        bandcampNewDate: "2026-04-08",
      }),
    ).toBe(true);

    expect(
      isRecentBandcampProduct({
        today,
        windowStart: "2026-04-06",
        bandcampReleaseDate: null,
        bandcampNewDate: null,
      }),
    ).toBe(false);
  });

  it("displays the qualifying recent Bandcamp-origin date", () => {
    expect(
      getRecentBandcampProductDate({
        today,
        windowStart: "2026-04-06",
        bandcampReleaseDate: "2018-04-24T00:00:00+00:00",
        bandcampNewDate: "2026-04-08",
      }),
    ).toBe("2026-04-08");
  });

  it("labels whether a recent Bandcamp date is a release date or listing date", () => {
    expect(
      getRecentBandcampProductDateEvidence({
        today,
        windowStart: "2026-04-06",
        bandcampReleaseDate: "2026-04-24T00:00:00+00:00",
        bandcampNewDate: "2026-04-08",
      }),
    ).toEqual({ date: "2026-04-24", source: "release" });

    expect(
      getRecentBandcampProductDateEvidence({
        today,
        windowStart: "2026-04-06",
        bandcampReleaseDate: "2026-06-26T00:00:00+00:00",
        bandcampNewDate: "2026-04-21",
      }),
    ).toEqual({ date: "2026-04-21", source: "listed" });
  });
});
