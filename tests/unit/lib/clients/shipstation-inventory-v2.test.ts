import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: vi.fn<() => { SHIPSTATION_V2_API_KEY?: string }>(() => ({
    SHIPSTATION_V2_API_KEY: "test_v2_key",
  })),
}));

vi.mock("@/lib/shared/env", () => ({
  env: mockEnv,
}));

import {
  adjustInventoryV2,
  createInventoryLocation,
  deleteInventoryLocation,
  listInventory,
  updateInventoryLocation,
  V2_INVENTORY_LIST_BATCH_LIMIT,
} from "@/lib/clients/shipstation-inventory-v2";

/**
 * Phase 2 contract tests for the batch-only ShipStation v2 inventory client.
 *
 * Plan §7.1.6: the module exports ONLY batch helpers. There is no
 * `getInventoryBySku` convenience helper. We assert:
 *   - `listInventory({ skus: [...] })` chunks into V2_INVENTORY_LIST_BATCH_LIMIT
 *     groups when the batch is larger than the limit (no single huge URL).
 *   - `adjustInventoryV2` enforces the Phase 0 Patch D2 decisions:
 *       * `decrement quantity: 0` rejected client-side
 *       * `modify new_available: 0` rejected client-side
 *       * `adjust quantity: 0` accepted (asymmetry vs seed)
 *   - The CI lint guard `scripts/check-v2-inventory-batch.sh` is the second
 *     line of defence; this test ensures the runtime client agrees.
 */

beforeEach(() => {
  mockEnv.mockReturnValue({ SHIPSTATION_V2_API_KEY: "test_v2_key" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listInventory (batch-only)", () => {
  it("issues a single GET when batch is within the limit", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ inventory: [{ sku: "A", on_hand: 5, allocated: 0, available: 5 }] }),
          { status: 200 },
        ),
      );

    const result = await listInventory({ skus: ["A", "B", "C"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v2/inventory");
    expect(url).toMatch(/sku=A%2CB%2CC|sku=A,B,C/);
    expect(result).toHaveLength(1);
  });

  it("chunks batches that exceed V2_INVENTORY_LIST_BATCH_LIMIT", async () => {
    const skus = Array.from(
      { length: V2_INVENTORY_LIST_BATCH_LIMIT * 2 + 3 },
      (_, i) => `SKU-${i}`,
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify({ inventory: [] }), { status: 200 }),
      );

    await listInventory({ skus });

    // Expect ceil(skus.length / batch limit) calls — three chunks for 103 SKUs at 50/batch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends api-key header and not Basic auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ inventory: [] }), { status: 200 }));
    await listInventory({ skus: ["A"] });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["api-key"]).toBe("test_v2_key");
    expect(JSON.stringify(headers)).not.toContain("Basic");
  });

  it("paginates via cursor when no SKUs are passed (full enumeration)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inventory: [{ sku: "A", on_hand: 1, allocated: 0, available: 1 }],
            links: { next: { href: "/v2/inventory?cursor=PAGE2" } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inventory: [{ sku: "B", on_hand: 2, allocated: 0, available: 2 }],
            links: { next: null },
          }),
          { status: 200 },
        ),
      );

    const result = await listInventory();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.sku)).toEqual(["A", "B"]);
  });

  it("throws when SHIPSTATION_V2_API_KEY is missing", async () => {
    mockEnv.mockReturnValueOnce({ SHIPSTATION_V2_API_KEY: undefined });
    await expect(listInventory({ skus: ["A"] })).rejects.toThrow(
      /SHIPSTATION_V2_API_KEY is not configured/,
    );
  });
});

describe("adjustInventoryV2 — Patch D2 boundary contract", () => {
  function args(overrides: Record<string, unknown>) {
    return {
      sku: "PROBE-1",
      inventory_warehouse_id: "wh-1",
      inventory_location_id: "loc-1",
      reason: "test",
      ...overrides,
    } as Parameters<typeof adjustInventoryV2>[0];
  }

  it("rejects decrement quantity: 0 client-side", async () => {
    await expect(
      adjustInventoryV2(args({ transaction_type: "decrement", quantity: 0 })),
    ).rejects.toThrow(/quantity 0 < 1/);
  });

  it("rejects increment quantity: 0 client-side", async () => {
    await expect(
      adjustInventoryV2(args({ transaction_type: "increment", quantity: 0 })),
    ).rejects.toThrow(/quantity 0 < 1/);
  });

  it("rejects modify new_available: 0 client-side", async () => {
    await expect(
      adjustInventoryV2(args({ transaction_type: "modify", new_available: 0 })),
    ).rejects.toThrow(/cannot zero a SKU via modify/);
  });

  it("rejects modify without new_available", async () => {
    await expect(adjustInventoryV2(args({ transaction_type: "modify" }))).rejects.toThrow(
      /modify requires new_available/,
    );
  });

  it("accepts adjust quantity: 0 (Patch D2 asymmetry — proven safety net)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await adjustInventoryV2(args({ transaction_type: "adjust", quantity: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.transaction_type).toBe("adjust");
    expect(body.quantity).toBe(0);
  });

  it("accepts decrement quantity: N (>= 1) — natural delta path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await adjustInventoryV2(args({ transaction_type: "decrement", quantity: 3 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.transaction_type).toBe("decrement");
    expect(body.quantity).toBe(3);
  });

  it("includes optional fields in the POST body when provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await adjustInventoryV2(
      args({
        transaction_type: "increment",
        quantity: 5,
        cost: { amount: 10, currency: "USD" },
        condition: "sellable",
        notes: "phase-2-test",
        effective_at: "2026-04-13T00:00:00Z",
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.cost).toEqual({ amount: 10, currency: "USD" });
    expect(body.condition).toBe("sellable");
    expect(body.notes).toBe("phase-2-test");
    expect(body.effective_at).toBe("2026-04-13T00:00:00Z");
  });

  it("rejects negative quantity", async () => {
    await expect(
      adjustInventoryV2(args({ transaction_type: "adjust", quantity: -1 })),
    ).rejects.toThrow(/negative quantity/);
  });
});

// ─── Saturday Workstream 3 — location mutations (Plan §C.11) ────────────────

describe("createInventoryLocation", () => {
  it("POSTs to /v2/inventory_locations and returns the new ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          inventory_location_id: "loc_abc123",
          inventory_warehouse_id: "wh_zzz",
          name: "A-12-3",
        }),
        { status: 200 },
      ),
    );
    const result = await createInventoryLocation({
      inventory_warehouse_id: "wh_zzz",
      name: "A-12-3",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v2/inventory_locations");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ inventory_warehouse_id: "wh_zzz", name: "A-12-3" });
    expect(result.inventory_location_id).toBe("loc_abc123");
    expect(result.name).toBe("A-12-3");
  });

  it("falls back to legacy field name `location_id` when v2 omits the new key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ location_id: "legacy_id", name: "B-1" }), { status: 200 }),
    );
    const result = await createInventoryLocation({
      inventory_warehouse_id: "wh_zzz",
      name: "B-1",
    });
    expect(result.inventory_location_id).toBe("legacy_id");
    expect(result.inventory_warehouse_id).toBe("wh_zzz"); // echoed from the request
  });

  it("propagates 4xx from ShipStation as an Error (caller resolves 409 via list lookup)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("conflict: name in use", { status: 409 }),
    );
    await expect(
      createInventoryLocation({ inventory_warehouse_id: "wh_zzz", name: "dup" }),
    ).rejects.toThrow(/409/);
  });
});

describe("updateInventoryLocation", () => {
  it("PUTs to /v2/inventory_locations/{id} with rename body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          inventory_location_id: "loc_abc",
          inventory_warehouse_id: "wh_zzz",
          name: "A-12-3-renamed",
        }),
        { status: 200 },
      ),
    );
    const result = await updateInventoryLocation("loc_abc", { name: "A-12-3-renamed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v2/inventory_locations/loc_abc");
    expect((init as RequestInit).method).toBe("PUT");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ name: "A-12-3-renamed" });
    expect(result.name).toBe("A-12-3-renamed");
  });

  it("propagates 5xx so caller can leave local row unchanged (v4 hardening)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream error", { status: 502 }),
    );
    await expect(updateInventoryLocation("loc_abc", { name: "anything" })).rejects.toThrow(/502/);
  });
});

describe("deleteInventoryLocation", () => {
  it("DELETEs to /v2/inventory_locations/{id}", async () => {
    // ShipStation typically returns an empty JSON body on success for this
    // endpoint; the helper discards the body either way.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await deleteInventoryLocation("loc_abc");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v2/inventory_locations/loc_abc");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
