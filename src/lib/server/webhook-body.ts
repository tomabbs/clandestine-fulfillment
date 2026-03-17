// Rule #58: This file is the ONE owner for webhook body parsing + HMAC verification.
// Rule #36: ALWAYS use req.text() — never req.json() then JSON.stringify().

/**
 * Read the raw body from a webhook request.
 * Must be called before any other body parsing — req.text() can only be read once.
 */
export async function readWebhookBody(req: Request): Promise<string> {
  return req.text();
}

/**
 * Verify an HMAC signature against a raw body string.
 * Uses Web Crypto API (works in Edge Runtime and Node).
 *
 * @param rawBody - The raw request body string
 * @param secret - The webhook secret key
 * @param signature - The signature from the request header
 * @param algorithm - Hash algorithm (default: SHA-256)
 */
export async function verifyHmacSignature(
  rawBody: string,
  secret: string,
  signature: string,
  algorithm: "SHA-256" | "SHA-1" = "SHA-256",
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = Buffer.from(sig).toString("base64");

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
