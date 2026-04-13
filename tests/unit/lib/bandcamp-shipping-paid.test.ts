import { describe, expect, it } from "vitest";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { shippingPaidFromBandcampLines } from "@/lib/server/bandcamp-shipping-paid";

describe("shippingPaidFromBandcampLines", () => {
  it("returns max shipping across repeated rows", () => {
    const lines = [{ shipping: 4.5 }, { shipping: 4.5 }] as unknown as BandcampOrderItem[];
    expect(shippingPaidFromBandcampLines(lines)).toBe(4.5);
  });

  it("returns 0 when all lines have zero shipping", () => {
    const lines = [{ shipping: 0 }] as unknown as BandcampOrderItem[];
    expect(shippingPaidFromBandcampLines(lines)).toBe(0);
  });
});
