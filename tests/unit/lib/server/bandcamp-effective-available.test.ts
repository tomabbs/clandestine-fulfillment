import { describe, expect, it } from "vitest";
import {
  computeBandcampSeedQuantity,
  computeEffectiveBandcampAvailable,
  computeEffectiveBandcampAvailableByOption,
} from "@/lib/server/bandcamp-effective-available";

describe("computeEffectiveBandcampAvailable", () => {
  it("returns 0 for null/undefined/non-array input", () => {
    expect(computeEffectiveBandcampAvailable(null)).toBe(0);
    expect(computeEffectiveBandcampAvailable(undefined)).toBe(0);
    expect(computeEffectiveBandcampAvailable("not an array")).toBe(0);
    expect(computeEffectiveBandcampAvailable({ origin_id: 1 })).toBe(0);
  });

  it("sums quantities across origins for a package-level product", () => {
    const origins = [
      {
        origin_id: 100,
        option_quantities: [{ option_id: null, quantity_available: 7 }],
      },
      {
        origin_id: 101,
        option_quantities: [{ option_id: null, quantity_available: 3 }],
      },
    ];
    expect(computeEffectiveBandcampAvailable(origins)).toBe(10);
  });

  it("sums per-option quantities for an option-level product", () => {
    const origins = [
      {
        origin_id: 100,
        option_quantities: [
          { option_id: 1, quantity_available: 5 },
          { option_id: 2, quantity_available: 8 },
        ],
      },
    ];
    expect(computeEffectiveBandcampAvailable(origins)).toBe(13);
  });

  it("ignores non-numeric or negative quantities", () => {
    const origins = [
      {
        origin_id: 100,
        option_quantities: [
          { option_id: 1, quantity_available: "garbage" as unknown as number },
          { option_id: 2, quantity_available: -5 },
          { option_id: 3, quantity_available: 4 },
        ],
      },
    ];
    expect(computeEffectiveBandcampAvailable(origins)).toBe(4);
  });

  it("ignores origins missing option_quantities array", () => {
    const origins = [
      { origin_id: 100, option_quantities: null },
      { origin_id: 101, option_quantities: [{ option_id: 1, quantity_available: 6 }] },
    ];
    expect(computeEffectiveBandcampAvailable(origins)).toBe(6);
  });
});

describe("computeEffectiveBandcampAvailableByOption", () => {
  it("returns empty map for package-level (no option_id) data", () => {
    const origins = [
      {
        origin_id: 100,
        option_quantities: [{ option_id: null, quantity_available: 7 }],
      },
    ];
    expect(computeEffectiveBandcampAvailableByOption(origins).size).toBe(0);
  });

  it("aggregates per option_id across origins", () => {
    const origins = [
      {
        origin_id: 100,
        option_quantities: [
          { option_id: 1, quantity_available: 4 },
          { option_id: 2, quantity_available: 9 },
        ],
      },
      {
        origin_id: 101,
        option_quantities: [{ option_id: 1, quantity_available: 6 }],
      },
    ];
    const map = computeEffectiveBandcampAvailableByOption(origins);
    expect(map.get(1)).toBe(10);
    expect(map.get(2)).toBe(9);
    expect(map.size).toBe(2);
  });
});

describe("computeBandcampSeedQuantity (Phase 1 follow-up #2 — warehouse seed correction)", () => {
  it("trusts origin sum when origin_quantities is a non-empty array", () => {
    const merchItem = {
      quantity_available: 999,
      origin_quantities: [
        {
          origin_id: 100,
          option_quantities: [{ option_id: null, quantity_available: 5 }],
        },
      ],
    };
    expect(computeBandcampSeedQuantity(merchItem)).toEqual({
      effective: 5,
      source: "origin_sum",
    });
  });

  it("baseline anomaly: returns 0 from origin sum even when TOP > 0 (Lord Spikeheart shape)", () => {
    // Real Lord Spikeheart shape: TOP shows 100 (baseline) but origin allocation is 0.
    // We must NOT seed 100 — that's the entire bug Phase 1 follow-up #2 closes.
    const merchItem = {
      quantity_available: 100,
      origin_quantities: [
        {
          origin_id: 4924101,
          option_quantities: [{ option_id: 1052499935, quantity_available: 0 }],
        },
      ],
    };
    expect(computeBandcampSeedQuantity(merchItem)).toEqual({
      effective: 0,
      source: "origin_sum",
    });
  });

  it("falls back to TOP when origin_quantities is missing/null/empty", () => {
    expect(computeBandcampSeedQuantity({ quantity_available: 7, origin_quantities: null })).toEqual(
      { effective: 7, source: "top_fallback" },
    );
    expect(computeBandcampSeedQuantity({ quantity_available: 7 })).toEqual({
      effective: 7,
      source: "top_fallback",
    });
    expect(computeBandcampSeedQuantity({ quantity_available: 7, origin_quantities: [] })).toEqual({
      effective: 7,
      source: "top_fallback",
    });
  });

  it("returns zero when both TOP and origin_quantities are absent or non-positive", () => {
    expect(computeBandcampSeedQuantity({})).toEqual({ effective: 0, source: "zero" });
    expect(computeBandcampSeedQuantity({ quantity_available: 0 })).toEqual({
      effective: 0,
      source: "zero",
    });
    expect(
      computeBandcampSeedQuantity({ quantity_available: null, origin_quantities: null }),
    ).toEqual({ effective: 0, source: "zero" });
  });

  it("multi-origin sum is preferred over TOP (legitimate multi-origin merchant)", () => {
    const merchItem = {
      quantity_available: 50, // arbitrary TOP — ignored when origins present
      origin_quantities: [
        {
          origin_id: 100,
          option_quantities: [{ option_id: null, quantity_available: 12 }],
        },
        {
          origin_id: 101,
          option_quantities: [{ option_id: null, quantity_available: 8 }],
        },
      ],
    };
    expect(computeBandcampSeedQuantity(merchItem)).toEqual({
      effective: 20,
      source: "origin_sum",
    });
  });
});
