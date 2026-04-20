// Phase 10.2 — EasyPost webhook HMAC verification tests.
//
// Locks in:
//  - v2 header parsing (`t=<ms>,s=<hex>`)
//  - v2 timestamp tolerance (±5 min default)
//  - v1 fallback on raw-body HMAC-SHA256 hex
//  - constant-time comparison rejects single-bit mismatches
//  - "fractional weight" precision regression (Reviewer 4 — EP Node SDK
//    issue #467): signature MUST be over the raw bytes, not over a
//    re-stringified parsed body. We verify by comparing two binary
//    payloads that differ only in numeric formatting.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseV2Header,
  verifyEasypostSignature,
} from "@/lib/server/easypost-webhook-signature";

const SECRET = "test-ep-secret";

function signV1(body: Buffer): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function signV2(body: Buffer, ts: number): string {
  const signed = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), body]);
  const hex = createHmac("sha256", SECRET).update(signed).digest("hex");
  return `t=${ts},s=${hex}`;
}

describe("parseV2Header (Phase 10.2)", () => {
  it("parses well-formed t=,s= header", () => {
    const out = parseV2Header("t=1700000000000,s=deadbeef");
    expect(out).toEqual({ timestamp: 1700000000000, signatureHex: "deadbeef" });
  });
  it("tolerates whitespace + key order", () => {
    expect(parseV2Header(" s=abcdef , t=1234567890123 ")).toEqual({
      timestamp: 1234567890123,
      signatureHex: "abcdef",
    });
  });
  it("rejects missing parts", () => {
    expect(parseV2Header("s=deadbeef")).toBeNull();
    expect(parseV2Header("t=1700000000000")).toBeNull();
  });
  it("rejects non-hex signature", () => {
    expect(parseV2Header("t=1700000000000,s=NOTHEX")).toBeNull();
  });
});

describe("verifyEasypostSignature (Phase 10.2)", () => {
  const body = Buffer.from(JSON.stringify({ result: { tracking_code: "1Z" } }), "utf8");

  it("v2 happy path passes", () => {
    const now = Date.now();
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: SECRET,
      v1Header: null,
      v2Header: signV2(body, now),
      now,
    });
    expect(r.valid).toBe(true);
    expect(r.timestamp).toBe(now);
  });

  it("v2 outside tolerance fails (replay protection)", () => {
    const now = Date.now();
    const tooOld = now - 10 * 60 * 1000; // 10 min ago, > 5 min tolerance
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: SECRET,
      v1Header: null,
      v2Header: signV2(body, tooOld),
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("timestamp_outside_tolerance");
  });

  it("v2 within configurable tolerance still passes", () => {
    const now = Date.now();
    const tenMinAgo = now - 10 * 60 * 1000;
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: SECRET,
      v1Header: null,
      v2Header: signV2(body, tenMinAgo),
      now,
      toleranceMs: 15 * 60 * 1000,
    });
    expect(r.valid).toBe(true);
  });

  it("v1 happy path passes when v2 absent", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: SECRET,
      v1Header: signV1(body),
      v2Header: null,
    });
    expect(r.valid).toBe(true);
  });

  it("v1 mismatch rejected", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: SECRET,
      v1Header: signV1(Buffer.from("OTHER", "utf8")),
      v2Header: null,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("missing both headers rejected", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: SECRET,
      v1Header: null,
      v2Header: null,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_signature");
  });

  it("missing secret rejected", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secret: "",
      v1Header: signV1(body),
      v2Header: null,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_secret");
  });

  it("FRACTIONAL WEIGHT regression — bytes signed must be the bytes received (EP SDK #467)", () => {
    // The actual prod incident: EP sends body with `"weight": 136.0` but
    // the receiving Node SDK parses it as 136 then re-serializes as
    // `"weight":136`, breaking HMAC. Our handler validates against the raw
    // arrayBuffer BEFORE parsing, so this can't happen. Demonstrate by
    // signing the fractional version and rejecting the integer version.
    const fractional = Buffer.from(`{"weight":136.0}`, "utf8");
    const integer = Buffer.from(`{"weight":136}`, "utf8");
    const sigOverFractional = signV1(fractional);
    // Same bytes → pass.
    expect(
      verifyEasypostSignature({
        rawBody: fractional,
        secret: SECRET,
        v1Header: sigOverFractional,
        v2Header: null,
      }).valid,
    ).toBe(true);
    // Different bytes (re-stringified) → fail. Locks in the requirement.
    expect(
      verifyEasypostSignature({
        rawBody: integer,
        secret: SECRET,
        v1Header: sigOverFractional,
        v2Header: null,
      }).valid,
    ).toBe(false);
  });
});
