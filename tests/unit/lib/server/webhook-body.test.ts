import { describe, expect, it } from "vitest";
import { canonicalBodyDedupKey, interpretDedupError } from "@/lib/server/webhook-body";

// F-3 / F-4 helper tests. These pin the contract that the client-store
// route handler relies on for dedup correctness; if you change the helper
// shape, update the route at the same time.

describe("interpretDedupError (F-3)", () => {
  it("returns fresh when row exists and there is no error", () => {
    const r = interpretDedupError({ id: "evt_1" }, null);
    expect(r).toEqual({ kind: "fresh", rowId: "evt_1" });
  });

  it("treats SQLSTATE 23505 (unique violation) as duplicate", () => {
    const r = interpretDedupError(null, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });
    expect(r).toEqual({ kind: "duplicate", sqlState: "23505" });
  });

  it("treats 08006 connection_failure as transient", () => {
    const r = interpretDedupError(null, {
      code: "08006",
      message: "connection_failure",
    });
    expect(r).toEqual({ kind: "transient", reason: "connection_failure", sqlState: "08006" });
  });

  it("treats 53300 too_many_connections (supavisor saturated) as transient", () => {
    const r = interpretDedupError(null, {
      code: "53300",
      message: "too many connections",
    });
    expect(r.kind).toBe("transient");
    expect(r).toMatchObject({ sqlState: "53300" });
  });

  it("treats fetch failed (no SQLSTATE) as transient via message heuristic", () => {
    const r = interpretDedupError(null, { message: "fetch failed" });
    expect(r.kind).toBe("transient");
  });

  it("treats anything unrecognized as unknown (caller must 503 + sentry)", () => {
    const r = interpretDedupError(null, {
      code: "23502",
      message: "null value in column violates not-null constraint",
    });
    expect(r.kind).toBe("unknown");
    expect(r).toMatchObject({ sqlState: "23502" });
  });

  it("flags missing-row-without-error as unknown so callers don't silently drop", () => {
    const r = interpretDedupError(null, null);
    expect(r).toEqual({ kind: "unknown", reason: "insert_returned_no_row" });
  });

  it("never returns fresh when an error is present, even if a row id leaked through", () => {
    const r = interpretDedupError({ id: "evt_2" }, { code: "23505", message: "dup" });
    expect(r.kind).toBe("duplicate");
  });
});

describe("canonicalBodyDedupKey (F-4)", () => {
  it("is stable across calls with the same body", () => {
    const a = canonicalBodyDedupKey("squarespace", '{"order":1}');
    const b = canonicalBodyDedupKey("squarespace", '{"order":1}');
    expect(a).toBe(b);
  });

  it("includes the platform prefix lowercased", () => {
    const k = canonicalBodyDedupKey("Squarespace", '{"x":1}');
    expect(k.startsWith("squarespace:")).toBe(true);
  });

  it("falls back to 'unknown' when platform is null", () => {
    const k = canonicalBodyDedupKey(null, '{"x":1}');
    expect(k.startsWith("unknown:")).toBe(true);
  });

  it("emits a 64-char hex sha256 suffix", () => {
    const k = canonicalBodyDedupKey("woocommerce", '{"a":2}');
    const [, hash] = k.split(":");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs when the body byte-differs (whitespace counts)", () => {
    const a = canonicalBodyDedupKey("woocommerce", '{"x":1}');
    const b = canonicalBodyDedupKey("woocommerce", '{"x": 1}');
    expect(a).not.toBe(b);
  });

  it("differs across platforms even for identical body bytes (collision insurance)", () => {
    const body = '{"x":1}';
    expect(canonicalBodyDedupKey("woocommerce", body)).not.toBe(
      canonicalBodyDedupKey("squarespace", body),
    );
  });
});
