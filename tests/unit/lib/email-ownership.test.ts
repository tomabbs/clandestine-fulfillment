// Phase 12 — Canonical email-ownership matrix.
//
// Each row is an integration test of `deriveNotificationStrategy`. Locks in
// the no-double-email guarantee and the no-silent-send guarantee. When the
// matrix changes, update BOTH this file AND the docs table in
// `docs/SHIPSTATION_UNIFIED_SHIPPING.md`.
//
// Phase 12 collapsed the Phase 10 13-row hybrid matrix into 4 strategy modes:
//   off / shadow / unified_resend / ss_for_all
// Plus the per-shipment hard-kill (suppress_emails) and Asendia carrier
// detection live as separate test groups.

import { describe, expect, it } from "vitest";
import {
  deriveNotificationStrategy,
  type NotificationContext,
  type NotificationStrategy,
} from "@/lib/shared/notification-strategy";

interface MatrixRow {
  name: string;
  ctx: NotificationContext;
  expect: Partial<Omit<NotificationStrategy, "rationale">>;
}

// ── strategy='off' (legacy hybrid behavior, the safe pre-Phase-12 default) ──
const OFF_MATRIX: MatrixRow[] = [
  {
    name: "off + Bandcamp → BC native via SS connector, no SS email, NO unified",
    ctx: {
      channel: "bandcamp",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "off" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: true,
      expectMarketplaceNotify: true,
      sendUnifiedResendEmails: false,
      shadowMode: false,
    },
  },
  {
    name: "off + Shopify client → Shopify native, no SS, NO unified",
    ctx: {
      channel: "shopify_client",
      carrier: "UPS",
      workspaceFlags: { email_send_strategy: "off" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: false,
      sendUnifiedResendEmails: false,
    },
  },
  {
    name: "off + Squarespace direct → SS native, NO unified",
    ctx: {
      channel: "squarespace",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "off" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: true,
      sendUnifiedResendEmails: false,
    },
  },
];

// ── strategy='shadow' (parallel-run; SS continues + unified runs to allowlist) ──
const SHADOW_MATRIX: MatrixRow[] = [
  {
    name: "shadow + Bandcamp → SS continues, unified ALSO runs (to allowlist)",
    ctx: {
      channel: "bandcamp",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "shadow" },
    },
    expect: {
      callShipstationNotifyCustomer: false, // BC default in off-mode logic
      callShipstationNotifyOrderSource: true,
      sendUnifiedResendEmails: true,
      shadowMode: true,
    },
  },
  {
    name: "shadow + Squarespace direct → SS continues emailing real customer + unified to allowlist",
    ctx: {
      channel: "squarespace",
      carrier: "Asendia",
      workspaceFlags: { email_send_strategy: "shadow" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: true,
      sendUnifiedResendEmails: true,
      shadowMode: true,
    },
  },
];

// ── strategy='unified_resend' (production target) ──
const UNIFIED_MATRIX: MatrixRow[] = [
  {
    name: "unified + Bandcamp → BC connector still pushes (BC emails its own); SS does NOT email; we email",
    ctx: {
      channel: "bandcamp",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "unified_resend" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: true,
      expectMarketplaceNotify: true,
      sendUnifiedResendEmails: true,
      shadowMode: false,
      suppressShopifyEmail: false,
    },
  },
  {
    name: "unified + Squarespace direct → SS does NOT email; we email; no marketplace notify",
    ctx: {
      channel: "squarespace",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "unified_resend" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: true,
      expectMarketplaceNotify: false,
      sendUnifiedResendEmails: true,
    },
  },
  {
    name: "unified + Shopify client → SS silent, Shopify still emails (one redundant), we email",
    ctx: {
      channel: "shopify_client",
      carrier: "FedEx",
      workspaceFlags: { email_send_strategy: "unified_resend" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      suppressShopifyEmail: false, // Shopify keeps emailing per design call
      sendUnifiedResendEmails: true,
      expectMarketplaceNotify: true,
    },
  },
  {
    name: "unified + Squarespace + Asendia → still unified (no special-case)",
    ctx: {
      channel: "squarespace",
      carrier: "Asendia",
      workspaceFlags: { email_send_strategy: "unified_resend" },
    },
    expect: {
      callShipstationNotifyCustomer: false,
      sendUnifiedResendEmails: true,
    },
  },
];

// ── strategy='ss_for_all' (legacy / emergency-reverse) ──
const SS_FOR_ALL_MATRIX: MatrixRow[] = [
  {
    name: "ss_for_all + Bandcamp → SS emails (overrides BC default)",
    ctx: {
      channel: "bandcamp",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "ss_for_all" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      callShipstationNotifyOrderSource: false,
      sendUnifiedResendEmails: false,
      suppressShopifyEmail: true,
    },
  },
  {
    name: "ss_for_all + Shopify client → Shopify suppressed, SS owns email",
    ctx: {
      channel: "shopify_client",
      carrier: "USPS",
      workspaceFlags: { email_send_strategy: "ss_for_all" },
    },
    expect: {
      callShipstationNotifyCustomer: true,
      sendUnifiedResendEmails: false,
      suppressShopifyEmail: true,
    },
  },
];

describe("deriveNotificationStrategy — strategy='off' (legacy hybrid)", () => {
  it.each(OFF_MATRIX)("$name", ({ ctx, expect: expected }) => {
    const out = deriveNotificationStrategy(ctx);
    for (const [k, v] of Object.entries(expected)) {
      expect(out[k as keyof NotificationStrategy]).toBe(v);
    }
    expect(out.rationale.length).toBeGreaterThan(0);
  });
});

describe("deriveNotificationStrategy — strategy='shadow'", () => {
  it.each(SHADOW_MATRIX)("$name", ({ ctx, expect: expected }) => {
    const out = deriveNotificationStrategy(ctx);
    for (const [k, v] of Object.entries(expected)) {
      expect(out[k as keyof NotificationStrategy]).toBe(v);
    }
    expect(out.shadowMode).toBe(true);
    expect(out.sendUnifiedResendEmails).toBe(true);
  });
});

describe("deriveNotificationStrategy — strategy='unified_resend' (production target)", () => {
  it.each(UNIFIED_MATRIX)("$name", ({ ctx, expect: expected }) => {
    const out = deriveNotificationStrategy(ctx);
    for (const [k, v] of Object.entries(expected)) {
      expect(out[k as keyof NotificationStrategy]).toBe(v);
    }
    // INVARIANT: in unified mode SS NEVER emails customers.
    expect(out.callShipstationNotifyCustomer).toBe(false);
    // INVARIANT: in unified mode WE always email (or shadow-email).
    expect(out.sendUnifiedResendEmails).toBe(true);
    expect(out.shadowMode).toBe(false);
  });
});

describe("deriveNotificationStrategy — strategy='ss_for_all'", () => {
  it.each(SS_FOR_ALL_MATRIX)("$name", ({ ctx, expect: expected }) => {
    const out = deriveNotificationStrategy(ctx);
    for (const [k, v] of Object.entries(expected)) {
      expect(out[k as keyof NotificationStrategy]).toBe(v);
    }
    // INVARIANT: ss_for_all never fires unified.
    expect(out.sendUnifiedResendEmails).toBe(false);
  });
});

describe("deriveNotificationStrategy — invariants", () => {
  it("per-shipment suppress_emails wins over EVERY strategy", () => {
    for (const strategy of ["off", "shadow", "unified_resend", "ss_for_all"] as const) {
      const out = deriveNotificationStrategy({
        channel: "manual_ss",
        carrier: "USPS",
        workspaceFlags: { email_send_strategy: strategy },
        shipmentOverrides: { suppress_emails: true },
      });
      expect(out.callShipstationNotifyCustomer).toBe(false);
      expect(out.callShipstationNotifyOrderSource).toBe(false);
      expect(out.sendUnifiedResendEmails).toBe(false);
      expect(out.suppressSsEmail).toBe(true);
      expect(out.suppressShopifyEmail).toBe(true);
    }
  });

  it("default strategy (undefined) = off (safe rollback target)", () => {
    const out = deriveNotificationStrategy({
      channel: "squarespace",
      carrier: "USPS",
      workspaceFlags: {},
    });
    expect(out.sendUnifiedResendEmails).toBe(false);
    expect(out.callShipstationNotifyCustomer).toBe(true);
  });

  it("unknown strategy fails closed (no emails fired anywhere)", () => {
    const out = deriveNotificationStrategy({
      channel: "manual_ss",
      carrier: "USPS",
      // @ts-expect-error — testing fail-closed for unknown strategy
      workspaceFlags: { email_send_strategy: "completely_invalid" },
    });
    expect(out.callShipstationNotifyCustomer).toBe(false);
    expect(out.sendUnifiedResendEmails).toBe(false);
  });

  it("rationale string is always non-empty (audit logging requirement)", () => {
    for (const strategy of ["off", "shadow", "unified_resend", "ss_for_all"] as const) {
      const out = deriveNotificationStrategy({
        channel: "bandcamp",
        carrier: "USPS",
        workspaceFlags: { email_send_strategy: strategy },
      });
      expect(out.rationale.length).toBeGreaterThan(0);
    }
  });
});
