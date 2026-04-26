// Phase 10.2 / Slice 1 — EasyPost webhook HMAC verification tests.
//
// Locks in the actual EasyPost contracts (verified against the EasyPost
// Python/Go SDKs and the EasyPost Support article on Webhook HMAC
// Validation, 2026-04):
//   v2: x-timestamp + x-path + x-hmac-signature-v2 ("hmac-sha256-hex=" prefix);
//       string-to-sign = `${xTimestamp}${METHOD}${xPath}${rawBody}`;
//       past tolerance 300s, future tolerance 30s.
//   v1: x-hmac-signature ("hmac-sha256-hex=" prefix); raw-body HMAC; secret
//       NFKD-normalized to mirror EP SDKs.
//   Dual-secret rotation accepted (current + previous).
//   Generic verifier outputs (timing-safe comparison, no oracle leakage).
//   Fractional-weight regression (EP SDK #467) — bytes signed must be the
//   bytes received.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePath, verifyEasypostSignature } from "@/lib/server/easypost-webhook-signature";

const SECRET = "test-ep-secret";
const PREVIOUS_SECRET = "test-ep-secret-previous";
const PATH = "/api/webhooks/easypost";

function nfkd(s: string): string {
  return s.normalize("NFKD");
}

function v1Header(body: Buffer, secret: string = SECRET): string {
  const hex = createHmac("sha256", nfkd(secret)).update(body).digest("hex");
  return `hmac-sha256-hex=${hex}`;
}

function v2Header(
  body: Buffer,
  xTimestamp: string,
  method: string,
  xPath: string,
  secret: string = SECRET,
): string {
  const prefix = Buffer.from(`${xTimestamp}${method.toUpperCase()}${xPath}`, "utf8");
  const signed = Buffer.concat([prefix, body]);
  const hex = createHmac("sha256", nfkd(secret)).update(signed).digest("hex");
  return `hmac-sha256-hex=${hex}`;
}

describe("normalizePath", () => {
  it("strips trailing slash", () => {
    expect(normalizePath("/api/webhooks/easypost/")).toBe("/api/webhooks/easypost");
  });
  it("strips query string", () => {
    expect(normalizePath("/api/webhooks/easypost?foo=bar")).toBe("/api/webhooks/easypost");
  });
  it("returns root unchanged", () => {
    expect(normalizePath("/")).toBe("/");
  });
});

describe("verifyEasypostSignature — v2 (current EasyPost spec)", () => {
  const body = Buffer.from(JSON.stringify({ result: { tracking_code: "1Z" } }), "utf8");
  const now = Date.parse("2026-04-25T12:00:00Z");
  const xTimestamp = "Sat, 25 Apr 2026 12:00:00 GMT";

  it("happy path passes", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(true);
    expect(r.variant).toBe("v2");
    expect(r.secretIndex).toBe(0);
    expect(r.timestamp).toBe(now);
  });

  it("rejects missing x-timestamp", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: null,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("missing_x_timestamp");
  });

  it("rejects missing x-path", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp,
      xPath: null,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("missing_x_path");
  });

  it("rejects timestamp too old (>5min past)", () => {
    const tooOld = "Sat, 25 Apr 2026 11:50:00 GMT"; // 10 min ago
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: tooOld,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, tooOld, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("timestamp_too_old");
  });

  it("rejects timestamp too far in future (>30s ahead)", () => {
    const future = "Sat, 25 Apr 2026 12:01:00 GMT"; // 60s ahead
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: future,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, future, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("timestamp_too_future");
  });

  it("rejects path mismatch (HMAC may match but expected path differs)", () => {
    const wrongPath = "/api/webhooks/spoofed";
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp,
      xPath: wrongPath,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", wrongPath),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("path_mismatch");
  });

  it("tolerates trailing slash in x-path", () => {
    const xPathWithSlash = `${PATH}/`;
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp,
      xPath: xPathWithSlash,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", xPathWithSlash),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(true);
  });

  it("rejects v2 header without 'hmac-sha256-hex=' prefix", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp,
      xPath: PATH,
      xHmacSignatureV2: createHmac("sha256", SECRET).update(body).digest("hex"),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid_v2_signature_prefix");
  });

  it("rejects signature mismatch (single-bit altered body)", () => {
    const altered = Buffer.from(JSON.stringify({ result: { tracking_code: "1Y" } }), "utf8");
    const r = verifyEasypostSignature({
      rawBody: altered,
      secrets: SECRET,
      xTimestamp,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("dual-secret rotation: signature signed with previous secret accepted; secretIndex=1", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: [SECRET, PREVIOUS_SECRET],
      xTimestamp,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", PATH, PREVIOUS_SECRET),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
      now,
    });
    expect(r.valid).toBe(true);
    expect(r.secretIndex).toBe(1);
  });
});

describe("verifyEasypostSignature — v1 (legacy, still emitted by EP SDKs)", () => {
  const body = Buffer.from(JSON.stringify({ result: { tracking_code: "1Z" } }), "utf8");

  it("happy path passes (no v2 headers required)", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: v1Header(body),
    });
    expect(r.valid).toBe(true);
    expect(r.variant).toBe("v1");
  });

  it("rejects v1 header without 'hmac-sha256-hex=' prefix (EP contract)", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: createHmac("sha256", SECRET).update(body).digest("hex"),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid_v1_signature_prefix");
  });

  it("rejects v1 mismatch", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: v1Header(Buffer.from("OTHER", "utf8")),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("v2 header preferred when both present (v1 ignored even on conflict)", () => {
    const now = Date.parse("2026-04-25T12:00:00Z");
    const xTimestamp = "Sat, 25 Apr 2026 12:00:00 GMT";
    // v1 over WRONG body, v2 valid → result must be valid (v2 wins).
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp,
      xPath: PATH,
      xHmacSignatureV2: v2Header(body, xTimestamp, "POST", PATH),
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: v1Header(Buffer.from("OTHER", "utf8")),
      now,
    });
    expect(r.valid).toBe(true);
    expect(r.variant).toBe("v2");
  });

  it("v1 fallback can be disabled", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: v1Header(body),
      allowV1Fallback: false,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_signature");
  });
});

describe("verifyEasypostSignature — error/edge cases", () => {
  const body = Buffer.from(`{"x":1}`, "utf8");

  it("rejects when no secrets supplied", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: "",
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: v1Header(body),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_secrets");
  });

  it("array of empty strings = no_secrets", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: ["", ""],
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: v1Header(body),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_secrets");
  });

  it("missing both v1 and v2 headers → no_signature", () => {
    const r = verifyEasypostSignature({
      rawBody: body,
      secrets: SECRET,
      xTimestamp: null,
      xPath: null,
      xHmacSignatureV2: null,
      method: "POST",
      expectedPath: PATH,
      xHmacSignature: null,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_signature");
  });

  it("FRACTIONAL WEIGHT regression — bytes signed must be the bytes received (EP SDK #467)", () => {
    const fractional = Buffer.from(`{"weight":136.0}`, "utf8");
    const integer = Buffer.from(`{"weight":136}`, "utf8");
    const sigOverFractional = v1Header(fractional);
    expect(
      verifyEasypostSignature({
        rawBody: fractional,
        secrets: SECRET,
        xTimestamp: null,
        xPath: null,
        xHmacSignatureV2: null,
        method: "POST",
        expectedPath: PATH,
        xHmacSignature: sigOverFractional,
      }).valid,
    ).toBe(true);
    expect(
      verifyEasypostSignature({
        rawBody: integer,
        secrets: SECRET,
        xTimestamp: null,
        xPath: null,
        xHmacSignatureV2: null,
        method: "POST",
        expectedPath: PATH,
        xHmacSignature: sigOverFractional,
      }).valid,
    ).toBe(false);
  });
});
