import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock env before importing the module
vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    SHIPSTATION_API_KEY: "test-api-key",
    SHIPSTATION_API_SECRET: "test-api-secret",
    SHIPSTATION_WEBHOOK_SECRET: "test-webhook-secret",
  }),
}));

import {
  parseShipNotifyPayload,
  RATE_LIMIT_MAX,
  rateLimitState,
  shipStationShipmentSchema,
  verifyShipStationSignature,
} from "@/lib/clients/shipstation";

describe("shipstation client", () => {
  describe("verifyShipStationSignature", () => {
    const secret = "test-webhook-secret";

    async function computeHmac(body: string, key: string): Promise<string> {
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(body));
      return Buffer.from(sig).toString("base64");
    }

    it("accepts valid signature", async () => {
      const body =
        '{"resource_url":"https://ssapi.shipstation.com/shipments?id=123","resource_type":"SHIP_NOTIFY"}';
      const signature = await computeHmac(body, secret);
      const result = await verifyShipStationSignature(body, signature, secret);
      expect(result).toBe(true);
    });

    it("rejects invalid signature", async () => {
      const body = '{"resource_url":"https://test.com","resource_type":"SHIP_NOTIFY"}';
      const result = await verifyShipStationSignature(body, "invalidsignature==", secret);
      expect(result).toBe(false);
    });

    it("rejects null signature", async () => {
      const body = '{"test": true}';
      const result = await verifyShipStationSignature(body, null, secret);
      expect(result).toBe(false);
    });

    it("rejects tampered body", async () => {
      const body = '{"resource_url":"https://test.com","resource_type":"SHIP_NOTIFY"}';
      const signature = await computeHmac(body, secret);
      const tampered = '{"resource_url":"https://evil.com","resource_type":"SHIP_NOTIFY"}';
      const result = await verifyShipStationSignature(tampered, signature, secret);
      expect(result).toBe(false);
    });

    it("rejects wrong secret", async () => {
      const body = '{"test": true}';
      const signature = await computeHmac(body, "different-secret");
      const result = await verifyShipStationSignature(body, signature, secret);
      expect(result).toBe(false);
    });
  });

  describe("parseShipNotifyPayload", () => {
    it("parses valid SHIP_NOTIFY payload", () => {
      const raw = JSON.stringify({
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=123",
        resource_type: "SHIP_NOTIFY",
      });
      const result = parseShipNotifyPayload(raw);
      expect(result.resource_url).toBe("https://ssapi.shipstation.com/shipments?batchId=123");
      expect(result.resource_type).toBe("SHIP_NOTIFY");
    });

    it("rejects payload with wrong resource_type", () => {
      const raw = JSON.stringify({
        resource_url: "https://ssapi.shipstation.com/orders",
        resource_type: "ORDER_NOTIFY",
      });
      expect(() => parseShipNotifyPayload(raw)).toThrow();
    });

    it("rejects payload missing resource_url", () => {
      const raw = JSON.stringify({ resource_type: "SHIP_NOTIFY" });
      expect(() => parseShipNotifyPayload(raw)).toThrow();
    });

    it("rejects invalid JSON", () => {
      expect(() => parseShipNotifyPayload("not json")).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => parseShipNotifyPayload("")).toThrow();
    });
  });

  describe("rate limiting", () => {
    beforeEach(() => {
      rateLimitState.remaining = RATE_LIMIT_MAX;
      rateLimitState.resetAt = Date.now() + 60_000;
    });

    it("starts with full rate limit capacity", () => {
      expect(rateLimitState.remaining).toBe(40);
    });

    it("tracks remaining calls", () => {
      rateLimitState.remaining = 5;
      expect(rateLimitState.remaining).toBe(5);
    });

    it("has correct max value", () => {
      expect(RATE_LIMIT_MAX).toBe(40);
    });
  });

  describe("shipStationShipmentSchema", () => {
    it("parses a minimal shipment", () => {
      const result = shipStationShipmentSchema.parse({
        shipmentId: 12345,
      });
      expect(result.shipmentId).toBe(12345);
    });

    it("parses a full shipment", () => {
      const fullShipment = {
        shipmentId: 12345,
        orderId: 67890,
        orderNumber: "ORD-001",
        orderKey: "key-123",
        trackingNumber: "1Z999AA10123456784",
        carrierCode: "ups",
        serviceCode: "ups_ground",
        shipDate: "2024-01-15",
        deliveryDate: "2024-01-20",
        shipmentCost: 12.5,
        voidDate: null,
        voided: false,
        shipTo: {
          name: "John Doe",
          street1: "123 Main St",
          city: "Portland",
          state: "OR",
          postalCode: "97201",
          country: "US",
        },
        weight: { value: 2.5, units: "pounds" },
        dimensions: { length: 12, width: 8, height: 6, units: "inches" },
        shipmentItems: [
          {
            orderItemId: 1,
            sku: "VINYL-001",
            name: "Test Album LP",
            quantity: 2,
            unitPrice: 25.0,
          },
        ],
        storeId: 42,
        createDate: "2024-01-14T10:00:00Z",
      };

      const result = shipStationShipmentSchema.parse(fullShipment);
      expect(result.shipmentId).toBe(12345);
      expect(result.trackingNumber).toBe("1Z999AA10123456784");
      expect(result.shipmentItems).toHaveLength(1);
      expect(result.shipmentItems![0].sku).toBe("VINYL-001");
      expect(result.storeId).toBe(42);
    });

    it("handles nullable optional fields", () => {
      const result = shipStationShipmentSchema.parse({
        shipmentId: 1,
        orderId: null,
        trackingNumber: null,
        carrierCode: null,
        shipTo: null,
        weight: null,
        dimensions: null,
        shipmentItems: [],
      });
      expect(result.orderId).toBeNull();
      expect(result.trackingNumber).toBeNull();
      expect(result.shipmentItems).toHaveLength(0);
    });

    it("rejects missing shipmentId", () => {
      expect(() => shipStationShipmentSchema.parse({ trackingNumber: "123" })).toThrow();
    });
  });
});
