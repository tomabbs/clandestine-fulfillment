// Phase 10.4 — Canonical email-ownership matrix.
//
// Each row is an integration test of `deriveNotificationStrategy`. Locks in
// the no-double-email guarantee and the no-silent-send guarantee. Appendix
// J.6 scenario K references this file as the single source of truth.
//
// When the matrix changes, update BOTH this file AND the docs table in
// `docs/SHIPSTATION_UNIFIED_SHIPPING.md`.

import { describe, expect, it } from "vitest";
import {
  deriveNotificationStrategy,
  type NotificationContext,
  type NotificationStrategy,
} from "@/lib/shared/notification-strategy";

interface MatrixRow {
  name: string;
  ctx: NotificationContext;
  /** Asserted booleans — only the ones that matter for that scenario. */
  expect: Partial<Omit<NotificationStrategy, "rationale">>;
}

const MATRIX: MatrixRow[] = [
  {
    name: "Bandcamp default — BC native via SS connector, no SS email, no Resend",
    ctx: {
      channel: "bandcamp",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: true,
      expectMarketplaceNotify: true,
      sendResendCadence: false,
      suppressShopifyEmail: false,
    },
  },
  {
    name: "Bandcamp + Asendia — BC confirmation + Resend cadence (SS can't track Asendia)",
    ctx: {
      channel: "bandcamp",
      carrier: "Asendia",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: true,
      sendResendCadence: true,
    },
  },
  {
    name: "Clandestine main Shopify — Shopify native confirmation, no SS email",
    ctx: {
      channel: "shopify_main",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: false,
      expectMarketplaceNotify: true,
      sendResendCadence: false,
      suppressShopifyEmail: false,
    },
  },
  {
    name: "Client-store Shopify — Shopify native, no SS email, no Resend",
    ctx: {
      channel: "shopify_client",
      carrier: "UPS",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      expectMarketplaceNotify: true,
      sendResendCadence: false,
    },
  },
  {
    name: "Squarespace direct — SS confirmation + cadence",
    ctx: {
      channel: "squarespace",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: true,
      sendResendCadence: false,
    },
  },
  {
    name: "Squarespace + Asendia — SS confirmation + Resend cadence (SS can't track Asendia)",
    ctx: {
      channel: "squarespace",
      carrier: "Asendia",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      sendResendCadence: true,
    },
  },
  {
    name: "Manual SS order — SS confirmation only, no marketplace notify",
    ctx: {
      channel: "manual_ss",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "hybrid" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: false,
    },
  },
  {
    name: "Per-shipment suppress_ss_email override forces SS email off",
    ctx: {
      channel: "manual_ss",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "hybrid" },
      shipmentOverrides: { suppress_ss_email: true },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      suppressSsEmail: true,
    },
  },
  {
    name: "Workspace strategy=ss_for_all — SS owns everything",
    ctx: {
      channel: "shopify_client",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "ss_for_all" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: false,
      expectMarketplaceNotify: false,
      sendResendCadence: false,
      suppressShopifyEmail: true,
    },
  },
  {
    name: "Workspace strategy=resend_for_all — we own everything, SS silent",
    ctx: {
      channel: "bandcamp",
      carrier: "Asendia",
      workspaceFlags: { email_send_strategy: "resend_for_all" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: false,
      expectMarketplaceNotify: false,
      sendResendCadence: true,
      suppressShopifyEmail: true,
      suppressSsEmail: true,
    },
  },
  {
    name: "Bandcamp + bandcamp_skip_ss_email=false flag → SS confirmation enabled",
    ctx: {
      channel: "bandcamp",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "hybrid", bandcamp_skip_ss_email: false },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: true,
    },
  },
];

describe("deriveNotificationStrategy — canonical matrix (Phase 10.4)", () => {
  it.each(MATRIX)("$name", ({ ctx, expect: expected }) => {
    const out = deriveNotificationStrategy(ctx);
    for (const [k, v] of Object.entries(expected)) {
      expect(out[k as keyof NotificationStrategy]).toBe(v);
    }
    // Every call must produce a non-empty rationale for audit.
    expect(out.rationale.length).toBeGreaterThan(0);
  });

  it("Asendia carrier detection — known aliases match", () => {
    for (const carrier of ["Asendia", "asendia_usa", "USPS_Mail_Innovation", "GlobalPost"]) {
      const out = deriveNotificationStrategy({
        channel: "shopify_main",
        carrier,
        workspaceFlags: { email_send_strategy: "hybrid" },
      });
      expect(out.sendResendCadence).toBe(true);
    }
  });

  it("non-Asendia carriers do NOT trigger Resend cadence under hybrid", () => {
    for (const carrier of ["USPS", "UPS", "FedEx", "DHL Express"]) {
      const out = deriveNotificationStrategy({
        channel: "manual_ss",
        carrier,
        workspaceFlags: { email_send_strategy: "hybrid" },
      });
      expect(out.sendResendCadence).toBe(false);
    }
  });
});
