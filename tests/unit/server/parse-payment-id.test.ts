// Phase 6.1 — parsePaymentIdFromCustomField tests.

import { describe, expect, it } from "vitest";
import { parsePaymentIdFromCustomField } from "@/lib/shared/bandcamp-reconcile-helpers";

describe("parsePaymentIdFromCustomField (Phase 6.1)", () => {
  it("returns null for null/undefined/empty", () => {
    expect(parsePaymentIdFromCustomField(null)).toBeNull();
    expect(parsePaymentIdFromCustomField(undefined)).toBeNull();
    expect(parsePaymentIdFromCustomField("")).toBeNull();
  });

  it("returns null when no 4+ digit number is present", () => {
    expect(parsePaymentIdFromCustomField("BC-")).toBeNull();
    expect(parsePaymentIdFromCustomField("nothing here")).toBeNull();
    expect(parsePaymentIdFromCustomField("123")).toBeNull(); // < 4 digits
  });

  it("extracts a bare numeric payment_id", () => {
    expect(parsePaymentIdFromCustomField("1234567")).toBe(1234567);
  });

  it("extracts payment_id from BC-1234567 / Bandcamp:1234567 / payment_id=1234567 patterns", () => {
    expect(parsePaymentIdFromCustomField("BC-1234567")).toBe(1234567);
    expect(parsePaymentIdFromCustomField("Bandcamp:1234567")).toBe(1234567);
    expect(parsePaymentIdFromCustomField("payment_id=1234567")).toBe(1234567);
    expect(parsePaymentIdFromCustomField("bandcamp_payment=9876543")).toBe(9876543);
  });

  it("takes the FIRST run of >=4 digits (operator-friendly default)", () => {
    expect(parsePaymentIdFromCustomField("BC-1234567 (was 9999)")).toBe(1234567);
  });
});
