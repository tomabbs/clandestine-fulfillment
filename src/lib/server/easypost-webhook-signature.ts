// Phase 10.2 — EasyPost webhook signature verification.
//
// EP supports two header formats:
//   x-hmac-signature       (v1) — HMAC-SHA256 hex of the raw body.
//   x-hmac-signature-v2    (v2) — `t=<unix_ts_ms>,s=<hex_signature>`. The
//                                  signed string is `<t>.<raw_body>`. Adds
//                                  replay protection via timestamp tolerance.
//
// We accept whichever the dashboard sends (v2 preferred). For v2 we also
// reject any timestamp outside the configured tolerance (default 5 min)
// to mitigate replay attacks.
//
// CRITICAL: signature is over the RAW REQUEST BODY BUFFER, not a re-stringified
// parsed body. EP Node SDK issue #467 documents fractional-weight precision
// loss after re-serialization. We always use `Buffer.from(await req.arrayBuffer())`
// at the call site so the bytes match exactly what EP signed.

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

export interface EasyPostVerifyResult {
  valid: boolean;
  reason?:
    | "no_secret"
    | "no_signature"
    | "malformed_v2_header"
    | "timestamp_outside_tolerance"
    | "signature_mismatch";
  /** Parsed timestamp from v2 header — included on success for downstream dedup. */
  timestamp?: number;
}

interface VerifyInput {
  rawBody: Buffer;
  secret: string;
  v1Header: string | null;
  v2Header: string | null;
  /** Tolerance for replay protection on v2 signatures. Default 5 min. */
  toleranceMs?: number;
  /** For testability — defaults to Date.now(). */
  now?: number;
}

export function verifyEasypostSignature({
  rawBody,
  secret,
  v1Header,
  v2Header,
  toleranceMs = DEFAULT_REPLAY_TOLERANCE_MS,
  now = Date.now(),
}: VerifyInput): EasyPostVerifyResult {
  if (!secret) return { valid: false, reason: "no_secret" };

  // Prefer v2 (timestamp + replay protection).
  if (v2Header) {
    const parsed = parseV2Header(v2Header);
    if (!parsed) return { valid: false, reason: "malformed_v2_header" };
    if (Math.abs(now - parsed.timestamp) > toleranceMs) {
      return { valid: false, reason: "timestamp_outside_tolerance", timestamp: parsed.timestamp };
    }
    const signedPayload = Buffer.concat([
      Buffer.from(`${parsed.timestamp}.`, "utf8"),
      rawBody,
    ]);
    const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
    return constantTimeOk(expected, parsed.signatureHex)
      ? { valid: true, timestamp: parsed.timestamp }
      : { valid: false, reason: "signature_mismatch", timestamp: parsed.timestamp };
  }

  if (v1Header) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return constantTimeOk(expected, v1Header.trim().toLowerCase())
      ? { valid: true }
      : { valid: false, reason: "signature_mismatch" };
  }

  return { valid: false, reason: "no_signature" };
}

/** Parse `t=<ms>,s=<hex>` (whitespace tolerant). Exposed for unit tests. */
export function parseV2Header(
  header: string,
): { timestamp: number; signatureHex: string } | null {
  const parts = header.split(",").map((p) => p.trim());
  let t: number | null = null;
  let s: string | null = null;
  for (const p of parts) {
    if (p.startsWith("t=")) {
      const n = Number.parseInt(p.slice(2), 10);
      if (Number.isFinite(n) && n > 0) t = n;
    } else if (p.startsWith("s=")) {
      s = p.slice(2).toLowerCase();
    }
  }
  if (t == null || !s || !/^[0-9a-f]+$/.test(s)) return null;
  return { timestamp: t, signatureHex: s };
}

function constantTimeOk(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
