// Phase 4.5 — carrier-tracking-urls helper tests.

import { describe, expect, it } from "vitest";
import {
  buildCarrierTrackingUrl,
  buildShipStationOrderPageUrl,
} from "@/lib/shared/carrier-tracking-urls";

describe("buildCarrierTrackingUrl (Phase 4.5)", () => {
  it("returns null when carrier or tracking number is missing", () => {
    expect(buildCarrierTrackingUrl(null, "TRK1")).toBeNull();
    expect(buildCarrierTrackingUrl("USPS", null)).toBeNull();
    expect(buildCarrierTrackingUrl("USPS", "")).toBeNull();
    expect(buildCarrierTrackingUrl("", "TRK1")).toBeNull();
  });

  it("USPS / stamps_com → tools.usps.com", () => {
    expect(buildCarrierTrackingUrl("USPS", "9405511899560000000000")).toContain(
      "tools.usps.com",
    );
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
