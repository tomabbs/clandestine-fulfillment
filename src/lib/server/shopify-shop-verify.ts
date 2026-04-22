/**
 * F-5 / HRD-10 — verify the Shopify shop's canonical `myshopifyDomain`
 * after token exchange, BEFORE persisting the access token to
 * `client_store_connections`.
 *
 * Background: pre-F-5 we accepted whatever `?shop=<domain>` came in on the
 * callback URL and persisted the access token against that shop. An
 * attacker who could phish a staff member into clicking a malicious
 * install URL could plant their access token on a victim's connection row
 * — token-reuse-across-shops is a known Shopify partner-app footgun.
 *
 * The fix is to issue a one-shot Admin GraphQL `shop { myshopifyDomain }`
 * query using the freshly-issued access token, then compare the
 * NORMALIZED shop domain against the NORMALIZED callback `?shop=` value.
 * If they disagree, reject the install and emit a security review queue
 * item — repeat occurrences (same `group_key`) are a clear attack signal.
 *
 * Both sides MUST be normalized through the same `normalizeShopDomain`
 * helper so cosmetic differences (case, trailing slash, missing
 * `.myshopify.com` suffix) never cause a false negative — and so an
 * attacker can't sneak a non-canonical match past the comparator.
 */

const MYSHOPIFY_SUFFIX = ".myshopify.com";

/**
 * Canonicalize a shop domain to the form Shopify itself returns from
 * `shop { myshopifyDomain }`:
 *   - Strip any leading scheme + `//` (`https://`, `http://`)
 *   - Strip a trailing slash and any path/query/fragment
 *   - Lowercase
 *   - Append `.myshopify.com` if missing
 *
 * Returns the canonical form, OR `null` if the input is not a syntactically
 * valid hostname after stripping (e.g. empty string, contains spaces,
 * already has a non-myshopify TLD that we refuse to normalize). Callers
 * MUST treat `null` as a hard verification failure.
 */
export function normalizeShopDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;

  // Strip scheme + `//` if present.
  let s = input.trim().replace(/^https?:\/\//i, "");
  // Drop path / query / fragment (Shopify's myshopifyDomain is a bare host).
  s = s.split(/[/?#]/)[0] ?? "";
  // Normalize case once everything else is gone.
  s = s.toLowerCase();
  if (!s) return null;

  // Reject anything with whitespace or invalid hostname characters early —
  // refusing to normalize is safer than producing a fake-looking canonical
  // that an attacker tuned to slip through `equals` comparison.
  if (!/^[a-z0-9.-]+$/.test(s)) return null;

  // Append the canonical suffix if missing. Reject hostnames that already
  // have a different TLD (we won't auto-rewrite arbitrary domains).
  if (!s.endsWith(MYSHOPIFY_SUFFIX)) {
    if (s.includes(".")) {
      // Has a non-myshopify TLD — refuse rather than silently rewrite. The
      // OAuth flow only ever passes `*.myshopify.com` shops, so any other
      // domain here is a bug or an attack.
      return null;
    }
    s = `${s}${MYSHOPIFY_SUFFIX}`;
  }

  return s;
}

/**
 * Result of a shop-domain verification attempt.
 *
 * `kind === "ok"` is the only safe-to-persist state. Every other kind
 * MUST cause the caller to: (a) NOT persist the access token to the
 * connection row, (b) insert a security review queue item, (c) return
 * 401 to the OAuth callback.
 */
export type ShopVerificationResult =
  | { kind: "ok"; canonicalDomain: string }
  | { kind: "shop_param_invalid"; raw: string | null | undefined }
  | { kind: "graphql_error"; status: number; body: string }
  | { kind: "missing_shop_field"; rawResponse: string }
  | { kind: "mismatch"; expected: string; actual: string };

/**
 * Issue the one-shot `shop { myshopifyDomain }` Admin GraphQL probe and
 * compare against the normalized callback `?shop=` param.
 *
 * `apiVersion` is required (the OAuth route reads it from `env()`); we
 * intentionally pin it at the call site so a global API version bump
 * doesn't accidentally change OAuth behavior without a deliberate test
 * run.
 *
 * `fetchImpl` is injectable for unit tests — defaults to global `fetch`.
 */
export async function verifyShopDomain(args: {
  shopParam: string | null;
  accessToken: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}): Promise<ShopVerificationResult> {
  const expected = normalizeShopDomain(args.shopParam);
  if (!expected) {
    return { kind: "shop_param_invalid", raw: args.shopParam };
  }

  const fetchFn = args.fetchImpl ?? fetch;
  const url = `https://${expected}/admin/api/${args.apiVersion}/graphql.json`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": args.accessToken,
    },
    body: JSON.stringify({ query: "{ shop { myshopifyDomain } }" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { kind: "graphql_error", status: res.status, body: body.slice(0, 500) };
  }

  // We deliberately read text first so we can surface the raw response on
  // a parse failure (rare but useful for forensics).
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "missing_shop_field", rawResponse: raw.slice(0, 500) };
  }
  const remote = (parsed as { data?: { shop?: { myshopifyDomain?: string } } })?.data?.shop
    ?.myshopifyDomain;
  const actual = normalizeShopDomain(remote ?? null);
  if (!actual) {
    return { kind: "missing_shop_field", rawResponse: raw.slice(0, 500) };
  }

  if (actual !== expected) {
    return { kind: "mismatch", expected, actual };
  }

  return { kind: "ok", canonicalDomain: actual };
}
