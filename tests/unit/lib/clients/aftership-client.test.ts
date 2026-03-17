import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    AFTERSHIP_API_KEY: "test-aftership-key",
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

type AfterShipModule = typeof import("@/lib/clients/aftership-client");
let createTracking: AfterShipModule["createTracking"];
let getTracking: AfterShipModule["getTracking"];
let normalizeCarrierSlug: AfterShipModule["normalizeCarrierSlug"];

beforeAll(async () => {
  const mod = await import("@/lib/clients/aftership-client");
  createTracking = mod.createTracking;
  getTracking = mod.getTracking;
  normalizeCarrierSlug = mod.normalizeCarrierSlug;
});

describe("aftership-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTracking", () => {
    it("sends correct request to AfterShip API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            tracking: {
              id: "track-1",
              tracking_number: "9400111111",
              slug: "usps",
              checkpoints: [],
            },
          },
        }),
      });

      await createTracking("9400111111", "USPS", { orderId: "order-1" });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.aftership.com/v4/trackings");
      expect(options.method).toBe("POST");
      expect(options.headers["aftership-api-key"]).toBe("test-aftership-key");

      const body = JSON.parse(options.body);
      expect(body.tracking.tracking_number).toBe("9400111111");
      expect(body.tracking.slug).toBe("usps");
      expect(body.tracking.order_id).toBe("order-1");
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"meta":{"code":4003,"message":"Tracking already exists"}}',
      });

      await expect(createTracking("9400111111", "USPS")).rejects.toThrow("AfterShip API 400");
    });
  });

  describe("getTracking", () => {
    it("fetches tracking by slug and number", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            tracking: {
              id: "track-1",
              tracking_number: "9400111111",
              slug: "usps",
              tag: "InTransit",
              checkpoints: [
                {
                  tag: "InTransit",
                  message: "In transit",
                  checkpoint_time: "2026-03-15T10:00:00Z",
                },
              ],
            },
          },
        }),
      });

      const result = await getTracking("9400111111", "USPS");
      expect(result.tracking_number).toBe("9400111111");
      expect(result.checkpoints).toHaveLength(1);
      expect(result.checkpoints[0].tag).toBe("InTransit");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.aftership.com/v4/trackings/usps/9400111111");
    });
  });

  describe("normalizeCarrierSlug", () => {
    it("normalizes common carrier names", () => {
      expect(normalizeCarrierSlug("USPS")).toBe("usps");
      expect(normalizeCarrierSlug("UPS")).toBe("ups");
      expect(normalizeCarrierSlug("FedEx")).toBe("fedex");
      expect(normalizeCarrierSlug("DHL")).toBe("dhl");
      expect(normalizeCarrierSlug("DHL Express")).toBe("dhl");
      expect(normalizeCarrierSlug("Pirate Ship")).toBe("usps");
      expect(normalizeCarrierSlug("pirateship")).toBe("usps");
    });

    it("passes through unknown carriers as lowercase", () => {
      expect(normalizeCarrierSlug("SomeCarrier")).toBe("somecarrier");
    });
  });
});
