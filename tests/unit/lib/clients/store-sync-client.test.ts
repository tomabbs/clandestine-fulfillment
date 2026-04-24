import { describe, expect, it } from "vitest";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import type { ClientStoreConnection } from "@/lib/shared/types";

function makeConnection(overrides: Partial<ClientStoreConnection> = {}): ClientStoreConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    org_id: "org-1",
    platform: "squarespace",
    store_url: "https://store.squarespace.com",
    api_key: "test-key",
    api_secret: null,
    webhook_url: null,
    webhook_secret: null,
    connection_status: "active",
    last_webhook_at: null,
    last_poll_at: null,
    last_error_at: null,
    last_error: null,
    do_not_fanout: false,
    default_location_id: null,
    shopify_app_client_id: null,
    shopify_app_client_secret_encrypted: null,
    cutover_state: "legacy",
    cutover_started_at: null,
    cutover_completed_at: null,
    shadow_mode_log_id: null,
    shadow_window_tolerance_seconds: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("store-sync-client factory", () => {
  describe("createStoreSyncClient", () => {
    it("returns a client for squarespace platform", () => {
      const client = createStoreSyncClient(makeConnection({ platform: "squarespace" }));
      expect(client).toBeDefined();
      expect(client.pushInventory).toBeTypeOf("function");
      expect(client.getRemoteQuantity).toBeTypeOf("function");
      expect(client.getOrders).toBeTypeOf("function");
    });

    it("returns a client for woocommerce platform", () => {
      const client = createStoreSyncClient(
        makeConnection({
          platform: "woocommerce",
          api_key: "ck_test",
          api_secret: "cs_test",
        }),
      );
      expect(client).toBeDefined();
      expect(client.pushInventory).toBeTypeOf("function");
    });

    it("returns a client for shopify platform", () => {
      const client = createStoreSyncClient(makeConnection({ platform: "shopify" }));
      expect(client).toBeDefined();
    });

    it("throws for bigcommerce (not yet implemented)", () => {
      expect(() => createStoreSyncClient(makeConnection({ platform: "bigcommerce" }))).toThrow(
        "BigCommerce sync not yet implemented",
      );
    });

    it("throws for unknown platform", () => {
      expect(() => createStoreSyncClient(makeConnection({ platform: "etsy" as never }))).toThrow(
        "Unsupported platform",
      );
    });

    it("throws when squarespace connection missing api_key", () => {
      expect(() =>
        createStoreSyncClient(makeConnection({ platform: "squarespace", api_key: null })),
      ).toThrow("Squarespace connection missing api_key");
    });

    it("throws when woocommerce connection missing api_key or api_secret", () => {
      expect(() =>
        createStoreSyncClient(
          makeConnection({ platform: "woocommerce", api_key: null, api_secret: null }),
        ),
      ).toThrow("WooCommerce connection missing api_key or api_secret");

      expect(() =>
        createStoreSyncClient(
          makeConnection({ platform: "woocommerce", api_key: "ck", api_secret: null }),
        ),
      ).toThrow("WooCommerce connection missing api_key or api_secret");
    });

    it("shopify client methods are callable (real implementation)", async () => {
      const client = createStoreSyncClient(makeConnection({ platform: "shopify" }));
      expect(typeof client.pushInventory).toBe("function");
      expect(typeof client.getRemoteQuantity).toBe("function");
      expect(typeof client.getOrders).toBe("function");
    });
  });
});
