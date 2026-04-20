// Phase 12 — Public tracking token helper.
//
// Generates a 22-char URL-safe random token (128 bits of entropy) used as
// the path segment in /track/[token]. Server-side only; never derived from
// shipment_id or tracking_number to keep the token unguessable.
//
// `crypto.randomBytes(16).toString('base64url')` → 22 chars, no padding.
//
// This module is also the place to put any future hashing / rotation logic.
// For now it's deliberately tiny and pure.

import { randomBytes } from "node:crypto";

/** 16 random bytes encoded as URL-safe base64 (no padding) → 22 chars. */
export function generatePublicTrackToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Build the absolute customer-facing tracking URL for a shipment token.
 * The host is read from env so we can run staging/prod cleanly.
 */
export function buildPublicTrackUrl(token: string, host: string): string {
  const safeHost = host.replace(/\/+$/, "");
  return `${safeHost}/track/${token}`;
}
