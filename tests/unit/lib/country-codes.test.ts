import { describe, expect, it } from "vitest";
import {
  normalizeCountryCode,
  normalizeCountryCodeWithDefault,
} from "@/lib/shared/country-codes";

describe("normalizeCountryCode (Phase 0.5.7)", () => {
  it("returns null for null/undefined/empty", () => {
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode(undefined)).toBeNull();
    expect(normalizeCountryCode("")).toBeNull();
    expect(normalizeCountryCode("   ")).toBeNull();
  });

  it("US variants → 'US'", () => {
    expect(normalizeCountryCode("US")).toBe("US");
    expect(normalizeCountryCode("us")).toBe("US");
    expect(normalizeCountryCode("USA")).toBe("US");
    expect(normalizeCountryCode("U.S.A.")).toBe("US");
    expect(normalizeCountryCode("U.S.")).toBe("US");
    expect(normalizeCountryCode("United States")).toBe("US");
    expect(normalizeCountryCode("United States of America")).toBe("US");
    expect(normalizeCountryCode("america")).toBe("US");
  });

  it("UK / GB variants → 'GB'", () => {
    expect(normalizeCountryCode("UK")).toBe("GB");
    expect(normalizeCountryCode("GB")).toBe("GB");
    expect(normalizeCountryCode("Great Britain")).toBe("GB");
    expect(normalizeCountryCode("United Kingdom")).toBe("GB");
    expect(normalizeCountryCode("England")).toBe("GB");
    expect(normalizeCountryCode("Scotland")).toBe("GB");
    expect(normalizeCountryCode("Wales")).toBe("GB");
    expect(normalizeCountryCode("Northern Ireland")).toBe("GB");
  });

  it("EU + APAC + LATAM common destinations resolve correctly", () => {
    expect(normalizeCountryCode("Canada")).toBe("CA");
    expect(normalizeCountryCode("Australia")).toBe("AU");
    expect(normalizeCountryCode("New Zealand")).toBe("NZ");
    expect(normalizeCountryCode("germany")).toBe("DE");
    expect(normalizeCountryCode("Deutschland")).toBe("DE");
    expect(normalizeCountryCode("France")).toBe("FR");
    expect(normalizeCountryCode("Italy")).toBe("IT");
    expect(normalizeCountryCode("Italia")).toBe("IT");
    expect(normalizeCountryCode("Spain")).toBe("ES");
    expect(normalizeCountryCode("España")).toBe("ES");
    expect(normalizeCountryCode("Netherlands")).toBe("NL");
    expect(normalizeCountryCode("The Netherlands")).toBe("NL");
    expect(normalizeCountryCode("Holland")).toBe("NL");
    expect(normalizeCountryCode("Sweden")).toBe("SE");
    expect(normalizeCountryCode("Norway")).toBe("NO");
    expect(normalizeCountryCode("Denmark")).toBe("DK");
    expect(normalizeCountryCode("Finland")).toBe("FI");
    expect(normalizeCountryCode("Ireland")).toBe("IE");
    expect(normalizeCountryCode("Japan")).toBe("JP");
    expect(normalizeCountryCode("Mexico")).toBe("MX");
    expect(normalizeCountryCode("México")).toBe("MX");
    expect(normalizeCountryCode("Brazil")).toBe("BR");
    expect(normalizeCountryCode("Brasil")).toBe("BR");
    expect(normalizeCountryCode("Switzerland")).toBe("CH");
    expect(normalizeCountryCode("Czech Republic")).toBe("CZ");
    expect(normalizeCountryCode("Czechia")).toBe("CZ");
    expect(normalizeCountryCode("Iceland")).toBe("IS");
  });

  it("unknown 2-letter code passes through (assumed alpha-2)", () => {
    expect(normalizeCountryCode("ZZ")).toBe("ZZ");
    expect(normalizeCountryCode("zw")).toBe("ZW");
  });

  it("unknown free-form text returns null (caller decides default)", () => {
    expect(normalizeCountryCode("Mars")).toBeNull();
    expect(normalizeCountryCode("Some Country")).toBeNull();
  });

  it("trims whitespace before lookup", () => {
    expect(normalizeCountryCode("  USA  ")).toBe("US");
    expect(normalizeCountryCode(" united\tkingdom ")).toBeNull();
    // (single-space-normalized free-form names not in alias table return null;
    // alias keys must match exactly after upper+trim — by design, no fuzzy match)
  });

  it("normalizeCountryCodeWithDefault falls back to 'US' on null", () => {
    expect(normalizeCountryCodeWithDefault(null)).toBe("US");
    expect(normalizeCountryCodeWithDefault("")).toBe("US");
    expect(normalizeCountryCodeWithDefault("Mars")).toBe("US");
    expect(normalizeCountryCodeWithDefault("UK")).toBe("GB");
  });
});
