// Phase 12 — Resend webhook signature verification tests.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyResendWebhook } from "@/lib/server/resend-webhook-signature";

const BASE64_SECRET = Buffer.from("test-secret-bytes").toString("base64");
const PREFIXED_SECRET = `whsec_${BASE64_SECRET}`;

function sign(rawBody: string, svixId: string, svixTimestamp: string): string {
  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const hmac = createHmac("sha256", Buffer.from(BASE64_SECRET, "base64"))
    .update(signed, "utf8")
    .digest("base64");
  return `v1,${hmac}`;
}

describe("verifyResendWebhook (Phase 12)", () => {
  const rawBody = `{"type":"email.bounced","data":{"email_id":"abc"}}`;
  const nowSec = () => Math.floor(Date.now() / 1000).toString();

  it("happy path with prefixed secret passes", () => {
    const ts = nowSec();
    const sig = sign(rawBody, "msg_1", ts);
    const r = verifyResendWebhook({
      rawBody,
      secret: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(true);
  });

  it("happy path with unprefixed secret also passes", () => {
    const ts = nowSec();
    const sig = sign(rawBody, "msg_2", ts);
    const r = verifyResendWebhook({
      rawBody,
      secret: BASE64_SECRET,
      svixId: "msg_2",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(true);
  });

  it("missing headers rejected", () => {
    const r = verifyResendWebhook({
      rawBody,
      secret: PREFIXED_SECRET,
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
      secret: "",
      svixId: "msg_1",
      svixTimestamp: nowSec(),
      svixSignature: sign(rawBody, "msg_1", nowSec()),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_secret");
  });

  it("replay attack outside ±5min rejected", () => {
    const oldTsSec = (Math.floor(Date.now() / 1000) - 600).toString(); // 10min ago
    const sig = sign(rawBody, "msg_1", oldTsSec);
    const r = verifyResendWebhook({
      rawBody,
      secret: PREFIXED_SECRET,
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
      secret: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: sig,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("multiple v1 entries (rotation) — any matching one passes", () => {
    const ts = nowSec();
    const valid = sign(rawBody, "msg_1", ts);
    const wrong = "v1,WRONG_SIG_VALUE_OF_SAME_LENGTH_PADDING_PADDING==";
    const combined = `${wrong} ${valid}`;
    const r = verifyResendWebhook({
      rawBody,
      secret: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: ts,
      svixSignature: combined,
    });
    expect(r.valid).toBe(true);
  });

  it("malformed signature header rejected", () => {
    const r = verifyResendWebhook({
      rawBody,
      secret: PREFIXED_SECRET,
      svixId: "msg_1",
      svixTimestamp: nowSec(),
      svixSignature: "totally_invalid",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed_signature");
  });
});
