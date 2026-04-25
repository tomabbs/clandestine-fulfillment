// Phase 12 / Slice 1 — Resend webhook signature verification (Svix-compatible).
//
// Resend uses Svix under the hood. The signature header format is
// `svix-signature: v1,<base64hmac>` (multiple v1 entries separated by spaces
// when there's been a key rotation at the Svix end; we accept any matching one).
// The signed payload is `${svix-id}.${svix-timestamp}.${rawBody}`.
//
// Replay protection: reject when |now - svix-timestamp| > 5 minutes.
//
// Slice 1 — also accept an array of `secrets` so the server-side secret can
// be rotated WITHOUT relying on Svix's own dashboard rotation. The matching
// secret index is surfaced for rotation-traffic observability.

import { createHmac, timingSafeEqual } from "node:crypto";

export const RESEND_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

export type ResendVerifyReason =
  | "no_secrets"
  | "missing_headers"
  | "malformed_signature"
  | "timestamp_outside_tolerance"
  | "signature_mismatch";

export interface ResendVerifyResult {
  valid: boolean;
  reason?: ResendVerifyReason;
  timestamp?: number;
  /** Index into the input `secrets` array of the secret that matched. */
  secretIndex?: number;
}

interface VerifyInput {
  rawBody: string;
  /** Resend signing secret(s) — single string or array. May be prefixed `whsec_`. */
  secrets: string | string[];
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  toleranceMs?: number;
  now?: number;
}

export function verifyResendWebhook({
  rawBody,
  secrets,
  svixId,
  svixTimestamp,
  svixSignature,
  toleranceMs = RESEND_REPLAY_TOLERANCE_MS,
  now = Date.now(),
}: VerifyInput): ResendVerifyResult {
  const secretList = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (secretList.length === 0) return { valid: false, reason: "no_secrets" };
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { valid: false, reason: "missing_headers" };
  }
  const tsNum = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, reason: "malformed_signature" };
  }
  // svix timestamp is in SECONDS; convert to ms for comparison.
  const tsMs = tsNum * 1000;
  if (Math.abs(now - tsMs) > toleranceMs) {
    return { valid: false, reason: "timestamp_outside_tolerance", timestamp: tsMs };
  }

  // Header may carry MULTIPLE v1 entries space-separated after a SOURCE-side
  // (Svix) key rotation. Any one matching = valid.
  const candidates = svixSignature
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  if (candidates.length === 0) {
    return { valid: false, reason: "malformed_signature" };
  }

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;

  // Try each server-side secret (rotation overlap window).
  for (let secretIdx = 0; secretIdx < secretList.length; secretIdx++) {
    const secret = secretList[secretIdx];
    const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
    let secretBytes: Buffer;
    try {
      secretBytes = Buffer.from(rawSecret, "base64");
    } catch {
      continue;
    }
    const expectedB64 = createHmac("sha256", secretBytes)
      .update(signedPayload, "utf8")
      .digest("base64");
    for (const cand of candidates) {
      if (cand.length !== expectedB64.length) continue;
      if (timingSafeEqual(Buffer.from(cand, "utf8"), Buffer.from(expectedB64, "utf8"))) {
        return { valid: true, timestamp: tsMs, secretIndex: secretIdx };
      }
    }
  }

  return { valid: false, reason: "signature_mismatch", timestamp: tsMs };
}
