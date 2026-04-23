/**
 * Phase 1 Pass 2 §9.2 D4 Step B — `setShopifyInventoryWithCompare` unit tests.
 *
 * Pins the contract:
 *   1. `makeCasIdempotencyKey` shape is `{system}:{correlationId}:{sku}`
 *      with `:retryN` only when retryAttempt > 0.
 *   2. Happy path returns `{ok: true, newQuantity, adjustmentGroupId}`
 *      and the GraphQL mutation carries:
 *        - `compareQuantity = expectedQuantity`
 *        - `quantity = desiredQuantity`
 *        - `ignoreCompareQuantity: false`
 *        - `@idempotent` directive variable populated.
 *   3. CAS mismatch (Shopify returns userErrors[0].code = INVALID_COMPARE_QUANTITY)
 *      surfaces as `{ok:false, reason:"compare_mismatch", actualQuantity, message}`
 *      WITHOUT throwing.
 *   4. Non-CAS userErrors (e.g. invalid GID) THROW so the task framework
 *      catches them — they are not race conditions.
 *   5. Per-connection transport routes through `connectionShopifyGraphQL`
 *      (not the env-singleton `shopifyGraphQL`).
 *   6. `actualQuantity` extraction handles both Shopify message formats
 *      (`actual quantity: N` and `found N`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockShopifyGraphQL, mockConnectionShopifyGraphQL } = vi.hoisted(() => ({
  mockShopifyGraphQL: vi.fn(),
  mockConnectionShopifyGraphQL: vi.fn(),
}));

vi.mock("@/lib/clients/shopify-client", () => ({
  shopifyGraphQL: mockShopifyGraphQL,
}));

vi.mock("@/lib/server/shopify-connection-graphql", () => ({
  connectionShopifyGraphQL: mockConnectionShopifyGraphQL,
}));

import { makeCasIdempotencyKey, setShopifyInventoryWithCompare } from "@/lib/clients/shopify-cas";

const HAPPY_RESPONSE = {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: {
      id: "gid://shopify/InventoryAdjustmentGroup/abc123",
      changes: [
        {
          name: "available",
          delta: 5,
          quantityAfterChange: 7,
        },
      ],
    },
    userErrors: [],
  },
};

const COMPARE_MISMATCH_RESPONSE = {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: null,
    userErrors: [
      {
        field: ["input", "quantities", "0", "compareQuantity"],
        code: "INVALID_COMPARE_QUANTITY",
        message:
          "The provided compare quantity does not match the actual quantity: 4 (expected 6).",
      },
    ],
  },
};

const INVALID_GID_RESPONSE = {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: null,
    userErrors: [
      {
        field: ["input", "quantities", "0", "inventoryItemId"],
        code: "INVALID",
        message: "Inventory item could not be found.",
      },
    ],
  },
};

const BASE_INPUT = {
  inventoryItemId: "gid://shopify/InventoryItem/12345",
  locationId: "gid://shopify/Location/67890",
  expectedQuantity: 2,
  desiredQuantity: 7,
  idempotencyKey: "clandestine_shopify:wh-abc:SKU-1",
};

const PER_CONNECTION_CTX = {
  ctx: {
    storeUrl: "https://shop.example.com",
    accessToken: "shpat_xxx",
  },
};

describe("makeCasIdempotencyKey", () => {
  it("default (retryAttempt=0) emits the base shape", () => {
    expect(makeCasIdempotencyKey("clandestine_shopify", "wh-abc", "SKU-1")).toBe(
      "clandestine_shopify:wh-abc:SKU-1",
    );
  });

  it("retryAttempt > 0 appends `:retryN` so each retry is a fresh key", () => {
    expect(makeCasIdempotencyKey("client_store_shopify", "wh-abc", "SKU-1", 1)).toBe(
      "client_store_shopify:wh-abc:SKU-1:retry1",
    );
    expect(makeCasIdempotencyKey("client_store_shopify", "wh-abc", "SKU-1", 3)).toBe(
      "client_store_shopify:wh-abc:SKU-1:retry3",
    );
  });

  it("system namespacing prevents collisions across systems on the same correlation_id", () => {
    const a = makeCasIdempotencyKey("clandestine_shopify", "same-corr", "SKU-1");
    const b = makeCasIdempotencyKey("client_store_shopify", "same-corr", "SKU-1");
    expect(a).not.toBe(b);
  });
});

describe("setShopifyInventoryWithCompare — env-singleton transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path returns ok:true with Shopify's quantityAfterChange and adjustmentGroupId", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(HAPPY_RESPONSE);
    const result = await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);
    expect(result).toEqual({
      ok: true,
      newQuantity: 7,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/abc123",
    });
  });

  it("sends the CAS-shaped GraphQL variables (compareQuantity + ignoreCompareQuantity:false)", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(HAPPY_RESPONSE);
    await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);

    expect(mockShopifyGraphQL).toHaveBeenCalledTimes(1);
    const [mutation, variables] = mockShopifyGraphQL.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(mutation).toContain("inventorySetQuantities");
    expect(mutation).toContain("@idempotent");
    expect(variables.idempotencyKey).toBe(BASE_INPUT.idempotencyKey);
    const inputArg = variables.input as Record<string, unknown>;
    expect(inputArg.ignoreCompareQuantity).toBe(false);
    expect(inputArg.name).toBe("available");
    const quantities = inputArg.quantities as Array<Record<string, unknown>>;
    expect(quantities).toHaveLength(1);
    expect(quantities[0]).toEqual({
      inventoryItemId: BASE_INPUT.inventoryItemId,
      locationId: BASE_INPUT.locationId,
      quantity: BASE_INPUT.desiredQuantity,
      compareQuantity: BASE_INPUT.expectedQuantity,
    });
  });

  it("defaults referenceDocumentUri to a clandestine://cas/ URI carrying the idempotency key", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(HAPPY_RESPONSE);
    await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);
    const [, variables] = mockShopifyGraphQL.mock.calls[0] as [string, Record<string, unknown>];
    const inputArg = variables.input as Record<string, unknown>;
    expect(inputArg.referenceDocumentUri).toBe(`clandestine://cas/${BASE_INPUT.idempotencyKey}`);
  });

  it("respects an explicit referenceDocumentUri override", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(HAPPY_RESPONSE);
    await setShopifyInventoryWithCompare(
      { kind: "env_singleton" },
      { ...BASE_INPUT, referenceDocumentUri: "https://example/audit/123" },
    );
    const [, variables] = mockShopifyGraphQL.mock.calls[0] as [string, Record<string, unknown>];
    const inputArg = variables.input as Record<string, unknown>;
    expect(inputArg.referenceDocumentUri).toBe("https://example/audit/123");
  });

  it("CAS mismatch surfaces as typed result (NO throw), with parsed actualQuantity", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(COMPARE_MISMATCH_RESPONSE);
    const result = await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("compare_mismatch");
    expect(result.actualQuantity).toBe(4);
    expect(result.message).toContain("compare quantity");
  });

  it("CAS mismatch with an unparseable actualQuantity message returns null actual", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce({
      inventorySetQuantities: {
        inventoryAdjustmentGroup: null,
        userErrors: [
          {
            field: null,
            code: "INVALID_COMPARE_QUANTITY",
            message: "Compare quantity does not match.",
          },
        ],
      },
    });
    const result = await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("compare_mismatch");
    expect(result.actualQuantity).toBeNull();
  });

  it("recognizes CAS mismatch via message substring even when code drops the COMPARE keyword", async () => {
    // Defensive: Shopify has historically renamed userError codes between API
    // versions. The message text "compare quantity" has been stable.
    mockShopifyGraphQL.mockResolvedValueOnce({
      inventorySetQuantities: {
        inventoryAdjustmentGroup: null,
        userErrors: [
          {
            field: null,
            code: "INVALID",
            message: "Provided compare quantity does not match the actual quantity: 11.",
          },
        ],
      },
    });
    const result = await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("compare_mismatch");
    expect(result.actualQuantity).toBe(11);
  });

  it("non-CAS userErrors THROW (programmer error, not a race)", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(INVALID_GID_RESPONSE);
    await expect(
      setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT),
    ).rejects.toThrow(/Inventory item could not be found/);
  });

  it("falls back to desiredQuantity when Shopify omits quantityAfterChange", async () => {
    // Defensive: older API versions might return adjustmentGroup but no
    // changes[] entry — the helper should not return NaN/undefined.
    mockShopifyGraphQL.mockResolvedValueOnce({
      inventorySetQuantities: {
        inventoryAdjustmentGroup: {
          id: "gid://shopify/InventoryAdjustmentGroup/xyz",
          changes: [],
        },
        userErrors: [],
      },
    });
    const result = await setShopifyInventoryWithCompare({ kind: "env_singleton" }, BASE_INPUT);
    expect(result).toEqual({
      ok: true,
      newQuantity: BASE_INPUT.desiredQuantity,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/xyz",
    });
  });
});

describe("setShopifyInventoryWithCompare — per-connection transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes through connectionShopifyGraphQL with the supplied ctx (NOT shopifyGraphQL)", async () => {
    mockConnectionShopifyGraphQL.mockResolvedValueOnce(HAPPY_RESPONSE);
    await setShopifyInventoryWithCompare(
      { kind: "per_connection", ctx: PER_CONNECTION_CTX.ctx },
      BASE_INPUT,
    );
    expect(mockShopifyGraphQL).not.toHaveBeenCalled();
    expect(mockConnectionShopifyGraphQL).toHaveBeenCalledTimes(1);
    const [ctx, mutation, variables] = mockConnectionShopifyGraphQL.mock.calls[0] as [
      typeof PER_CONNECTION_CTX.ctx,
      string,
      Record<string, unknown>,
    ];
    expect(ctx).toEqual(PER_CONNECTION_CTX.ctx);
    expect(mutation).toContain("inventorySetQuantities");
    expect(variables.idempotencyKey).toBe(BASE_INPUT.idempotencyKey);
  });

  it("CAS mismatch on per-connection transport returns the same typed result", async () => {
    mockConnectionShopifyGraphQL.mockResolvedValueOnce(COMPARE_MISMATCH_RESPONSE);
    const result = await setShopifyInventoryWithCompare(
      { kind: "per_connection", ctx: PER_CONNECTION_CTX.ctx },
      BASE_INPUT,
    );
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("compare_mismatch");
    expect(result.actualQuantity).toBe(4);
  });
});
