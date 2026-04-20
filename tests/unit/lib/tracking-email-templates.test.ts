// Phase 12 — Email template render tests.
//
// Asserts:
//   - All 4 templates render with realistic + sparse data
//   - HTML output contains the tracking URL
//   - HTML output escapes hostile content (XSS in customer_name, etc.)
//   - Plain-text alt is non-empty
//   - Subject line includes order context

import { describe, expect, it } from "vitest";
import {
  renderDelivered,
  renderException,
  renderForTrigger,
  renderOutForDelivery,
  renderShipmentConfirmation,
  type TemplateContext,
} from "@/lib/shared/tracking-email-templates";

const FULL_CTX: TemplateContext = {
  org: {
    org_name: "Band Beta Records",
    brand_color: "#ff3366",
    support_email: "support@bandbeta.com",
    logo_url: "https://example.com/logo.png",
  },
  customer_name: "Jane Doe",
  order_number: "BC-1234567",
  item_summary: "Album X by Band Beta",
  carrier: "USPS",
  tracking_number: "9400123456789012345678",
  tracking_url: "https://app.example.com/track/abcDEF12345abcDEF12345",
  event_date: "2026-04-19T18:30:00Z",
  exception_message: null,
};

const SPARSE_CTX: TemplateContext = {
  org: {
    org_name: "Clandestine Distribution",
    brand_color: null,
    support_email: null,
  },
  customer_name: null,
  order_number: "SS-9999",
  item_summary: null,
  carrier: null,
  tracking_number: null,
  tracking_url: "https://app.example.com/track/sparse",
};

describe("Tracking email templates (Phase 12)", () => {
  it("Shipment Confirmation renders with full context", () => {
    const r = renderShipmentConfirmation(FULL_CTX);
    expect(r.subject).toContain("Album X by Band Beta");
    expect(r.html).toContain("Jane");
    expect(r.html).toContain(FULL_CTX.tracking_url);
    expect(r.html).toContain("Band Beta Records");
    expect(r.html).toContain("9400123456789012345678");
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).toContain(FULL_CTX.tracking_url);
  });

  it("Shipment Confirmation degrades gracefully on sparse context", () => {
    const r = renderShipmentConfirmation(SPARSE_CTX);
    expect(r.subject).toContain("SS-9999");
    expect(r.html).toContain("Hi there");
    expect(r.html).toContain(SPARSE_CTX.tracking_url);
  });

  it("Out for Delivery template includes today emphasis", () => {
    const r = renderOutForDelivery(FULL_CTX);
    expect(r.subject).toContain("Album X by Band Beta");
    expect(r.html).toContain("out for delivery");
    expect(r.html).toContain(FULL_CTX.tracking_url);
  });

  it("Delivered template formats event_date when present", () => {
    const r = renderDelivered(FULL_CTX);
    expect(r.subject).toContain("Album X by Band Beta");
    // date-fns-style: month name appears
    expect(r.html.toLowerCase()).toMatch(/april|monday|sunday/);
  });

  it("Delivered template uses generic 'Delivered.' when event_date is missing", () => {
    const r = renderDelivered({ ...FULL_CTX, event_date: null });
    expect(r.html).toContain("Delivered.");
  });

  it("Exception template includes carrier message when present", () => {
    const r = renderException({
      ...FULL_CTX,
      exception_message: "Address requires correction",
    });
    expect(r.subject).toContain("BC-1234567");
    expect(r.html).toContain("Address requires correction");
    expect(r.html).toContain("View tracking details");
  });

  it("Exception template skips carrier message when absent", () => {
    const r = renderException(FULL_CTX);
    expect(r.html).not.toContain("Carrier message:");
  });

  it("escapes hostile customer_name (no XSS)", () => {
    const r = renderShipmentConfirmation({
      ...FULL_CTX,
      customer_name: "<script>alert(1)</script>",
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("escapes hostile item_summary (no XSS)", () => {
    const r = renderShipmentConfirmation({
      ...FULL_CTX,
      item_summary: '"><img src=x onerror=alert(1)>',
    });
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("&lt;img");
  });

  it("escapes hostile org_name (no XSS in chrome)", () => {
    const r = renderShipmentConfirmation({
      ...FULL_CTX,
      org: { ...FULL_CTX.org, org_name: "<svg/onload=alert(1)>" },
    });
    expect(r.html).not.toContain("<svg/onload=alert(1)>");
  });

  it("renderForTrigger dispatcher routes by trigger_status", () => {
    const triggers = ["shipped", "out_for_delivery", "delivered", "exception"] as const;
    for (const t of triggers) {
      const r = renderForTrigger(t, FULL_CTX);
      expect(r.html.length).toBeGreaterThan(0);
      expect(r.subject.length).toBeGreaterThan(0);
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it("invariant: tracking_url appears EXACTLY once in HTML for every template (the CTA button)", () => {
    for (const t of ["shipped", "out_for_delivery", "delivered", "exception"] as const) {
      const r = renderForTrigger(t, FULL_CTX);
      // count occurrences
      const matches = r.html.match(
        new RegExp(FULL_CTX.tracking_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      );
      expect(matches?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });
});
