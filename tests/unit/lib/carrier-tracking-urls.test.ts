// Phase 4.5 — carrier-tracking-urls helper tests.
// Slice 3 additions — EasyPost public URL preference + isSafeHttpsUrl guard.

import { describe, expect, it } from "vitest";
import {
  buildCarrierTrackingUrl,
  buildShipStationOrderPageUrl,
  isSafeHttpsUrl,
} from "@/lib/shared/carrier-tracking-urls";

describe("buildCarrierTrackingUrl (Phase 4.5)", () => {
  it("returns null when carrier or tracking number is missing", () => {
    expect(buildCarrierTrackingUrl(null, "TRK1")).toBeNull();
    expect(buildCarrierTrackingUrl("USPS", null)).toBeNull();
    expect(buildCarrierTrackingUrl("USPS", "")).toBeNull();
    expect(buildCarrierTrackingUrl("", "TRK1")).toBeNull();
  });

  it("USPS / stamps_com → tools.usps.com", () => {
    expect(buildCarrierTrackingUrl("USPS", "9405511899560000000000")).toContain("tools.usps.com");
    expect(buildCarrierTrackingUrl("stamps_com", "9405511899560000000000")).toContain(
      "tools.usps.com",
    );
  });

  it("UPS variants → ups.com tracking", () => {
    expect(buildCarrierTrackingUrl("ups_walleted", "1Z999")).toContain("ups.com/track");
    expect(buildCarrierTrackingUrl("UPS", "1Z999")).toContain("ups.com/track");
  });

  it("FedEx variants → fedex.com fedextrack", () => {
    expect(buildCarrierTrackingUrl("FedExDefault", "1234567890")).toContain("fedex.com");
    expect(buildCarrierTrackingUrl("fedex_walleted", "1234567890")).toContain("fedex.com");
  });

  it("Asendia / globalpost → tracking.asendiausa.com", () => {
    expect(buildCarrierTrackingUrl("AsendiaUSA", "ASE12345")).toContain("asendiausa.com");
    expect(buildCarrierTrackingUrl("globalpost", "ASE12345")).toContain("asendiausa.com");
  });

  it("DHL Express vs DHL eCommerce route to different sites", () => {
    expect(buildCarrierTrackingUrl("DHLExpress", "DHL1")).toContain("dhl.com/us-en");
    expect(buildCarrierTrackingUrl("dhl_express_worldwide", "DHL1")).toContain("dhl.com/us-en");
    expect(buildCarrierTrackingUrl("DHLeCommerce", "DHL1")).toContain("dhlglobalmail");
    expect(buildCarrierTrackingUrl("DHLGlobalMail", "DHL1")).toContain("dhlglobalmail");
  });

  it("URL-encodes the tracking number", () => {
    const u = buildCarrierTrackingUrl("USPS", "abc def/123");
    expect(u).toContain("abc%20def%2F123");
  });

  it("returns null for unknown carriers (caller falls back to SS order page)", () => {
    expect(buildCarrierTrackingUrl("MysteryCarrier", "TRK1")).toBeNull();
    expect(buildCarrierTrackingUrl("seko_ltl_walleted", "TRK1")).toBeNull();
  });
});

describe("buildShipStationOrderPageUrl (Phase 4.5)", () => {
  it("formats the SS order detail URL with the bigint orderId", () => {
    expect(buildShipStationOrderPageUrl(9001)).toBe(
      "https://ship11.shipstation.com/orders/order-details/9001",
    );
    expect(buildShipStationOrderPageUrl("9001")).toBe(
      "https://ship11.shipstation.com/orders/order-details/9001",
    );
  });
});

// ── Slice 3: EasyPost public URL preference ─────────────────────────────
describe("buildCarrierTrackingUrl — Slice 3 EasyPost public URL preference", () => {
  it("prefers a safe https easyPostPublicUrl over the deterministic carrier template", () => {
    const result = buildCarrierTrackingUrl(
      "USPS",
      "9405511899560000000000",
      "https://track.easypost.com/djE6abc",
    );
    expect(result).toBe("https://track.easypost.com/djE6abc");
  });

  it("falls back to deterministic template when easyPostPublicUrl is null/empty/undefined", () => {
    expect(buildCarrierTrackingUrl("USPS", "9405511899560000000000", null)).toContain(
      "tools.usps.com",
    );
    expect(buildCarrierTrackingUrl("USPS", "9405511899560000000000", "")).toContain(
      "tools.usps.com",
    );
    expect(
      buildCarrierTrackingUrl("USPS", "9405511899560000000000", undefined),
    ).toContain("tools.usps.com");
  });

  it("rejects unsafe protocols smuggled into easyPostPublicUrl (defense-in-depth)", () => {
    // javascript: and data: URLs must NEVER be returned — they would be
    // rendered into an <a href> on the public tracking page.
    expect(buildCarrierTrackingUrl("USPS", "TRK1", "javascript:alert(1)")).toContain(
      "tools.usps.com",
    );
    expect(
      buildCarrierTrackingUrl("USPS", "TRK1", "data:text/html,<script>alert(1)</script>"),
    ).toContain("tools.usps.com");
    expect(buildCarrierTrackingUrl("USPS", "TRK1", "file:///etc/passwd")).toContain(
      "tools.usps.com",
    );
  });

  it("returns easyPostPublicUrl even when carrier is unknown", () => {
    expect(
      buildCarrierTrackingUrl("MysteryCarrier", "TRK1", "https://track.easypost.com/x"),
    ).toBe("https://track.easypost.com/x");
  });

  it("returns null for unknown carriers and no easyPostPublicUrl", () => {
    expect(buildCarrierTrackingUrl("MysteryCarrier", "TRK1", null)).toBeNull();
  });
});

describe("isSafeHttpsUrl (Slice 3)", () => {
  it("accepts https", () => {
    expect(isSafeHttpsUrl("https://example.com")).toBe(true);
  });
  it("accepts http (allowed for in-page links, distinct from image policy)", () => {
    // SAFE_URL_PROTOCOLS includes both http and https — this matches the
    // implementation contract for tracking-link helpers.
    expect(isSafeHttpsUrl("http://example.com")).toBe(true);
  });
  it("rejects javascript:, data:, file:", () => {
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("data:text/html,evil")).toBe(false);
    expect(isSafeHttpsUrl("file:///etc/passwd")).toBe(false);
  });
  it("rejects malformed URLs", () => {
    expect(isSafeHttpsUrl("not a url")).toBe(false);
    expect(isSafeHttpsUrl("")).toBe(false);
    expect(isSafeHttpsUrl(null)).toBe(false);
    expect(isSafeHttpsUrl(undefined)).toBe(false);
  });
});
