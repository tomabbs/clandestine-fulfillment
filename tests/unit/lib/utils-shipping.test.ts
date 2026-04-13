import { describe, expect, it } from "vitest";
import { maxShippingFromOrderLineItems } from "@/lib/utils";

describe("maxShippingFromOrderLineItems", () => {
  it("returns null for non-arrays", () => {
    expect(maxShippingFromOrderLineItems(null)).toBeNull();
    expect(maxShippingFromOrderLineItems({})).toBeNull();
  });

  it("returns max shipping from Bandcamp-style rows", () => {
    expect(
      maxShippingFromOrderLineItems([{ shipping: 3.5 }, { shipping: 3.5 }, { shipping: 0 }]),
    ).toBe(3.5);
  });

  it("returns null when no positive shipping", () => {
    expect(maxShippingFromOrderLineItems([{ shipping: 0 }])).toBeNull();
  });
});
