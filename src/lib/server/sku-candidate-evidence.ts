/**
 * PURE candidate-evidence builder + gate classifier for the autonomous
 * SKU matcher. This is the replacement for the old "single weighted
 * score" shape: evidence is structured, gates are explicit, and the
 * outcome state is derived from the gate combination — not from a
 * floating-point total that can be gamed.
 *
 * Plan references:
 *   - §1691–1740 "Split the ranking engine into structured evidence
 *     with policy gates, not a single score." Pins CandidateEvidence
 *     shape, the gate sequence (identity → variant → operational),
 *     and outcome mapping (§1737).
 *   - §1759–1769 "Hard disqualifiers, not penalties." Pins
 *     `exactSkuSafe`, duplicate-remote rejection, placeholder
 *     rejection for live-alias promotion.
 *   - §2149 / §2150 Phase 2 build steps: add
 *     `src/lib/server/sku-candidate-evidence.ts`, extend
 *     `rankSkuCandidates()` to emit `CandidateEvidence`.
 *
 * What lives here (all PURE — no I/O, no Date.now, no random):
 *   - DisqualifierCode enum
 *   - CandidateEvidence type
 *   - buildCandidateEvidence(input) — construct the evidence struct
 *   - classifyEvidenceGates(evidence) — identity/variant/operational
 *     pass/fail
 *   - selectOutcomeFromGates(gates) — pick the outcome state per §1737
 *
 * What does NOT live here:
 *   - The existing `rankSkuCandidates()` score still runs alongside
 *     as a tiebreaker within a gate class. The existing function in
 *     `src/lib/server/sku-matching.ts` is intentionally NOT modified
 *     in this slice to keep the blast radius small. The Phase 2
 *     wiring-up slice will add an optional `evidence: CandidateEvidence`
 *     field to `RankedSkuCandidate` and have the ranker call
 *     `buildCandidateEvidence()` per candidate. Existing callers stay
 *     source-compatible either way.
 */

import {
  type MusicFormat,
  type MusicVariantDescriptors,
  parseMusicVariantDescriptors,
} from "@/lib/server/music-variant-descriptors";
import type { StockSignal, StockTier } from "@/lib/server/stock-reliability";
import { isPlaceholderSku, normalizeBarcode, normalizeSku } from "@/lib/shared/utils";

/**
 * Every reason the gate classifier may record on a candidate.
 *
 * Naming convention:
 *   - `identity_*`: identity gate cannot pass (exact-sku unsafe,
 *     verified-id missing, etc). A candidate with only identity
 *     disqualifiers may still produce `auto_shadow_identity_match`
 *     or `auto_holdout_for_evidence`.
 *   - `variant_*`: descriptors DISAGREE in a way that makes a live
 *     alias unsafe (format mismatch, color mismatch, size mismatch).
 *     Variant disqualifiers do NOT fire for `"unknown"` descriptors
 *     on either side — insufficient evidence is not disagreement.
 *   - `operational_*`: warehouse/remote stock does not meet the live-
 *     alias requirements (non-positive, non-authoritative tier,
 *     Shopify default location not stocked).
 *   - `negative_*`: hard disqualifiers per §1759–1769 — placeholder
 *     SKU, duplicate, non-operational row, generic title. These
 *     cannot be overcome by any amount of positive evidence.
 */
export type DisqualifierCode =
  | "identity_exact_sku_not_safe"
  | "identity_no_verified_signal"
  | "variant_format_disagrees"
  | "variant_size_disagrees"
  | "variant_color_disagrees"
  | "variant_edition_disagrees"
  | "variant_preorder_disagrees"
  | "variant_bundle_disagrees"
  | "variant_signed_disagrees"
  | "operational_no_positive_warehouse_stock"
  | "operational_non_authoritative_warehouse_tier"
  | "operational_shopify_default_location_missing"
  | "negative_placeholder_sku"
  | "negative_generic_title"
  | "negative_non_operational_row"
  | "negative_duplicate_sku"
  | "negative_duplicate_remote";

/**
 * Structured evidence for a single (canonical, remote) pair. Every
 * field is either a boolean (definitively true/false) or a booleanish
 * + "unknown" tri-state. Numbers and strings appear only in
 * `operational` and on `remoteObservedAt`.
 *
 * Why tri-state on variant: plan §1735 explicitly distinguishes
 * "disagrees" (gate fails) from "unknown" (insufficient evidence,
 * gate neutral). A missing descriptor on either side is "unknown", not
 * "false".
 */
export interface CandidateEvidence {
  readonly identity: {
    readonly exactSku: boolean;
    readonly exactSkuSafe: boolean;
    readonly exactBarcode: boolean;
    readonly verifiedRemoteId: boolean;
    readonly verifiedBandcampOption: boolean;
    readonly priorSafeMapping: boolean;
  };
  readonly variant: {
    readonly formatAgrees: boolean | "unknown";
    readonly sizeAgrees: boolean | "unknown";
    readonly colorAgrees: boolean | "unknown";
    readonly editionAgrees: boolean | "unknown";
    readonly preorderAgrees: boolean | "unknown";
    readonly bundleAgrees: boolean | "unknown";
    readonly signedAgrees: boolean | "unknown";
    readonly descriptorDisqualifiers: ReadonlyArray<DisqualifierCode>;
  };
  readonly operational: {
    readonly warehouseAvailable: number | null;
    readonly warehouseStockTier: StockTier;
    readonly remoteAvailable: number | null;
    readonly remoteStockTier: StockTier;
    readonly remoteObservedAt: string | null;
    readonly stockedAtDefaultLocation: boolean | null;
  };
  readonly negative: {
    readonly placeholderSku: boolean;
    readonly genericTitle: boolean;
    readonly nonOperationalRow: boolean;
    readonly duplicateSku: boolean;
    readonly duplicateRemote: boolean;
  };
}

export interface BuildCandidateEvidenceInput {
  readonly canonical: {
    readonly sku: string | null;
    readonly barcode: string | null;
    readonly descriptors: MusicVariantDescriptors | null;
    readonly priorMappingId?: string | null;
  };
  readonly remote: {
    readonly sku: string | null;
    readonly barcode: string | null;
    readonly combinedTitle: string | null;
    readonly descriptors: MusicVariantDescriptors | null;
    readonly platform: "shopify" | "woocommerce" | "squarespace";
  };
  readonly identitySignals?: {
    readonly verifiedRemoteId?: boolean;
    readonly verifiedBandcampOption?: boolean;
    readonly canonicalSkuUniqueWithinOrg?: boolean;
    readonly remoteSkuUniqueWithinConnection?: boolean;
  };
  readonly operationalSignals?: {
    readonly warehouseStock?: StockSignal | null;
    readonly remoteStock?: StockSignal | null;
    readonly stockedAtDefaultLocation?: boolean | null;
  };
  readonly negativeSignals?: {
    readonly genericTitle?: boolean;
    readonly nonOperationalRow?: boolean;
    readonly duplicateCanonicalSku?: boolean;
    readonly duplicateRemote?: boolean;
  };
}

/**
 * Construct a fully-populated CandidateEvidence record from typed
 * inputs. PURE: same input → same output.
 *
 * Descriptor comparison semantics:
 *   - If EITHER descriptor is null, every variant field is `"unknown"`
 *     and no `variant_*_disagrees` codes fire. The caller was unable
 *     to parse descriptors for this pair and we cannot claim
 *     disagreement.
 *   - If both descriptors are non-null, each slot is compared:
 *     - Both sides explicitly match (including both falsy booleans)
 *       → true
 *     - One side is `null`/`"unknown"` → `"unknown"` (no disqualifier)
 *     - Both sides present AND different → false + corresponding
 *       `variant_*_disagrees` code in `descriptorDisqualifiers`
 */
export function buildCandidateEvidence(input: BuildCandidateEvidenceInput): CandidateEvidence {
  const normalizedCanonicalSku = normalizeSku(input.canonical.sku);
  const normalizedRemoteSku = normalizeSku(input.remote.sku);
  const normalizedCanonicalBarcode = normalizeBarcode(input.canonical.barcode);
  const normalizedRemoteBarcode = normalizeBarcode(input.remote.barcode);

  const exactSku =
    normalizedCanonicalSku !== null &&
    normalizedRemoteSku !== null &&
    normalizedCanonicalSku === normalizedRemoteSku;

  const exactBarcode =
    normalizedCanonicalBarcode !== null &&
    normalizedRemoteBarcode !== null &&
    normalizedCanonicalBarcode === normalizedRemoteBarcode;

  const placeholderRemote = isPlaceholderSku(input.remote.sku);
  const placeholderCanonical = isPlaceholderSku(input.canonical.sku);
  const placeholderSku = placeholderRemote || placeholderCanonical;

  const canonicalUnique = input.identitySignals?.canonicalSkuUniqueWithinOrg ?? false;
  const remoteUnique = input.identitySignals?.remoteSkuUniqueWithinConnection ?? false;
  const exactSkuSafe = exactSku && canonicalUnique && remoteUnique && !placeholderSku;

  const variantResult = compareDescriptors(
    input.canonical.descriptors ?? null,
    input.remote.descriptors ?? null,
  );

  const warehouseSignal = input.operationalSignals?.warehouseStock ?? null;
  const remoteSignal = input.operationalSignals?.remoteStock ?? null;

  return {
    identity: {
      exactSku,
      exactSkuSafe,
      exactBarcode,
      verifiedRemoteId: input.identitySignals?.verifiedRemoteId ?? false,
      verifiedBandcampOption: input.identitySignals?.verifiedBandcampOption ?? false,
      priorSafeMapping:
        typeof input.canonical.priorMappingId === "string" &&
        input.canonical.priorMappingId.length > 0,
    },
    variant: variantResult,
    operational: {
      warehouseAvailable: typeof warehouseSignal?.value === "number" ? warehouseSignal.value : null,
      warehouseStockTier: warehouseSignal?.tier ?? "unknown",
      remoteAvailable: typeof remoteSignal?.value === "number" ? remoteSignal.value : null,
      remoteStockTier: remoteSignal?.tier ?? "unknown",
      remoteObservedAt: remoteSignal?.observedAt ?? null,
      stockedAtDefaultLocation: input.operationalSignals?.stockedAtDefaultLocation ?? null,
    },
    negative: {
      placeholderSku,
      genericTitle: input.negativeSignals?.genericTitle ?? false,
      nonOperationalRow: input.negativeSignals?.nonOperationalRow ?? false,
      duplicateSku: input.negativeSignals?.duplicateCanonicalSku ?? false,
      duplicateRemote: input.negativeSignals?.duplicateRemote ?? false,
    },
  };
}

/**
 * Convenience: parse raw titles into MusicVariantDescriptors via
 * `parseMusicVariantDescriptors` and then call `buildCandidateEvidence`.
 * Handy when the caller has titles but not parsed descriptors.
 */
export function buildCandidateEvidenceFromTitles(
  input: Omit<BuildCandidateEvidenceInput, "canonical" | "remote"> & {
    canonical: Omit<BuildCandidateEvidenceInput["canonical"], "descriptors"> & {
      title: string | null;
      variantTitle?: string | null;
    };
    remote: Omit<BuildCandidateEvidenceInput["remote"], "descriptors"> & {
      title: string | null;
      variantTitle?: string | null;
    };
  },
): CandidateEvidence {
  const canonicalDescriptors = parseMusicVariantDescriptors({
    title: [input.canonical.title, input.canonical.variantTitle].filter(Boolean).join(" - "),
  });
  const remoteDescriptors = parseMusicVariantDescriptors({
    title: [input.remote.title, input.remote.variantTitle].filter(Boolean).join(" - "),
  });
  return buildCandidateEvidence({
    ...input,
    canonical: { ...input.canonical, descriptors: canonicalDescriptors },
    remote: { ...input.remote, descriptors: remoteDescriptors },
  });
}

/**
 * Compare two parsed descriptor ASTs into the per-slot agreement shape.
 *
 * Tri-state rule:
 *   - both present AND equal → true
 *   - either side missing/unknown → "unknown" (NO disqualifier)
 *   - both present AND different → false (disqualifier code emitted)
 */
function compareDescriptors(
  canonical: MusicVariantDescriptors | null,
  remote: MusicVariantDescriptors | null,
): CandidateEvidence["variant"] {
  if (!canonical || !remote) {
    return {
      formatAgrees: "unknown",
      sizeAgrees: "unknown",
      colorAgrees: "unknown",
      editionAgrees: "unknown",
      preorderAgrees: "unknown",
      bundleAgrees: "unknown",
      signedAgrees: "unknown",
      descriptorDisqualifiers: [],
    };
  }

  const disqualifiers: DisqualifierCode[] = [];

  const formatAgrees = compareFormat(canonical.format, remote.format);
  if (formatAgrees === false) disqualifiers.push("variant_format_disagrees");

  const sizeAgrees = compareOptionalString(canonical.size, remote.size);
  if (sizeAgrees === false) disqualifiers.push("variant_size_disagrees");

  const colorAgrees = compareOptionalString(canonical.color, remote.color);
  if (colorAgrees === false) disqualifiers.push("variant_color_disagrees");

  const editionAgrees = compareOptionalString(canonical.edition, remote.edition);
  if (editionAgrees === false) disqualifiers.push("variant_edition_disagrees");

  const preorderAgrees = compareBoolean(canonical.preorder, remote.preorder);
  if (preorderAgrees === false) disqualifiers.push("variant_preorder_disagrees");

  const bundleAgrees = compareBoolean(canonical.bundle, remote.bundle);
  if (bundleAgrees === false) disqualifiers.push("variant_bundle_disagrees");

  const signedAgrees = compareBoolean(canonical.signed, remote.signed);
  if (signedAgrees === false) disqualifiers.push("variant_signed_disagrees");

  return {
    formatAgrees,
    sizeAgrees,
    colorAgrees,
    editionAgrees,
    preorderAgrees,
    bundleAgrees,
    signedAgrees,
    descriptorDisqualifiers: disqualifiers,
  };
}

function compareFormat(a: MusicFormat, b: MusicFormat): boolean | "unknown" {
  if (a === "unknown" || b === "unknown") return "unknown";
  return a === b;
}

function compareOptionalString(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean | "unknown" {
  if (a === null || a === undefined || a === "") return "unknown";
  if (b === null || b === undefined || b === "") return "unknown";
  return a.toLowerCase() === b.toLowerCase();
}

function compareBoolean(a: boolean | undefined, b: boolean | undefined): boolean | "unknown" {
  if (a === undefined || b === undefined) return "unknown";
  return a === b;
}

/**
 * The three gate results + a rolled-up overall classification.
 *
 * Overall values:
 *   - `pass`: every gate passes; the candidate is eligible for
 *     `auto_live_inventory_alias` (still subject to outside
 *     safeguards like kill switch / emergency pause).
 *   - `identity_only`: identity + variant pass, operational fails
 *     only on warehouse stock (not on tier/default location). Maps
 *     to `auto_database_identity_match`.
 *   - `stock_exception`: identity + variant pass, warehouse ATP is
 *     zero, remote has positive stock. Maps to `client_stock_exception`.
 *   - `shadow_identity`: identity passes, variant agreement is
 *     partial (has `"unknown"` but no `false`). Maps to
 *     `auto_shadow_identity_match`.
 *   - `holdout`: identity partially passes (some evidence but not
 *     enough to promote). Maps to `auto_holdout_for_evidence`.
 *   - `reject`: the candidate violates a hard negative (placeholder,
 *     duplicate, non-operational row) OR the variant gate has at
 *     least one disagreement. Maps to `auto_reject_non_match`.
 *
 * This enum drives the outcome_state column on the identity row.
 */
export type EvidenceOverall =
  | "pass"
  | "identity_only"
  | "stock_exception"
  | "shadow_identity"
  | "holdout"
  | "reject";

export interface EvidenceGateResult {
  readonly identity: "pass" | "partial" | "fail";
  readonly variant: "pass" | "partial" | "fail";
  readonly operational: "pass" | "fail_stock_only" | "fail_stock_exception" | "fail_other";
  readonly overall: EvidenceOverall;
  readonly disqualifiers: ReadonlyArray<DisqualifierCode>;
}

export interface ClassifyEvidenceGatesOptions {
  /**
   * When true, Shopify candidates require
   * `stockedAtDefaultLocation === true` at the operational gate (per
   * plan §1736). Default true. Woo/Squarespace always pass that
   * sub-check regardless of this flag because they don't expose a
   * default-location concept.
   */
  readonly enforceShopifyDefaultLocation?: boolean;
  /** Defaults to 'shopify' if unspecified — the strictest policy. */
  readonly platform?: "shopify" | "woocommerce" | "squarespace";
}

/**
 * Evaluate the three gates in plan-order and roll up an outcome.
 *
 * Gate sequence per plan §1732–1737:
 *   1. Hard negatives → `overall: 'reject'` immediately. Placeholder
 *      SKU, duplicate SKU, duplicate remote listing, and
 *      non-operational rows are never promotable.
 *   2. Identity gate passes if ANY of:
 *        - `exactSku && exactSkuSafe`
 *        - `exactBarcode`
 *        - `verifiedRemoteId`
 *        - `verifiedBandcampOption`
 *        - `priorSafeMapping`
 *      Partial pass if exactSku holds but is not safe (still
 *      evidence, just not promotable).
 *   3. Variant gate passes if `descriptorDisqualifiers` is empty AND
 *      no descriptor is `false`. Partial pass if some descriptors are
 *      `"unknown"` but none are `false`.
 *   4. Operational gate passes if warehouse ATP is positive AND tier
 *      is 'authoritative' AND (for Shopify) the default location is
 *      stocked. Otherwise the caller sees which branch failed:
 *        - `fail_stock_only`: tier is authoritative and default
 *          location OK, but ATP is zero. Candidate becomes
 *          `identity_only` (mapped to `auto_database_identity_match`).
 *        - `fail_stock_exception`: same as above AND remote stock is
 *          positive. Mapped to `client_stock_exception`.
 *        - `fail_other`: tier non-authoritative, default location
 *          missing, or any other operational blocker.
 */
export function classifyEvidenceGates(
  evidence: CandidateEvidence,
  options: ClassifyEvidenceGatesOptions = {},
): EvidenceGateResult {
  const platform = options.platform ?? "shopify";
  const enforceDefaultLocation =
    platform === "shopify" && options.enforceShopifyDefaultLocation !== false;

  const disqualifiers: DisqualifierCode[] = [];

  const hasHardNegative =
    evidence.negative.placeholderSku ||
    evidence.negative.duplicateSku ||
    evidence.negative.duplicateRemote ||
    evidence.negative.nonOperationalRow;
  if (evidence.negative.placeholderSku) disqualifiers.push("negative_placeholder_sku");
  if (evidence.negative.duplicateSku) disqualifiers.push("negative_duplicate_sku");
  if (evidence.negative.duplicateRemote) disqualifiers.push("negative_duplicate_remote");
  if (evidence.negative.nonOperationalRow) disqualifiers.push("negative_non_operational_row");
  if (evidence.negative.genericTitle) disqualifiers.push("negative_generic_title");

  const identityDecision = classifyIdentity(evidence, disqualifiers);
  const variantDecision = classifyVariant(evidence, disqualifiers);
  const operationalDecision = classifyOperational(evidence, disqualifiers, enforceDefaultLocation);

  if (hasHardNegative) {
    return {
      identity: identityDecision,
      variant: variantDecision,
      operational: operationalDecision,
      overall: "reject",
      disqualifiers,
    };
  }

  if (variantDecision === "fail") {
    return {
      identity: identityDecision,
      variant: variantDecision,
      operational: operationalDecision,
      overall: "reject",
      disqualifiers,
    };
  }

  if (identityDecision === "fail") {
    return {
      identity: identityDecision,
      variant: variantDecision,
      operational: operationalDecision,
      overall: "reject",
      disqualifiers,
    };
  }

  const overall = computeOverall(identityDecision, variantDecision, operationalDecision);

  return {
    identity: identityDecision,
    variant: variantDecision,
    operational: operationalDecision,
    overall,
    disqualifiers,
  };
}

function classifyIdentity(
  evidence: CandidateEvidence,
  disqualifiers: DisqualifierCode[],
): "pass" | "partial" | "fail" {
  const strong =
    (evidence.identity.exactSku && evidence.identity.exactSkuSafe) ||
    evidence.identity.exactBarcode ||
    evidence.identity.verifiedRemoteId ||
    evidence.identity.verifiedBandcampOption ||
    evidence.identity.priorSafeMapping;
  if (strong) return "pass";

  if (evidence.identity.exactSku && !evidence.identity.exactSkuSafe) {
    disqualifiers.push("identity_exact_sku_not_safe");
    return "partial";
  }

  disqualifiers.push("identity_no_verified_signal");
  return "fail";
}

function classifyVariant(
  evidence: CandidateEvidence,
  disqualifiers: DisqualifierCode[],
): "pass" | "partial" | "fail" {
  if (evidence.variant.descriptorDisqualifiers.length > 0) {
    for (const code of evidence.variant.descriptorDisqualifiers) disqualifiers.push(code);
    return "fail";
  }
  const slots: Array<boolean | "unknown"> = [
    evidence.variant.formatAgrees,
    evidence.variant.sizeAgrees,
    evidence.variant.colorAgrees,
    evidence.variant.editionAgrees,
    evidence.variant.preorderAgrees,
    evidence.variant.bundleAgrees,
    evidence.variant.signedAgrees,
  ];
  if (slots.some((s) => s === false)) return "fail";
  if (slots.every((s) => s === true)) return "pass";
  return "partial";
}

function classifyOperational(
  evidence: CandidateEvidence,
  disqualifiers: DisqualifierCode[],
  enforceDefaultLocation: boolean,
): EvidenceGateResult["operational"] {
  const warehousePositive =
    typeof evidence.operational.warehouseAvailable === "number" &&
    evidence.operational.warehouseAvailable > 0;
  const tierAuthoritative = evidence.operational.warehouseStockTier === "authoritative";
  const defaultLocationOk =
    !enforceDefaultLocation || evidence.operational.stockedAtDefaultLocation === true;

  if (!tierAuthoritative) {
    disqualifiers.push("operational_non_authoritative_warehouse_tier");
    return "fail_other";
  }
  if (!defaultLocationOk) {
    disqualifiers.push("operational_shopify_default_location_missing");
    return "fail_other";
  }
  if (warehousePositive) return "pass";

  disqualifiers.push("operational_no_positive_warehouse_stock");
  const remotePositive =
    typeof evidence.operational.remoteAvailable === "number" &&
    evidence.operational.remoteAvailable > 0;
  const remoteUnbounded = evidence.operational.remoteStockTier === "fresh_remote_unbounded";
  if (remotePositive || remoteUnbounded) return "fail_stock_exception";
  return "fail_stock_only";
}

function computeOverall(
  identity: "pass" | "partial" | "fail",
  variant: "pass" | "partial" | "fail",
  operational: EvidenceGateResult["operational"],
): EvidenceOverall {
  if (identity === "pass" && variant === "pass" && operational === "pass") return "pass";

  if (identity === "pass" && variant === "pass") {
    if (operational === "fail_stock_exception") return "stock_exception";
    if (operational === "fail_stock_only") return "identity_only";
    return "shadow_identity";
  }

  if (identity === "pass" && variant === "partial") return "shadow_identity";

  return "holdout";
}

/**
 * The DB-level `outcome_state` values this plan writes to
 * `client_store_product_identity_matches`. Matches migration
 * 20260428000001_sku_autonomous_matching_phase0.sql CHECK constraint.
 */
export type IdentityOutcomeState =
  | "auto_database_identity_match"
  | "auto_shadow_identity_match"
  | "auto_holdout_for_evidence"
  | "auto_reject_non_match"
  | "auto_skip_non_operational"
  | "fetch_incomplete_holdout"
  | "client_stock_exception";

/**
 * Map a gate-classified overall result into the DB outcome state
 * string. `auto_live_inventory_alias` is intentionally NOT returned
 * here — live-alias promotion lives on `client_store_sku_mappings`
 * and is written ONLY by `promote_identity_match_to_alias()`
 * (plan Option B isolation, enforced by migration
 * 20260428000002_sku_autonomous_matching_phase1_rpc.sql).
 *
 * Caller pattern:
 *   - overall='pass' → run `promote_identity_match_to_alias()`; this
 *     function returns `auto_database_identity_match` for the
 *     identity-row bookkeeping so the identity row stays consistent
 *     with the alias creation.
 *   - any other overall → use the returned state directly as the
 *     `p_to_state` in `apply_sku_outcome_transition()`.
 */
export function selectOutcomeFromGates(
  gates: EvidenceGateResult,
  context: { nonOperationalRow?: boolean; fetchIncomplete?: boolean } = {},
): IdentityOutcomeState {
  if (context.nonOperationalRow) return "auto_skip_non_operational";
  if (context.fetchIncomplete) return "fetch_incomplete_holdout";

  switch (gates.overall) {
    case "pass":
    case "identity_only":
      return "auto_database_identity_match";
    case "stock_exception":
      return "client_stock_exception";
    case "shadow_identity":
      return "auto_shadow_identity_match";
    case "holdout":
      return "auto_holdout_for_evidence";
    case "reject":
      return "auto_reject_non_match";
  }
}
