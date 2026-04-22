/**
 * HRD-26 — lazy Shopify inventoryActivate retry path.
 *
 * Verifies that when `inventory_levels/set.json` returns the platform-specific
 * "inventory item is not stocked at this location" error, the Shopify sync
 * client lazily calls `inventory_levels/connect.json` (the REST analogue of
 * the GraphQL `inventoryActivate` mutation), writes an `inventory_activate`
 * audit row, and retries the original set call exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStoreSyncClient,
  extractNumericShopifyLocationId,
  isInventoryNotActiveAtLocationError,
} from "@/lib/clients/store-sync-client";
import type { ClientStoreConnection } from "@/lib/shared/types";

const insertSpy = vi.fn();

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: () => ({ insert: insertSpy }),
  }),
}));

function makeShopifyConnection(
  overrides: Partial<ClientStoreConnection> = {},
): ClientStoreConnection {
  return {
    id: "conn-shopify-1",
    workspace_id: "ws-1",
    org_id: "org-1",
    platform: "shopify",
    store_url: "https://test-shop.myshopify.com",
    api_key: "shpat_test_token",
    api_secret: null,
    webhook_url: null,
    webhook_secret: null,
    connection_status: "active",
    last_webhook_at: null,
    last_poll_at: null,
    last_error_at: null,
    last_error: null,
    do_not_fanout: false,
    default_location_id: "gid://shopify/Location/987654321",
    shopify_app_client_id: null,
    shopify_app_client_secret_encrypted: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

type FetchResp = { ok: boolean; status?: number; bodyJson?: unknown; bodyText?: string };

function mockFetchSequence(responses: FetchResp[]) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const resp = responses[i++];
    if (!resp) throw new Error(`unexpected extra fetch call (i=${i})`);
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 422),
      json: async () => resp.bodyJson ?? {},
      text: async () => resp.bodyText ?? JSON.stringify(resp.bodyJson ?? {}),
    } as unknown as Response;
  });
}

describe("HRD-26 — extractNumericShopifyLocationId", () => {
  it("parses a Shopify GID into the numeric tail", () => {
    expect(extractNumericShopifyLocationId("gid://shopify/Location/987654321")).toBe(987654321);
  });
  it("passes through a bare numeric string", () => {
    expect(extractNumericShopifyLocationId("12345")).toBe(12345);
  });
  it("returns null for null/undefined/empty", () => {
    expect(extractNumericShopifyLocationId(null)).toBeNull();
    expect(extractNumericShopifyLocationId(undefined)).toBeNull();
    expect(extractNumericShopifyLocationId("")).toBeNull();
  });
  it("returns null for non-numeric input", () => {
    expect(extractNumericShopifyLocationId("not-a-location")).toBeNull();
    expect(extractNumericShopifyLocationId("gid://shopify/Location/")).toBeNull();
  });
});

describe("HRD-26 — isInventoryNotActiveAtLocationError", () => {
  const SAMPLES_MATCH = [
    "Inventory item is not stocked at this location",
    "inventory_item not connected to location",
    "Inventory item does not have inventory tracked at the location",
    "Location not active for this inventory item",
    "Inventory not stocked at the destination location",
  ];

  it.each(SAMPLES_MATCH)("recognizes 422 + %s as an activation-needed error", (msg) => {
    expect(isInventoryNotActiveAtLocationError(422, msg)).toBe(true);
  });

  it("rejects non-422 status codes even with matching wording", () => {
    expect(isInventoryNotActiveAtLocationError(500, "Inventory item is not stocked")).toBe(false);
    expect(isInventoryNotActiveAtLocationError(404, "location not active")).toBe(false);
  });

  it("rejects unrelated 422 errors", () => {
    expect(isInventoryNotActiveAtLocationError(422, "SKU is invalid")).toBe(false);
    expect(isInventoryNotActiveAtLocationError(422, "Quantity must be positive")).toBe(false);
  });
});

describe("HRD-26 — Shopify pushInventory lazy activate retry", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    insertSpy.mockReset();
    insertSpy.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path: set.json succeeds on the first try, no connect.json call, no audit row", async () => {
    const fetchMock = mockFetchSequence([
      // 1) findVariantBySku
      {
        ok: true,
        bodyJson: { variants: [{ id: 111, inventory_item_id: 999, sku: "SKU-A" }] },
      },
      // 2) set.json — succeeds
      { ok: true, bodyJson: {} },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createStoreSyncClient(makeShopifyConnection());
    await client.pushInventory("SKU-A", 42, "key-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(insertSpy).not.toHaveBeenCalled();

    const calls = fetchMock.mock.calls;
    expect(calls[1]?.[0]).toContain("/inventory_levels/set.json");
    const setBody = JSON.parse(String((calls[1]?.[1] as RequestInit).body));
    expect(setBody.location_id).toBe(987654321); // numeric tail of default GID
    expect(setBody.inventory_item_id).toBe(999);
    expect(setBody.available).toBe(42);
  });

  it("set.json 422 with 'not stocked' → calls connect.json + writes audit row + retries set.json once", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, bodyJson: { variants: [{ id: 111, inventory_item_id: 999, sku: "SKU-A" }] } },
      {
        ok: false,
        status: 422,
        bodyText: '{"errors":["Inventory item is not stocked at this location"]}',
      },
      { ok: true, bodyJson: {} }, // connect.json succeeds
      { ok: true, bodyJson: {} }, // set.json retry succeeds
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createStoreSyncClient(makeShopifyConnection());
    await client.pushInventory("SKU-A", 7, "key-2");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/variants.json");
    expect(urls[1]).toContain("/inventory_levels/set.json");
    expect(urls[2]).toContain("/inventory_levels/connect.json");
    expect(urls[3]).toContain("/inventory_levels/set.json");

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const insertedRow = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.workspace_id).toBe("ws-1");
    expect(insertedRow.sku).toBe("SKU-A");
    expect(insertedRow.delta).toBe(0);
    expect(insertedRow.source).toBe("inventory_activate");
    expect(typeof insertedRow.correlation_id).toBe("string");
    expect(String(insertedRow.correlation_id)).toMatch(/^inv-activate:conn-shopify-1:/);
    const meta = insertedRow.metadata as Record<string, unknown>;
    expect(meta.connection_id).toBe("conn-shopify-1");
    expect(meta.shopify_inventory_item_id).toBe("999");
    expect(meta.shopify_location_id).toBe("987654321");
  });

  it("set.json 422 with unrelated error → does NOT call connect.json + throws", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, bodyJson: { variants: [{ id: 111, inventory_item_id: 999, sku: "SKU-A" }] } },
      { ok: false, status: 422, bodyText: '{"errors":["SKU is invalid"]}' },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createStoreSyncClient(makeShopifyConnection());
    await expect(client.pushInventory("SKU-A", 7, "key-3")).rejects.toThrow(
      /Shopify inventory set failed: HTTP 422/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("connect.json itself fails → throws aggregate error, no retry", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, bodyJson: { variants: [{ id: 111, inventory_item_id: 999, sku: "SKU-A" }] } },
      {
        ok: false,
        status: 422,
        bodyText: '{"errors":["Inventory item is not stocked at this location"]}',
      },
      { ok: false, status: 500, bodyText: '{"errors":["internal"]}' }, // connect.json fails
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createStoreSyncClient(makeShopifyConnection());
    await expect(client.pushInventory("SKU-A", 7, "key-4")).rejects.toThrow(
      /inventoryActivate also failed/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("retry-after-activate set.json fails → throws retry-failed error", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, bodyJson: { variants: [{ id: 111, inventory_item_id: 999, sku: "SKU-A" }] } },
      {
        ok: false,
        status: 422,
        bodyText: '{"errors":["Inventory item is not stocked at this location"]}',
      },
      { ok: true, bodyJson: {} }, // connect.json succeeds
      { ok: false, status: 500, bodyText: '{"errors":["internal on retry"]}' },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createStoreSyncClient(makeShopifyConnection());
    await expect(client.pushInventory("SKU-A", 7, "key-5")).rejects.toThrow(
      /retry-after-activate failed/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(insertSpy).toHaveBeenCalledTimes(1); // audit row still written for the successful activate step
  });

  it("falls back to current-location lookup when default_location_id is null (preserves pre-cutover behavior)", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, bodyJson: { variants: [{ id: 111, inventory_item_id: 999, sku: "SKU-A" }] } },
      {
        ok: true,
        bodyJson: { inventory_levels: [{ location_id: 555, available: 10 }] },
      },
      { ok: true, bodyJson: {} },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createStoreSyncClient(makeShopifyConnection({ default_location_id: null }));
    await client.pushInventory("SKU-A", 11, "key-6");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toContain("/inventory_levels.json?inventory_item_ids=999");
    const setBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body));
    expect(setBody.location_id).toBe(555);
    expect(setBody.available).toBe(11);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
