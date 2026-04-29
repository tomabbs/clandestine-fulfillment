/**
 * Order Pages Transition Phase 0 — shared `store_key` normalizer.
 *
 * Single owner per Rule #58 ("Every shared concern has exactly ONE
 * owner file"). Every webhook handler, poller, ingest task, and
 * `platform_order_ingest_ownership` registry lookup MUST normalize a
 * raw store identifier through this function before comparing or
 * persisting it. Drift between two normalizers (e.g. one strips a
 * trailing slash, the other doesn't) silently breaks ownership lookups
 * and lets duplicate orders through.
 *
 * The CI guard at `scripts/ci-checks/store-key-normalization.sh` greps
 * for inline normalization patterns (`.toLowerCase()` on URLs, `.replace`
 * on host strings, raw `myshopify_domain` fields written without going
 * through this helper) and fails the build.
 */

export type StoreKeyPlatform = "shopify" | "woocommerce" | "squarespace" | "bandcamp" | "manual";

/**
 * Normalize a raw platform store identifier to a canonical `store_key`.
 *
 * Rules per platform:
 *  - shopify: lowercase the bare myshopify domain ("foo-store.myshopify.com").
 *    Strip leading `https://`, `http://`, or `www.`. Strip trailing slash.
 *    Reject anything that doesn't end in `.myshopify.com`.
 *  - woocommerce: lowercase the host. Strip protocol, `www.`, trailing slash,
 *    AND any path/query/fragment. Multiple stores on the same host are
 *    NOT supported (Phase 1 follow-up; throw for now).
 *  - squarespace: same as WooCommerce.
 *  - bandcamp: lowercase the band slug — accepts a `https://<slug>.bandcamp.com`
 *    URL or a bare slug. Returns just the slug.
 *  - manual: passthrough lowercase trim.
 */
export function normalizeStoreKey(platform: StoreKeyPlatform, raw: string): string {
  if (typeof raw !== "string") {
    throw new TypeError("normalizeStoreKey: raw must be a string");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("normalizeStoreKey: raw is empty");
  }

  switch (platform) {
    case "shopify": {
      const host = stripHostScaffolding(trimmed);
      if (!host.endsWith(".myshopify.com")) {
        throw new Error(`normalizeStoreKey: shopify host must end in .myshopify.com (got ${host})`);
      }
      return host;
    }
    case "woocommerce":
    case "squarespace": {
      return stripHostScaffolding(trimmed);
    }
    case "bandcamp": {
      const lower = trimmed.toLowerCase();
      const noProtocol = lower.replace(/^https?:\/\//, "").replace(/^www\./, "");
      // Drop any path/query/fragment first so URL forms reduce to host.
      const hostOnly = noProtocol.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
      if (hostOnly.endsWith(".bandcamp.com")) {
        const slug = hostOnly.replace(/\.bandcamp\.com$/, "");
        if (!slug || /[^a-z0-9-]/.test(slug)) {
          throw new Error(`normalizeStoreKey: invalid bandcamp slug "${raw}"`);
        }
        return slug;
      }
      // Bare slug — already host-only (no `.bandcamp.com` suffix).
      if (!hostOnly || /[^a-z0-9-]/.test(hostOnly)) {
        throw new Error(`normalizeStoreKey: invalid bandcamp slug "${raw}"`);
      }
      return hostOnly;
    }
    case "manual": {
      return trimmed.toLowerCase();
    }
    default: {
      const _exhaustive: never = platform;
      void _exhaustive;
      throw new Error(`normalizeStoreKey: unsupported platform ${String(platform)}`);
    }
  }
}

function stripHostScaffolding(raw: string): string {
  let host = raw.toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  host = host.replace(/^www\./, "");
  // Drop any path/query/fragment.
  host = host.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  if (host.endsWith("/")) host = host.slice(0, -1);
  if (!host) {
    throw new Error(`normalizeStoreKey: empty host after stripping scaffolding (raw="${raw}")`);
  }
  return host;
}
