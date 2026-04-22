import { describe, expect, it, vi } from "vitest";
import { normalizeShopDomain, verifyShopDomain } from "@/lib/server/shopify-shop-verify";

// F-5 / HRD-10 — shop-domain verification helper tests. Pin the contract
// the OAuth callback relies on to reject token-reuse-across-shops attacks.

describe("normalizeShopDomain (F-5)", () => {
  it("appends .myshopify.com when the suffix is missing", () => {
    expect(normalizeShopDomain("teststore")).toBe("teststore.myshopify.com");
  });

  it("lowercases", () => {
    expect(normalizeShopDomain("TestStore.MyShopify.com")).toBe("teststore.myshopify.com");
  });

  it("strips leading https:// scheme", () => {
    expect(normalizeShopDomain("https://teststore.myshopify.com")).toBe("teststore.myshopify.com");
  });

  it("strips a trailing slash", () => {
    expect(normalizeShopDomain("teststore.myshopify.com/")).toBe("teststore.myshopify.com");
  });

  it("strips path/query/fragment", () => {
    expect(normalizeShopDomain("teststore.myshopify.com/admin?foo=bar#x")).toBe(
      "teststore.myshopify.com",
    );
  });

  it("returns null for empty/whitespace input", () => {
    expect(normalizeShopDomain("")).toBeNull();
    expect(normalizeShopDomain("   ")).toBeNull();
    expect(normalizeShopDomain(null)).toBeNull();
    expect(normalizeShopDomain(undefined)).toBeNull();
  });

  it("refuses to rewrite a non-myshopify TLD (security: don't fake-canonicalize attacker input)", () => {
    expect(normalizeShopDomain("attacker.example.com")).toBeNull();
  });

  it("rejects hostnames containing whitespace or invalid chars", () => {
    expect(normalizeShopDomain("teststore .myshopify.com")).toBeNull();
    expect(normalizeShopDomain("teststore<.myshopify.com")).toBeNull();
  });

  it("is idempotent (re-normalizing a canonical value is a no-op)", () => {
    const a = normalizeShopDomain("teststore");
    expect(a).not.toBeNull();
    expect(normalizeShopDomain(a)).toBe(a);
  });
});

describe("verifyShopDomain (F-5)", () => {
  function fetchReturning(
    payload: unknown,
    opts: { ok?: boolean; status?: number; text?: string } = {},
  ) {
    return vi.fn(async () => ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => opts.text ?? JSON.stringify(payload),
    })) as unknown as typeof fetch;
  }

  it("happy path: shop param matches myshopifyDomain → ok with canonical form", async () => {
    const r = await verifyShopDomain({
      shopParam: "teststore.myshopify.com",
      accessToken: "tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning({ data: { shop: { myshopifyDomain: "teststore.myshopify.com" } } }),
    });
    expect(r).toEqual({ kind: "ok", canonicalDomain: "teststore.myshopify.com" });
  });

  it("case difference normalizes to ok (Shopify can return mixed case)", async () => {
    const r = await verifyShopDomain({
      shopParam: "TestStore.myshopify.com",
      accessToken: "tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning({ data: { shop: { myshopifyDomain: "teststore.MYSHOPIFY.COM" } } }),
    });
    expect(r.kind).toBe("ok");
  });

  it("no-suffix shop param normalizes to .myshopify.com (legacy install flow)", async () => {
    const r = await verifyShopDomain({
      shopParam: "teststore",
      accessToken: "tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning({ data: { shop: { myshopifyDomain: "teststore.myshopify.com" } } }),
    });
    expect(r).toEqual({ kind: "ok", canonicalDomain: "teststore.myshopify.com" });
  });

  it("mismatch (token-reuse attack): returns mismatch with both sides for forensics", async () => {
    const r = await verifyShopDomain({
      shopParam: "victim.myshopify.com",
      accessToken: "stolen-tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning({
        data: { shop: { myshopifyDomain: "attacker.myshopify.com" } },
      }),
    });
    expect(r).toEqual({
      kind: "mismatch",
      expected: "victim.myshopify.com",
      actual: "attacker.myshopify.com",
    });
  });

  it("invalid shop param (non-myshopify TLD) → shop_param_invalid (no GraphQL probe issued)", async () => {
    const fetchSpy = fetchReturning({ data: { shop: { myshopifyDomain: "x.myshopify.com" } } });
    const r = await verifyShopDomain({
      shopParam: "attacker.example.com",
      accessToken: "tok",
      apiVersion: "2024-10",
      fetchImpl: fetchSpy,
    });
    expect(r.kind).toBe("shop_param_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("non-2xx GraphQL response → graphql_error with status", async () => {
    const r = await verifyShopDomain({
      shopParam: "teststore.myshopify.com",
      accessToken: "expired-tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning(null, { ok: false, status: 401, text: "Unauthorized" }),
    });
    expect(r).toMatchObject({ kind: "graphql_error", status: 401 });
  });

  it("malformed GraphQL response → missing_shop_field (caught instead of crashing)", async () => {
    const r = await verifyShopDomain({
      shopParam: "teststore.myshopify.com",
      accessToken: "tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning(null, { text: "not-json" }),
    });
    expect(r.kind).toBe("missing_shop_field");
  });

  it("response with no shop.myshopifyDomain field → missing_shop_field", async () => {
    const r = await verifyShopDomain({
      shopParam: "teststore.myshopify.com",
      accessToken: "tok",
      apiVersion: "2024-10",
      fetchImpl: fetchReturning({ data: { shop: {} } }),
    });
    expect(r.kind).toBe("missing_shop_field");
  });
});
