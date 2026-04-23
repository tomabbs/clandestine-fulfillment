/**
 * Phase 1 §9.2 D5 — `setShopifyInventoryCas` (CAS hot-path retry loop) tests.
 *
 * Pins:
 *   1. Happy path on attempt 1 — base idempotency key, NO `:retry` suffix,
 *      single readShopifyAvailable call, ledger marked success with
 *      attempts[1].outcome='success'.
 *   2. Mismatch on attempt 1, success on attempt 2 — second attempt uses
 *      `:retry1` suffix; computeDesired called twice; backoff[0]=50ms
 *      slept once.
 *   3. Mismatch on attempts 1+2, success on attempt 3 — uses `:retry1`
 *      then `:retry2`; backoff[0]+backoff[1] slept (50+150).
 *   4. All 3 attempts mismatch — returns ok:false reason:'exhausted',
 *      ledger marked error with attempts[].length===3, review queue
 *      upsert called with category='cas_exhausted',
 *      severity='medium', group_key shape, occurrence_count=1.
 *      NO sleep after the last attempt.
 *   5. Non-CAS GraphQL error throws AND ledger gets marked error with
 *      partial attempts[].
 *   6. computeDesired is called with the freshly-read remoteAvailable
 *      each attempt (so a sale between attempts shifts the desired
 *      value with the truth).
 *   7. CAS_RETRY_BACKOFF_MS schedule is exactly [50, 150, 400].
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockShopifyGraphQL, mockConnectionShopifyGraphQL, mockSetShopifyInventoryWithCompare } =
  vi.hoisted(() => ({
    mockShopifyGraphQL: vi.fn(),
    mockConnectionShopifyGraphQL: vi.fn(),
    mockSetShopifyInventoryWithCompare: vi.fn(),
  }));

vi.mock("@/lib/clients/shopify-client", () => ({
  shopifyGraphQL: mockShopifyGraphQL,
}));

vi.mock("@/lib/server/shopify-connection-graphql", () => ({
  connectionShopifyGraphQL: mockConnectionShopifyGraphQL,
}));

vi.mock("@/lib/clients/shopify-cas", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clients/shopify-cas")>(
    "@/lib/clients/shopify-cas",
  );
  return {
    ...actual,
    setShopifyInventoryWithCompare: mockSetShopifyInventoryWithCompare,
  };
});

vi.mock("@trigger.dev/sdk", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  CAS_DEFAULT_MAX_ATTEMPTS,
  CAS_RETRY_BACKOFF_MS,
  setShopifyInventoryCas,
} from "@/lib/server/shopify-cas-retry";

function buildAvailableResponse(quantity: number) {
  return {
    inventoryItem: {
      inventoryLevel: {
        quantities: [{ name: "available", quantity }],
      },
    },
  };
}

function buildSupabase(): {
  client: {
    from: ReturnType<typeof vi.fn>;
  };
  syncUpdate: ReturnType<typeof vi.fn>;
  reviewUpsert: ReturnType<typeof vi.fn>;
} {
  const syncUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  });
  const reviewUpsert = vi.fn().mockResolvedValue({ data: null, error: null });

  const from = vi.fn((table: string) => {
    if (table === "external_sync_events") {
      return { update: syncUpdate };
    }
    if (table === "warehouse_review_queue") {
      return { upsert: reviewUpsert };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return {
    client: { from },
    syncUpdate,
    reviewUpsert,
  };
}

function buildBaseParams(overrides?: Partial<Parameters<typeof setShopifyInventoryCas>[0]>) {
  const sb = buildSupabase();
  return {
    sb,
    params: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal Supabase test double
      supabase: sb.client as any,
      transport: { kind: "env_singleton" } as const,
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/1",
      workspaceId: "ws-1",
      orgId: "org-1",
      sku: "SKU-1",
      correlationId: "corr-1",
      system: "clandestine_shopify" as const,
      ledgerId: "ledger-1",
      computeDesired: vi.fn().mockResolvedValue(7),
      sleep: vi.fn().mockResolvedValue(undefined),
      ...(overrides ?? {}),
    },
  };
}

describe("CAS_RETRY_BACKOFF_MS", () => {
  it("is exactly [50, 150, 400]", () => {
    // Pins the schedule — changing this is a behavior change that must
    // be reflected in the plan §9.2 D5 outcome block.
    expect([...CAS_RETRY_BACKOFF_MS]).toEqual([50, 150, 400]);
  });

  it("default max attempts is 3", () => {
    expect(CAS_DEFAULT_MAX_ATTEMPTS).toBe(3);
  });
});

describe("setShopifyInventoryCas — happy path on first attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true with adjustmentGroupId after one CAS call", async () => {
    const { params, sb } = buildBaseParams();
    mockShopifyGraphQL.mockResolvedValueOnce(buildAvailableResponse(2));
    mockSetShopifyInventoryWithCompare.mockResolvedValueOnce({
      ok: true,
      newQuantity: 7,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/abc",
    });

    const result = await setShopifyInventoryCas(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finalNewQuantity).toBe(7);
    expect(result.adjustmentGroupId).toBe("gid://shopify/InventoryAdjustmentGroup/abc");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].outcome).toBe("success");
    expect(result.attempts[0].attempt).toBe(1);
    expect(result.attempts[0].expectedQuantity).toBe(2);
    expect(result.attempts[0].desiredQuantity).toBe(7);

    // First attempt uses the BASE idempotency key, no `:retry` suffix.
    expect(result.attempts[0].idempotencyKey).toBe("clandestine_shopify:corr-1:SKU-1");
    expect(result.attempts[0].idempotencyKey).not.toContain(":retry");

    // Sleep was NOT called on a single-attempt success.
    expect(params.sleep).not.toHaveBeenCalled();

    // Ledger marked success with attempts[] embedded.
    expect(sb.syncUpdate).toHaveBeenCalledTimes(1);
    const updateCall = sb.syncUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.status).toBe("success");
    const responseBody = updateCall.response_body as Record<string, unknown>;
    expect(responseBody.final_new_quantity).toBe(7);
    expect((responseBody.attempts as unknown[]).length).toBe(1);

    // No review queue row on a success.
    expect(sb.reviewUpsert).not.toHaveBeenCalled();
  });

  it("computeDesired receives the just-read remote available value", async () => {
    const computeDesired = vi.fn().mockResolvedValue(11);
    const { params } = buildBaseParams({ computeDesired });
    mockShopifyGraphQL.mockResolvedValueOnce(buildAvailableResponse(5));
    mockSetShopifyInventoryWithCompare.mockResolvedValueOnce({
      ok: true,
      newQuantity: 11,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/x",
    });
    await setShopifyInventoryCas(params);
    expect(computeDesired).toHaveBeenCalledTimes(1);
    expect(computeDesired).toHaveBeenCalledWith(5);
  });
});

describe("setShopifyInventoryCas — mismatch then success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attempt 1 mismatch + attempt 2 success — uses :retry1 suffix and sleeps 50ms once", async () => {
    const { params, sb } = buildBaseParams();
    mockShopifyGraphQL
      .mockResolvedValueOnce(buildAvailableResponse(2))
      .mockResolvedValueOnce(buildAvailableResponse(4));

    mockSetShopifyInventoryWithCompare
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 4,
        message: "actual quantity: 4",
      })
      .mockResolvedValueOnce({
        ok: true,
        newQuantity: 9,
        adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/y",
      });

    const result = await setShopifyInventoryCas(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].outcome).toBe("compare_mismatch");
    expect(result.attempts[0].actualQuantity).toBe(4);
    expect(result.attempts[1].outcome).toBe("success");

    // Idempotency keys: attempt 1 base, attempt 2 :retry1.
    expect(result.attempts[0].idempotencyKey).toBe("clandestine_shopify:corr-1:SKU-1");
    expect(result.attempts[1].idempotencyKey).toBe("clandestine_shopify:corr-1:SKU-1:retry1");

    // Sleep called exactly once between attempt 1 and attempt 2 with backoff[0]=50.
    expect(params.sleep).toHaveBeenCalledTimes(1);
    expect(params.sleep).toHaveBeenCalledWith(50);

    // computeDesired called for each attempt with the freshly-read value.
    expect(params.computeDesired).toHaveBeenCalledTimes(2);
    expect((params.computeDesired as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(2);
    expect((params.computeDesired as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(4);

    // Ledger marked success once on the terminal outcome.
    expect(sb.syncUpdate).toHaveBeenCalledTimes(1);
    expect((sb.syncUpdate.mock.calls[0][0] as Record<string, unknown>).status).toBe("success");

    // No review queue on success.
    expect(sb.reviewUpsert).not.toHaveBeenCalled();
  });

  it("attempt 1+2 mismatch + attempt 3 success — uses :retry1, :retry2 and sleeps 50+150", async () => {
    const { params } = buildBaseParams();
    mockShopifyGraphQL
      .mockResolvedValueOnce(buildAvailableResponse(2))
      .mockResolvedValueOnce(buildAvailableResponse(4))
      .mockResolvedValueOnce(buildAvailableResponse(6));

    mockSetShopifyInventoryWithCompare
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 4,
        message: "actual quantity: 4",
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 6,
        message: "actual quantity: 6",
      })
      .mockResolvedValueOnce({
        ok: true,
        newQuantity: 11,
        adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/z",
      });

    const result = await setShopifyInventoryCas(params);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.idempotencyKey)).toEqual([
      "clandestine_shopify:corr-1:SKU-1",
      "clandestine_shopify:corr-1:SKU-1:retry1",
      "clandestine_shopify:corr-1:SKU-1:retry2",
    ]);

    expect(params.sleep).toHaveBeenCalledTimes(2);
    expect((params.sleep as ReturnType<typeof vi.fn>).mock.calls).toEqual([[50], [150]]);
  });
});

describe("setShopifyInventoryCas — exhaustion after 3 mismatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:false reason:'exhausted', marks ledger error, upserts review queue (severity:medium, group_key)", async () => {
    const { params, sb } = buildBaseParams();
    mockShopifyGraphQL
      .mockResolvedValueOnce(buildAvailableResponse(2))
      .mockResolvedValueOnce(buildAvailableResponse(4))
      .mockResolvedValueOnce(buildAvailableResponse(6));

    mockSetShopifyInventoryWithCompare
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 4,
        message: "actual quantity: 4",
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 6,
        message: "actual quantity: 6",
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 8,
        message: "actual quantity: 8",
      });

    const result = await setShopifyInventoryCas(params);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("exhausted");
    expect(result.attempts).toHaveLength(3);
    expect(result.lastActualQuantity).toBe(8);

    // Sleep called between attempts — 50 + 150, NOT after the last attempt.
    expect(params.sleep).toHaveBeenCalledTimes(2);
    expect((params.sleep as ReturnType<typeof vi.fn>).mock.calls).toEqual([[50], [150]]);

    // Ledger marked error with cas_exhausted flag.
    expect(sb.syncUpdate).toHaveBeenCalledTimes(1);
    const ledgerCall = sb.syncUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(ledgerCall.status).toBe("error");
    const ledgerBody = ledgerCall.response_body as Record<string, unknown>;
    expect(ledgerBody.cas_exhausted).toBe(true);
    expect(ledgerBody.last_actual_quantity).toBe(8);

    // Review queue upserted with the right shape.
    expect(sb.reviewUpsert).toHaveBeenCalledTimes(1);
    const [reviewRow, upsertOpts] = sb.reviewUpsert.mock.calls[0];
    expect(reviewRow.workspace_id).toBe("ws-1");
    expect(reviewRow.org_id).toBe("org-1");
    expect(reviewRow.category).toBe("cas_exhausted");
    expect(reviewRow.severity).toBe("medium");
    expect(reviewRow.group_key).toBe("cas_exhausted:ws-1:clandestine_shopify:SKU-1");
    expect(reviewRow.status).toBe("open");
    expect(reviewRow.metadata.sku).toBe("SKU-1");
    expect(reviewRow.metadata.attempts).toHaveLength(3);
    expect(reviewRow.metadata.last_actual_quantity).toBe(8);
    expect(reviewRow.metadata.max_attempts_reached).toBe(true);
    // onConflict on the UNIQUE group_key index (Rule #55 dedup).
    expect(upsertOpts).toMatchObject({ onConflict: "group_key", ignoreDuplicates: false });
  });

  it("respects custom maxAttempts override (test seam)", async () => {
    const { params } = buildBaseParams({ maxAttempts: 2 });
    mockShopifyGraphQL
      .mockResolvedValueOnce(buildAvailableResponse(2))
      .mockResolvedValueOnce(buildAvailableResponse(4));

    mockSetShopifyInventoryWithCompare
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 4,
        message: "m",
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "compare_mismatch",
        actualQuantity: 6,
        message: "m",
      });

    const result = await setShopifyInventoryCas(params);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toHaveLength(2);
    // Sleep only between the two attempts (one sleep, value backoff[0]=50).
    expect(params.sleep).toHaveBeenCalledTimes(1);
  });
});

describe("setShopifyInventoryCas — non-CAS errors propagate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setShopifyInventoryWithCompare throwing (e.g. invalid GID) re-throws AND marks ledger error with partial attempts", async () => {
    const { params, sb } = buildBaseParams();
    mockShopifyGraphQL.mockResolvedValueOnce(buildAvailableResponse(2));
    mockSetShopifyInventoryWithCompare.mockRejectedValueOnce(
      new Error("Inventory item could not be found"),
    );

    await expect(setShopifyInventoryCas(params)).rejects.toThrow(
      /Inventory item could not be found/,
    );

    expect(sb.syncUpdate).toHaveBeenCalledTimes(1);
    const updateCall = sb.syncUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.status).toBe("error");
    const body = updateCall.response_body as Record<string, unknown>;
    expect(body.last_attempt).toBe(1);
    // No review queue on a non-CAS throw — that's a programmer error,
    // surfaced via the task-framework error path, not as a hot-SKU
    // race signal.
    expect(sb.reviewUpsert).not.toHaveBeenCalled();
  });

  it("readShopifyAvailable throwing (e.g. transport failure) re-throws", async () => {
    const { params } = buildBaseParams();
    mockShopifyGraphQL.mockRejectedValueOnce(new Error("network down"));
    await expect(setShopifyInventoryCas(params)).rejects.toThrow(/network down/);
  });
});

describe("setShopifyInventoryCas — per-connection transport routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes the read through connectionShopifyGraphQL when transport is per-connection", async () => {
    const { params } = buildBaseParams({
      transport: {
        kind: "per_connection",
        ctx: { storeUrl: "https://shop.example.com", accessToken: "shpat_xxx" },
        // biome-ignore lint/suspicious/noExplicitAny: test seam
      } as any,
      system: "client_store_shopify",
    });
    mockConnectionShopifyGraphQL.mockResolvedValueOnce(buildAvailableResponse(3));
    mockSetShopifyInventoryWithCompare.mockResolvedValueOnce({
      ok: true,
      newQuantity: 7,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/p",
    });

    await setShopifyInventoryCas(params);

    expect(mockShopifyGraphQL).not.toHaveBeenCalled();
    expect(mockConnectionShopifyGraphQL).toHaveBeenCalledTimes(1);
    expect(mockConnectionShopifyGraphQL.mock.calls[0][0]).toEqual({
      storeUrl: "https://shop.example.com",
      accessToken: "shpat_xxx",
    });
  });
});
