/**
 * HRD-24 — per-platform webhook freshness ceiling tests.
 *
 * Contract under test:
 *   - Per-platform absolute age ceilings (Shopify/Woo/Squarespace 72h,
 *     Stripe 168h, etc.) — set well above each platform's documented retry
 *     horizon to avoid discarding legitimate retries.
 *   - Fail-OPEN when no timestamp can be extracted (HRD-01 monotonic guard
 *     catches ordering downstream).
 *   - Reject `future_timestamp` outside a 5-minute clock-skew tolerance
 *     (defense against forged timestamps trying to win the monotonic guard
 *     race).
 */

import { describe, expect, it } from "vitest";
import { checkWebhookFreshness } from "@/lib/server/webhook-body";

const NOW = new Date("2026-04-22T12:00:00Z");

describe("checkWebhookFreshness", () => {
  it("Shopify within 72h ceiling: ok=true with ageMs", () => {
    const v = checkWebhookFreshness(
      "shopify",
      { updated_at: "2026-04-22T11:00:00Z" }, // 1h ago
      {},
      NOW,
    );
    expect(v.ok).toBe(true);
    expect(v.ageMs).toBe(60 * 60 * 1000);
    expect(v.ceilingMs).toBe(72 * 60 * 60 * 1000);
  });

  it("Shopify at 47h still ok (legitimate retry deep into Shopify's 48h horizon)", () => {
    const v = checkWebhookFreshness(
      "shopify",
      { updated_at: "2026-04-20T13:00:00Z" }, // 47h ago
      {},
      NOW,
    );
    expect(v.ok).toBe(true);
  });

  it("Shopify at 73h fails: reason='exceeds_ceiling' (past the 72h sanity ceiling)", () => {
    const v = checkWebhookFreshness(
      "shopify",
      { updated_at: "2026-04-19T11:00:00Z" }, // 73h ago
      {},
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("exceeds_ceiling");
  });

  it("Stripe at 100h still ok (Stripe ceiling is 168h)", () => {
    const v = checkWebhookFreshness(
      "stripe",
      { created_at: "2026-04-18T08:00:00Z" }, // 100h ago
      {},
      NOW,
    );
    expect(v.ok).toBe(true);
  });

  it("X-Shopify-Triggered-At header takes precedence over payload timestamp", () => {
    const v = checkWebhookFreshness(
      "shopify",
      { updated_at: "2025-01-01T00:00:00Z" /* ancient */ },
      { triggeredAt: "2026-04-22T11:30:00Z" /* 30 min ago */ },
      NOW,
    );
    expect(v.ok).toBe(true);
  });

  it("Future timestamp >5 min ahead: rejected as future_timestamp", () => {
    const v = checkWebhookFreshness(
      "shopify",
      { updated_at: "2026-04-22T12:10:00Z" }, // 10 min in the future
      {},
      NOW,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("future_timestamp");
  });

  it("Future timestamp within 5 min skew: ok (clock-skew tolerance)", () => {
    const v = checkWebhookFreshness(
      "shopify",
      { updated_at: "2026-04-22T12:03:00Z" }, // 3 min in the future
      {},
      NOW,
    );
    expect(v.ok).toBe(true);
  });

  it("Missing timestamp: fail-OPEN with reason='no_timestamp'", () => {
    const v = checkWebhookFreshness("shopify", { id: 7, foo: "bar" }, {}, NOW);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("no_timestamp");
  });

  it("Null payload + no header: fail-OPEN with reason='no_timestamp'", () => {
    const v = checkWebhookFreshness("shopify", null, {}, NOW);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("no_timestamp");
  });

  it("Invalid timestamp string: fail-OPEN as if missing", () => {
    const v = checkWebhookFreshness("shopify", { updated_at: "not-a-date" }, {}, NOW);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("no_timestamp");
  });

  it("WooCommerce date_modified_gmt: appends 'Z' for proper UTC parsing (no false-future)", () => {
    const v = checkWebhookFreshness(
      "woocommerce",
      { date_modified_gmt: "2026-04-22T11:00:00" }, // GMT, missing Z
      {},
      NOW,
    );
    expect(v.ok).toBe(true);
  });

  it("Unknown platform: applies default 72h ceiling", () => {
    const v = checkWebhookFreshness(
      "exotic-platform",
      { updated_at: "2026-04-22T11:00:00Z" },
      {},
      NOW,
    );
    expect(v.ok).toBe(true);
    expect(v.ceilingMs).toBe(72 * 60 * 60 * 1000);
  });

  it("Platform name is case-insensitive ('Shopify' === 'shopify')", () => {
    const v = checkWebhookFreshness("Shopify", { updated_at: "2026-04-22T11:00:00Z" }, {}, NOW);
    expect(v.ok).toBe(true);
    expect(v.ceilingMs).toBe(72 * 60 * 60 * 1000);
  });
});
