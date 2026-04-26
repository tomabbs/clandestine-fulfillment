/**
 * Autonomous SKU matcher — remote-listing fingerprint generator.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"remote_fingerprint generation" + §"New helpers this plan introduces".
 *
 * Purpose:
 *   `remote_fingerprint` is the fourth uniqueness key on
 *   `client_store_product_identity_matches` (after variant_id,
 *   (remote_product_id, remote_variant_id), and remote_inventory_item_id).
 *   It exists for WooCommerce / Squarespace — platforms whose stable
 *   remote identifiers can shift across catalog edits. The fingerprint
 *   lets the identity writer recognize the same underlying listing even
 *   when the remote IDs have rotated.
 *
 * Design requirements (plan §"Design requirements"):
 *   * Payload runs through `sortKeysDeep()` so JSON key order is stable
 *     across Node versions and across platforms emitting fields in
 *     different orders. Required for SKU-AUTO-25 stability assertion.
 *   * Musical attributes come from `parseMusicVariantDescriptors()` —
 *     title normalization alone is not sufficient. 7" / 12" must always
 *     produce different hashes.
 *   * SHA-256 hex digest (64 chars), fits the existing `text` column.
 *   * Returns `null` when no stable remote identifier exists in any of
 *     the four slots — null rows cannot collide because the partial
 *     unique index `uq_identity_active_remote_fingerprint` excludes NULLs.
 *   * Platform union is narrowed to shopify / woocommerce / squarespace;
 *     discogs and bigcommerce are out of scope for autonomous matching
 *     per `createStoreSyncClient()` (plan "Platform scope" paragraph).
 *
 * Purity contract:
 *   No I/O, no Date.now(), no random. Same input ⇒ same hash forever.
 *   Any change to the normalization rules requires a fixture update —
 *   see `tests/unit/lib/server/remote-fingerprint.test.ts`.
 */
import { createHash } from "node:crypto";
import {
  type MusicVariantDescriptors,
  parseMusicVariantDescriptors,
} from "@/lib/server/music-variant-descriptors";

export type RemoteListingPlatform = "shopify" | "woocommerce" | "squarespace";

export interface RemoteListingInput {
  platform: RemoteListingPlatform;
  remoteSku: string | null;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
  title: string | null;
  variantOptions: Array<{ name: string; value: string }>;
}

/**
 * Recursively sort object keys so canonical JSON of the same structural
 * value is byte-identical across call sites. Arrays are preserved in
 * input order (semantics-bearing), scalars are pass-through, plain
 * objects get their keys sorted. This is the exact helper required by
 * SKU-AUTO-25: any map-iteration divergence between Node versions must
 * not produce a different hash.
 */
export function sortKeysDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeysDeep(v);
    return out as unknown as T;
  }
  return value;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Compute the SHA-256 fingerprint of a remote listing input. Returns
 * `null` when no stable remote identifier is present in any slot.
 */
export function buildRemoteFingerprint(input: RemoteListingInput): string | null {
  const remoteSku = normalizeNullableString(input.remoteSku)?.toLowerCase() ?? null;
  const remoteProductId = normalizeNullableString(input.remoteProductId);
  const remoteVariantId = normalizeNullableString(input.remoteVariantId);
  const remoteInventoryItemId = normalizeNullableString(input.remoteInventoryItemId);

  const hasAnyStable =
    remoteSku !== null ||
    remoteProductId !== null ||
    remoteVariantId !== null ||
    remoteInventoryItemId !== null;
  if (!hasAnyStable) return null;

  const descriptors: MusicVariantDescriptors = parseMusicVariantDescriptors({
    title: input.title,
    variantOptions: Array.isArray(input.variantOptions) ? input.variantOptions : [],
  });

  const payload = {
    platform: input.platform,
    remoteSku,
    remoteProductId,
    remoteVariantId,
    remoteInventoryItemId,
    descriptors,
  };

  const canonical = JSON.stringify(sortKeysDeep(payload));
  return createHash("sha256").update(canonical).digest("hex");
}
