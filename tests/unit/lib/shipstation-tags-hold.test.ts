// Phase 8.5 + 8.6 — v1 SS client: tag + hold helpers tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    SHIPSTATION_API_KEY: "test-key",
    SHIPSTATION_API_SECRET: "test-secret",
    SHIPSTATION_V2_API_KEY: "v2-test-key",
  }),
}));

import {
  _resetListCarriersCache,
  _resetListTagsCache,
  addOrderTag,
  holdOrderUntil,
  listTags,
  removeOrderTag,
  restoreOrderFromHold,
} from "@/lib/clients/shipstation";

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  _resetListTagsCache();
  _resetListCarriersCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const fetchOk = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

describe("addOrderTag / removeOrderTag (Phase 8.5)", () => {
  it("POSTs orderId + tagId to /orders/addtag and parses response", async () => {
    fetchMock.mockResolvedValueOnce(fetchOk({ success: true, message: "Tag applied" }));
    const r = await addOrderTag(9001, 12345);
    expect(r.success).toBe(true);
    const callUrl = fetchMock.mock.calls[0]?.[0] as string;
    const callBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(callUrl).toContain("/orders/addtag");
    expect(callBody).toEqual({ orderId: 9001, tagId: 12345 });
  });

  it("POSTs orderId + tagId to /orders/removetag", async () => {
    fetchMock.mockResolvedValueOnce(fetchOk({ success: true }));
    const r = await removeOrderTag(9001, 12345);
    expect(r.success).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/orders/removetag");
  });
});

describe("listTags (Phase 8.5) — 1h cache", () => {
  it("calls /accounts/listtags and caches the result for 1h", async () => {
    fetchMock.mockResolvedValueOnce(
      fetchOk([
        { tagId: 1, name: "Gift", color: "#FF0000" },
        { tagId: 2, name: "Rush", color: null },
      ]),
    );

    const first = await listTags();
    const second = await listTags();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });

  it("force=true bypasses cache", async () => {
    fetchMock.mockResolvedValueOnce(fetchOk([{ tagId: 1, name: "Gift" }]));
    fetchMock.mockResolvedValueOnce(fetchOk([{ tagId: 1, name: "Gift" }]));
    await listTags();
    await listTags({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("holdOrderUntil / restoreOrderFromHold (Phase 8.6)", () => {
  it("POSTs orderId + holdUntilDate to /orders/holduntil", async () => {
    fetchMock.mockResolvedValueOnce(fetchOk({ success: true }));
    const r = await holdOrderUntil(9001, "2026-05-01");
    expect(r.success).toBe(true);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({ orderId: 9001, holdUntilDate: "2026-05-01" });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/orders/holduntil");
  });

  it("POSTs orderId to /orders/restorefromhold", async () => {
    fetchMock.mockResolvedValueOnce(fetchOk({ success: true }));
    await restoreOrderFromHold(9001);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/orders/restorefromhold");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({ orderId: 9001 });
  });
});
