import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWooWebhookSignature } from "@/lib/server/webhook-body";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyWooWebhookSignature", () => {
  it("accepts the current secret", async () => {
    const body = JSON.stringify({ id: 123 });
    await expect(
      verifyWooWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body, "current"),
        currentSecret: "current",
      }),
    ).resolves.toEqual({ ok: true, matchedSecret: "current" });
  });

  it("accepts a non-expired previous secret for rotation", async () => {
    const body = JSON.stringify({ id: 123 });
    await expect(
      verifyWooWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body, "previous"),
        currentSecret: "current",
        previousSecret: "previous",
        previousSecretExpiresAt: "2026-04-29T00:00:00.000Z",
        now: new Date("2026-04-28T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ ok: true, matchedSecret: "previous" });
  });

  it("rejects unsigned, malformed, and mismatched signatures", async () => {
    await expect(
      verifyWooWebhookSignature({
        rawBody: "{}",
        signatureHeader: null,
        currentSecret: "secret",
      }),
    ).resolves.toEqual({ ok: false, reason: "no_signature" });

    await expect(
      verifyWooWebhookSignature({
        rawBody: "{}",
        signatureHeader: "not base64!!!",
        currentSecret: "secret",
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed_signature" });

    await expect(
      verifyWooWebhookSignature({
        rawBody: "{}",
        signatureHeader: sign("different", "secret"),
        currentSecret: "secret",
      }),
    ).resolves.toEqual({ ok: false, reason: "signature_mismatch" });
  });
});
