// Phase 12 — Public tracking token generator tests.
// Slice 3 — pickPublicDestination, formatPublicDestination,
//           sanitizeBrandColor, sanitizeImageUrl tests.

import { describe, expect, it } from "vitest";
import {
  buildPublicTrackUrl,
  formatPublicDestination,
  generatePublicTrackToken,
  pickPublicDestination,
  sanitizeBrandColor,
  sanitizeImageUrl,
} from "@/lib/shared/public-track-token";

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

// ── Slice 3: pickPublicDestination — allowlist-by-construction ──────────
describe("pickPublicDestination (Slice 3 — PII allowlist)", () => {
  const PII_BLOCKLIST = [
    "name",
    "street",
    "street1",
    "street2",
    "zip",
    "email",
    "phone",
    "buyer_notes",
  ] as const;

  it("returns the three first-class destination columns when present", () => {
    const result = pickPublicDestination({
      destination_city: "Los Angeles",
      destination_state: "CA",
      destination_country: "US",
    });
    expect(result).toEqual({ city: "Los Angeles", state: "CA", country: "US" });
  });

  it("falls back to label_data.shipment.to_address when first-class columns are NULL", () => {
    const result = pickPublicDestination({
      destination_city: null,
      destination_state: null,
      destination_country: null,
      label_data: {
        shipment: {
          to_address: { city: "Brooklyn", state: "NY", country: "US" },
        },
      },
    });
    expect(result).toEqual({ city: "Brooklyn", state: "NY", country: "US" });
  });

  it("HOSTILE INPUT — caller passes PII strings under PII keys; output keys are still allowlist only", () => {
    const hostile: Record<string, unknown> = {
      // Allowlist destination columns
      destination_city: "Chicago",
      destination_state: "IL",
      destination_country: "US",
      // PII fields — must NEVER appear in output
      name: "Recipient Real Name",
      street: "123 Main St",
      street1: "Apt 4B",
      street2: "Building C",
      zip: "60601",
      email: "buyer@example.com",
      phone: "+1 555 123 4567",
      buyer_notes: "Leave with doorman",
      // Random other PII surfaces
      cc_last_four: "4242",
      payment_id: "pi_xyz",
    };
    const result = pickPublicDestination(hostile);
    expect(Object.keys(result).sort()).toEqual(["city", "country", "state"]);
    for (const k of PII_BLOCKLIST) {
      expect(Object.hasOwn(result, k)).toBe(false);
    }
    expect(JSON.stringify(result)).not.toMatch(/Recipient Real Name|123 Main|60601|buyer@/);
  });

  it("HOSTILE INPUT inside label_data.shipment.to_address — only city/state/country are read", () => {
    const result = pickPublicDestination({
      destination_city: null,
      destination_state: null,
      destination_country: null,
      label_data: {
        shipment: {
          to_address: {
            city: "Austin",
            state: "TX",
            country: "US",
            // PII smuggled into label_data — must NOT appear
            name: "Real Buyer Name",
            street1: "999 Real Address",
            street2: "Unit Z",
            zip: "78701",
            email: "real-buyer@x.com",
            phone: "+1 555 111 0000",
          },
        },
      },
    });
    expect(Object.keys(result).sort()).toEqual(["city", "country", "state"]);
    for (const k of PII_BLOCKLIST) {
      expect(Object.hasOwn(result, k)).toBe(false);
    }
    expect(JSON.stringify(result)).not.toMatch(/Real Buyer|999 Real|78701|real-buyer/);
  });

  it("returns nulls when nothing is present", () => {
    const result = pickPublicDestination({});
    expect(result).toEqual({ city: null, state: null, country: null });
  });

  it("trims whitespace and treats empty strings as null", () => {
    const result = pickPublicDestination({
      destination_city: "  ",
      destination_state: "CA  ",
      destination_country: " US ",
    });
    expect(result).toEqual({ city: null, state: "CA", country: "US" });
  });

  it("ignores non-string types in destination columns (defense-in-depth)", () => {
    const result = pickPublicDestination({
      destination_city: 12345 as unknown as string,
      destination_state: { evil: true } as unknown as string,
      destination_country: ["US"] as unknown as string,
    });
    expect(result).toEqual({ city: null, state: null, country: null });
  });
});

describe("formatPublicDestination", () => {
  it("formats all three", () => {
    expect(formatPublicDestination({ city: "Los Angeles", state: "CA", country: "US" })).toBe(
      "Los Angeles, CA, US",
    );
  });
  it("skips empties", () => {
    expect(formatPublicDestination({ city: "Berlin", state: null, country: "DE" })).toBe(
      "Berlin, DE",
    );
    expect(formatPublicDestination({ city: null, state: null, country: null })).toBe("");
  });
});

// ── Slice 3: brand sanitizers ───────────────────────────────────────────
describe("sanitizeBrandColor (Slice 3 — CSS-injection defense)", () => {
  it("accepts valid 6-digit hex", () => {
    expect(sanitizeBrandColor("#ff5733")).toBe("#ff5733");
    expect(sanitizeBrandColor("#FFAABB")).toBe("#FFAABB");
  });
  it("accepts valid 3-digit hex", () => {
    expect(sanitizeBrandColor("#abc")).toBe("#abc");
  });
  it("falls back to default for invalid colors", () => {
    expect(sanitizeBrandColor("red")).toBe("#111827");
    expect(sanitizeBrandColor("rgb(255,0,0)")).toBe("#111827");
    expect(sanitizeBrandColor("expression(alert(1))")).toBe("#111827");
    expect(sanitizeBrandColor("url(javascript:alert(1))")).toBe("#111827");
    expect(sanitizeBrandColor("#zzz")).toBe("#111827");
    expect(sanitizeBrandColor("#1234567")).toBe("#111827");
  });
  it("falls back to default for missing input", () => {
    expect(sanitizeBrandColor(null)).toBe("#111827");
    expect(sanitizeBrandColor(undefined)).toBe("#111827");
    expect(sanitizeBrandColor("")).toBe("#111827");
  });
  it("respects custom fallback", () => {
    expect(sanitizeBrandColor("evil", "#abcdef")).toBe("#abcdef");
  });
});

describe("sanitizeImageUrl (Slice 3 — image src defense)", () => {
  it("allows https URLs", () => {
    expect(sanitizeImageUrl("https://example.com/logo.png")).toBe("https://example.com/logo.png");
  });
  it("rejects http", () => {
    expect(sanitizeImageUrl("http://example.com/logo.png")).toBeNull();
  });
  it("rejects javascript: scheme", () => {
    expect(sanitizeImageUrl("javascript:alert(1)")).toBeNull();
  });
  it("rejects data: URIs", () => {
    expect(sanitizeImageUrl("data:image/svg+xml,<svg/onload=alert(1)>")).toBeNull();
  });
  it("rejects malformed URLs", () => {
    expect(sanitizeImageUrl("not a url")).toBeNull();
    expect(sanitizeImageUrl("")).toBeNull();
    expect(sanitizeImageUrl(null)).toBeNull();
    expect(sanitizeImageUrl(undefined)).toBeNull();
  });
});
