// Phase 12 / Slice 1 — Resend webhook signature verification tests.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyResendWebhook } from "@/lib/server/resend-webhook-signature";

const BASE64_SECRET = Buffer.from("test-secret-bytes").toString("base64");
const PREFIXED_SECRET = `whsec_${BASE64_SECRET}`;
const PREVIOUS_BASE64 = Buffer.from("previous-secret-bytes").toString("base64");
const PREVIOUS_PREFIXED = `whsec_${PREVIOUS_BASE64}`;

function sign(rawBody: string, svixId: string, svixTimestamp: string, secret = BASE64_SECRET): string {
  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const hmac = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(signed, "utf8")
    .digest("base64");
  return `v1,${hmac}`;
}

describe("verifyResendWebhook (Slice 1)", () => {
  const rawBody = `{"type":"email.bounced","data":{"email_id":"abc"}}`;
  const nowSec = () => Math.floor(Date.now() / 1000).toString();

  it("happy path with prefixed secret passes", () => {
    const ts = nowSec();
    const sig = sign(rawBody, "msg_1", ts);
    const r = verifyResendWebhook({
      rawBody,
      secrets: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(true);
    expect(r.secretIndex).toBe(0);
  });

  it("happy path with unprefixed secret also passes", () => {
    const ts = nowSec();
    const sig = sign(rawBody, "msg_2", ts);
    const r = verifyResendWebhook({
      rawBody,
      secrets: BASE64_SECRET,
      svixId: "msg_2",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(true);
  });

  it("missing headers rejected", () => {
    const r = verifyResendWebhook({
      rawBody,
      secrets: PREFIXED_SECRET,
      svixId: null,
      svixTimestamp: nowSec(),
      svixSignature: "v1,xxx",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("missing_headers");
  });

  it("missing secret rejected", () => {
    const r = verifyResendWebhook({
      rawBody,
      secrets: "",
      svixId: "msg_1",
      svixTimestamp: nowSec(),
      svixSignature: sign(rawBody, "msg_1", nowSec()),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_secrets");
  });

  it("array of empty strings = no_secrets", () => {
    const r = verifyResendWebhook({
      rawBody,
      secrets: ["", ""],
      svixId: "msg_1",
      svixTimestamp: nowSec(),
      svixSignature: sign(rawBody, "msg_1", nowSec()),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_secrets");
  });

  it("replay attack outside ±5min rejected", () => {
    const oldTsSec = (Math.floor(Date.now() / 1000) - 600).toString(); // 10min ago
    const sig = sign(rawBody, "msg_1", oldTsSec);
    const r = verifyResendWebhook({
      rawBody,
      secrets: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: oldTsSec,
      svixSignature: sig,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("timestamp_outside_tolerance");
  });

  it("body-tamper rejected (signature was over original body)", () => {
    const ts = nowSec();
    const sig = sign(rawBody, "msg_1", ts);
    const r = verifyResendWebhook({
      rawBody: `${rawBody} TAMPERED`,
      secrets: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("multiple v1 entries (Svix-side rotation) — any matching one passes", () => {
    const ts = nowSec();
    const valid = sign(rawBody, "msg_1", ts);
    const wrong = "v1,WRONG_SIG_VALUE_OF_SAME_LENGTH_PADDING_PADDING==";
    const combined = `${wrong} ${valid}`;
    const r = verifyResendWebhook({
      rawBody,
      secrets: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: combined,
    });
    expect(r.valid).toBe(true);
  });

  it("malformed signature header rejected", () => {
    const r = verifyResendWebhook({
      rawBody,
      secrets: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: nowSec(),
      svixSignature: "totally_invalid",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed_signature");
  });

  it("server-side rotation: signature signed with PREVIOUS secret accepted; secretIndex=1", () => {
    const ts = nowSec();
    const sig = sign(rawBody, "msg_1", ts, PREVIOUS_BASE64);
    const r = verifyResendWebhook({
      rawBody,
      secrets: [PREFIXED_SECRET, PREVIOUS_PREFIXED],
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(true);
    expect(r.secretIndex).toBe(1);
  });
});
