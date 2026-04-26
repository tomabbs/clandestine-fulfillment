// Phase 10.2 / Slice 1 — EasyPost webhook signature verification.
//
// EasyPost serves TWO concurrent signing schemes (both verified against the
// official EasyPost SDKs and the EasyPost Support article on Webhook HMAC
// Validation as of 2026-04):
//
//   v2 (preferred — replay-protected):
//     headers:
//       x-timestamp:           RFC 2822 timestamp string
//       x-path:                request path used in the signature calculation
//       x-hmac-signature-v2:   "hmac-sha256-hex=<lowercase hex>"
//     string-to-sign:
//       `${xTimestamp}${method.toUpperCase()}${xPath}${rawBody}`
//       (concatenation, no delimiters)
//
//   v1 (legacy — still emitted by EP's Python/Go SDK validate_webhook):
//     headers:
//       x-hmac-signature:      "hmac-sha256-hex=<lowercase hex>"
//     string-to-sign:
//       `${rawBody}`
//     NOTE: EP's official SDKs NFKD-normalize the secret before signing.
//     We mirror that to stay compatible.
//
// Verification accepts an array of secrets so two can be live during
// rotation (`current` + `previous`); on success the matching secret index
// is returned for rotation-traffic observability.
//
// CRITICAL invariants:
//   - rawBody MUST be the original request bytes (Buffer / Uint8Array). Never
//     re-stringify a parsed JSON object — EP's SDKs surface a `weight` field
//     as a fractional number that loses precision after re-serialization
//     (EP Node SDK issue #467). The route handler must read raw bytes BEFORE
//     parsing.
//   - All hex/base64 comparisons go through `crypto.timingSafeEqual` after
//     an explicit equal-length-buffer guard (timingSafeEqual throws on
//     length mismatch).
//   - Headers are case-insensitive but normalized to lowercase here.
//   - x-path comparison normalizes trailing slashes / query strings; HMAC
//     computation always uses the raw `x-path` header value as received.

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_PAST_TOLERANCE_MS = 5 * 60 * 1000; // 300s
export const DEFAULT_FUTURE_TOLERANCE_MS = 30 * 1000; // 30s

export type EasyPostVerifyReason =
  | "no_secrets"
  | "no_signature"
  | "missing_x_timestamp"
  | "missing_x_path"
  | "missing_x_hmac_signature_v2"
  | "invalid_v2_signature_prefix"
  | "invalid_v1_signature_prefix"
  | "invalid_timestamp_format"
  | "timestamp_too_old"
  | "timestamp_too_future"
  | "path_mismatch"
  | "signature_mismatch";

export interface EasyPostVerifyResult {
  valid: boolean;
  reason?: EasyPostVerifyReason;
  /** Parsed timestamp (epoch ms) from x-timestamp on success. */
  timestamp?: number;
  /** Index into the input `secrets` array of the secret that matched. */
  secretIndex?: number;
  /** Which signing variant matched. */
  variant?: "v2" | "v1";
}

interface VerifyInput {
  rawBody: Buffer;
  /** Single secret OR array for rotation overlap. Empty array = fail-closed. */
  secrets: string | string[];
  /** v2 inputs */
  xTimestamp: string | null;
  xPath: string | null;
  xHmacSignatureV2: string | null;
  method: string;
  /** Expected pathname, e.g. '/api/webhooks/easypost'. Used for path-mismatch detection only — HMAC always uses the raw x-path header bytes. */
  expectedPath: string;
  /** v1 fallback */
  xHmacSignature: string | null;
  /** Past tolerance for v2 timestamps (default 300s). */
  pastToleranceMs?: number;
  /** Future tolerance for v2 timestamps (default 30s). */
  futureToleranceMs?: number;
  /** For testability — defaults to Date.now(). */
  now?: number;
  /** When false, the v1 `x-hmac-signature` header is not accepted. EP SDKs still emit v1, so default true. */
  allowV1Fallback?: boolean;
}

const HMAC_PREFIX = "hmac-sha256-hex=";

export function verifyEasypostSignature(input: VerifyInput): EasyPostVerifyResult {
  const secrets = Array.isArray(input.secrets) ? input.secrets : [input.secrets];
  const liveSecrets = secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (liveSecrets.length === 0) return { valid: false, reason: "no_secrets" };

  const now = input.now ?? Date.now();
  const pastTolerance = input.pastToleranceMs ?? DEFAULT_PAST_TOLERANCE_MS;
  const futureTolerance = input.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS;
  const allowV1 = input.allowV1Fallback ?? true;

  if (input.xHmacSignatureV2) {
    return verifyV2({
      rawBody: input.rawBody,
      secrets: liveSecrets,
      xTimestamp: input.xTimestamp,
      xPath: input.xPath,
      xHmacSignatureV2: input.xHmacSignatureV2,
      method: input.method,
      expectedPath: input.expectedPath,
      pastTolerance,
      futureTolerance,
      now,
    });
  }

  if (allowV1 && input.xHmacSignature) {
    return verifyV1({
      rawBody: input.rawBody,
      secrets: liveSecrets,
      xHmacSignature: input.xHmacSignature,
    });
  }

  return { valid: false, reason: "no_signature" };
}

interface V2Args {
  rawBody: Buffer;
  secrets: string[];
  xTimestamp: string | null;
  xPath: string | null;
  xHmacSignatureV2: string;
  method: string;
  expectedPath: string;
  pastTolerance: number;
  futureTolerance: number;
  now: number;
}

function verifyV2(args: V2Args): EasyPostVerifyResult {
  if (!args.xTimestamp) return { valid: false, reason: "missing_x_timestamp" };
  if (!args.xPath) return { valid: false, reason: "missing_x_path" };

  const ts = Date.parse(args.xTimestamp);
  if (Number.isNaN(ts)) return { valid: false, reason: "invalid_timestamp_format" };

  const ageMs = args.now - ts;
  if (ageMs > args.pastTolerance) {
    return { valid: false, reason: "timestamp_too_old", timestamp: ts };
  }
  if (ageMs < -args.futureTolerance) {
    return { valid: false, reason: "timestamp_too_future", timestamp: ts };
  }

  if (normalizePath(args.xPath) !== normalizePath(args.expectedPath)) {
    return { valid: false, reason: "path_mismatch", timestamp: ts };
  }

  const headerValue = args.xHmacSignatureV2.trim().toLowerCase();
  if (!headerValue.startsWith(HMAC_PREFIX)) {
    return { valid: false, reason: "invalid_v2_signature_prefix", timestamp: ts };
  }
  const providedHex = headerValue.slice(HMAC_PREFIX.length);
  if (!/^[0-9a-f]+$/.test(providedHex)) {
    return { valid: false, reason: "invalid_v2_signature_prefix", timestamp: ts };
  }

  // String-to-sign: xTimestamp + method (uppercase) + xPath (raw header value) + rawBody
  // NB: HMAC uses the raw `x-path` header bytes as received, NOT the
  // normalized form. Normalization is only for the path-mismatch check.
  const prefix = Buffer.from(`${args.xTimestamp}${args.method.toUpperCase()}${args.xPath}`, "utf8");
  const signedPayload = Buffer.concat([prefix, args.rawBody]);

  for (let i = 0; i < args.secrets.length; i++) {
    const secret = nfkdNormalize(args.secrets[i]);
    const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
    if (constantTimeOk(expected, providedHex)) {
      return { valid: true, variant: "v2", secretIndex: i, timestamp: ts };
    }
  }

  return { valid: false, reason: "signature_mismatch", timestamp: ts };
}

interface V1Args {
  rawBody: Buffer;
  secrets: string[];
  xHmacSignature: string;
}

function verifyV1(args: V1Args): EasyPostVerifyResult {
  const headerValue = args.xHmacSignature.trim().toLowerCase();
  if (!headerValue.startsWith(HMAC_PREFIX)) {
    return { valid: false, reason: "invalid_v1_signature_prefix" };
  }
  const providedHex = headerValue.slice(HMAC_PREFIX.length);
  if (!/^[0-9a-f]+$/.test(providedHex)) {
    return { valid: false, reason: "invalid_v1_signature_prefix" };
  }

  for (let i = 0; i < args.secrets.length; i++) {
    const secret = nfkdNormalize(args.secrets[i]);
    const expected = createHmac("sha256", secret).update(args.rawBody).digest("hex");
    if (constantTimeOk(expected, providedHex)) {
      return { valid: true, variant: "v1", secretIndex: i };
    }
  }

  return { valid: false, reason: "signature_mismatch" };
}

/**
 * Normalize a path for the path-mismatch check. Allows trailing-slash and
 * query-string proxy quirks while still rejecting outright path
 * substitution attacks.
 *
 * Examples:
 *   "/api/webhooks/easypost"   -> "/api/webhooks/easypost"
 *   "/api/webhooks/easypost/"  -> "/api/webhooks/easypost"
 *   "/api/webhooks/easypost?x" -> "/api/webhooks/easypost"
 *   "https://h/p/x?y"          -> "/p/x"
 */
export function normalizePath(value: string): string {
  let pathname: string;
  try {
    pathname = new URL(value, "https://placeholder.invalid").pathname;
  } catch {
    pathname = value;
  }
  // Strip trailing slashes (but never reduce '/' to '').
  while (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

function constantTimeOk(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Mirror EasyPost SDK Unicode normalization (NFKD). Required for parity. */
function nfkdNormalize(value: string): string {
  return value.normalize("NFKD");
}
