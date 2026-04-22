/**
 * HRD-30 — webhook payload PII sanitizer tests.
 *
 * Contract under test:
 *   - Strip well-known PII keys (`email`, `phone`, `first_name`, …) and
 *     PII block keys (`customer`, `billing_address`, `shipping_address`,
 *     …) by replacing with sentinel `"[REDACTED]"`.
 *   - Preserve operationally-useful keys: `id`, `inventory_item_id`,
 *     `sku`, `quantity`, `price`, `created_at`, `updated_at`,
 *     `line_items`, `name` (Shopify order number "#1042"), `order_number`.
 *   - Idempotent (sanitize twice = same as once).
 *   - Doesn't mutate the input.
 *   - Depth cap protects against deeply-nested DoS payloads.
 *   - null/undefined pass through.
 */

import { describe, expect, it } from "vitest";
import { sanitizeWebhookPayload } from "@/lib/server/webhook-body";

describe("sanitizeWebhookPayload", () => {
  // --- pass-through ---

  it("returns null unchanged", () => {
    expect(sanitizeWebhookPayload(null)).toBeNull();
  });

  it("returns undefined unchanged", () => {
    expect(sanitizeWebhookPayload(undefined)).toBeUndefined();
  });

  // --- PII redaction ---

  it("redacts the `customer` block entirely (PII block denylist)", () => {
    const out = sanitizeWebhookPayload({
      id: 1042,
      customer: { id: 99, email: "x@y.com", first_name: "Pat", last_name: "Q" },
    });
    expect(out?.customer).toBe("[REDACTED]");
    expect(out?.id).toBe(1042);
  });

  it("redacts billing_address and shipping_address blocks entirely", () => {
    const out = sanitizeWebhookPayload({
      id: 5,
      billing_address: { address1: "1 Main St", city: "NYC" },
      shipping_address: { address1: "2 Main St", zip: "10001" },
    });
    expect(out?.billing_address).toBe("[REDACTED]");
    expect(out?.shipping_address).toBe("[REDACTED]");
  });

  it("redacts top-level email/phone keys (PII key denylist)", () => {
    const out = sanitizeWebhookPayload({
      id: 5,
      email: "x@y.com",
      phone: "+1-555-0100",
      contact_email: "support@example.com",
    });
    expect(out?.email).toBe("[REDACTED]");
    expect(out?.phone).toBe("[REDACTED]");
    expect(out?.contact_email).toBe("[REDACTED]");
    expect(out?.id).toBe(5);
  });

  it("redacts client_details (browser_ip, user_agent) wherever it appears", () => {
    const out = sanitizeWebhookPayload({
      id: 1,
      client_details: { browser_ip: "1.2.3.4", browser_user_agent: "Mozilla" },
    });
    expect(out?.client_details).toBe("[REDACTED]");
  });

  it("redacts notes / note_attributes (often contain PII like 'gift to <name>')", () => {
    const out = sanitizeWebhookPayload({
      id: 1,
      note: "deliver to Pat at noon",
      note_attributes: [{ name: "gift_to", value: "Sam" }],
    });
    expect(out?.note).toBe("[REDACTED]");
    expect(out?.note_attributes).toBe("[REDACTED]");
  });

  // --- operationally-useful preservation ---

  it("preserves Shopify order's `name` field (order number '#1042', NOT customer name)", () => {
    const out = sanitizeWebhookPayload({
      id: 1042,
      name: "#1042",
      order_number: 1042,
    });
    expect(out?.name).toBe("#1042");
    expect(out?.order_number).toBe(1042);
  });

  it("preserves line_items array — sku/quantity/price are not PII", () => {
    const out = sanitizeWebhookPayload({
      id: 1,
      line_items: [
        { id: 100, sku: "TEST-A", quantity: 2, price: "9.99" },
        { id: 101, sku: "TEST-B", quantity: 1, price: "5.00" },
      ],
    }) as { line_items: Array<Record<string, unknown>> };
    expect(out.line_items).toHaveLength(2);
    expect(out.line_items[0]?.sku).toBe("TEST-A");
    expect(out.line_items[0]?.quantity).toBe(2);
    expect(out.line_items[1]?.price).toBe("5.00");
  });

  it("strips line_item.note inside preserved line_items array", () => {
    const out = sanitizeWebhookPayload({
      line_items: [{ id: 1, sku: "A", note: "gift wrap for Pat" }],
    }) as { line_items: Array<Record<string, unknown>> };
    expect(out.line_items[0]?.sku).toBe("A");
    expect(out.line_items[0]?.note).toBe("[REDACTED]");
  });

  it("preserves inventory_item_id, location_id, available (no PII)", () => {
    const out = sanitizeWebhookPayload({
      inventory_item_id: 99,
      location_id: 5,
      available: 7,
      updated_at: "2026-04-22T10:00:00Z",
    });
    expect(out).toEqual({
      inventory_item_id: 99,
      location_id: 5,
      available: 7,
      updated_at: "2026-04-22T10:00:00Z",
    });
  });

  // --- idempotency + immutability ---

  it("is idempotent: sanitize(sanitize(x)) === sanitize(x)", () => {
    const input = {
      id: 1,
      email: "x@y.com",
      customer: { email: "y@z.com" },
      line_items: [{ sku: "A", quantity: 1 }],
    };
    const once = sanitizeWebhookPayload(input);
    const twice = sanitizeWebhookPayload(once);
    expect(twice).toEqual(once);
  });

  it("does not mutate the input object", () => {
    const input = { id: 1, email: "x@y.com" };
    sanitizeWebhookPayload(input);
    expect(input.email).toBe("x@y.com");
  });

  // --- depth cap ---

  it("depth cap kicks in past 10 levels — replaces deepest object with REDACTED", () => {
    const deep: Record<string, unknown> = { v: 0 };
    let cursor: Record<string, unknown> = deep;
    for (let i = 1; i < 15; i++) {
      const next: Record<string, unknown> = { v: i };
      cursor.next = next;
      cursor = next;
    }
    const out = sanitizeWebhookPayload(deep);
    // Walk the output by `next` pointers; somewhere past depth 10 we should
    // hit a REDACTED leaf.
    let probe: unknown = out;
    let foundRedacted = false;
    for (let i = 0; i < 15; i++) {
      if (probe === "[REDACTED]") {
        foundRedacted = true;
        break;
      }
      probe = (probe as Record<string, unknown>).next;
      if (!probe) break;
    }
    expect(foundRedacted).toBe(true);
  });

  // --- realistic Shopify orders/create snapshot ---

  it("Shopify orders/create realistic shape: redacts every PII vector but keeps line items + totals", () => {
    const realistic = {
      id: 5001,
      name: "#5001",
      order_number: 5001,
      created_at: "2026-04-22T10:00:00Z",
      updated_at: "2026-04-22T10:00:00Z",
      financial_status: "paid",
      fulfillment_status: null,
      currency: "USD",
      total_price: "29.97",
      subtotal_price: "24.99",
      email: "buyer@example.com",
      phone: "+1-555-0123",
      browser_ip: "1.2.3.4",
      customer: {
        id: 7,
        email: "buyer@example.com",
        first_name: "Pat",
        last_name: "Q",
        default_address: { address1: "1 Main", city: "NYC" },
      },
      billing_address: { address1: "1 Main", city: "NYC", zip: "10001" },
      shipping_address: { address1: "2 Main", city: "NYC", zip: "10002" },
      client_details: { browser_ip: "1.2.3.4", user_agent: "Mozilla" },
      note: "leave at door",
      line_items: [
        { id: 100, sku: "TEST-A", quantity: 2, price: "9.99", title: "Test A" },
        { id: 101, sku: "TEST-B", quantity: 1, price: "5.00", title: "Test B" },
      ],
    };
    const out = sanitizeWebhookPayload(realistic) as Record<string, unknown>;

    // Operational keys preserved
    expect(out.id).toBe(5001);
    expect(out.name).toBe("#5001");
    expect(out.total_price).toBe("29.97");
    expect(out.financial_status).toBe("paid");
    expect((out.line_items as unknown[])[0]).toMatchObject({
      sku: "TEST-A",
      quantity: 2,
      price: "9.99",
      title: "Test A",
    });

    // PII redacted
    expect(out.email).toBe("[REDACTED]");
    expect(out.phone).toBe("[REDACTED]");
    expect(out.browser_ip).toBe("[REDACTED]");
    expect(out.customer).toBe("[REDACTED]");
    expect(out.billing_address).toBe("[REDACTED]");
    expect(out.shipping_address).toBe("[REDACTED]");
    expect(out.client_details).toBe("[REDACTED]");
    expect(out.note).toBe("[REDACTED]");
  });
});
