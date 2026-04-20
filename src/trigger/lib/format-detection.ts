/**
 * Format detection — determines packaging format from shipment item metadata.
 *
 * Ported from release-manager warehouse/format-detection.ts.
 * Detected format drives materials cost calculations for billing.
 *
 * Detection hierarchy (highest priority first):
 *   1. sku_prefix — SKU prefix match (e.g. "LP-", "CD-", "CS-")
 *   2. title_keyword — title/name keyword match
 *   3. weight_heuristic — fallback weight-based guess
 */

import { logger } from "@trigger.dev/sdk";
import type { createServiceRoleClient } from "@/lib/server/supabase-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipmentItem {
  sku?: string | null;
  name?: string | null;
  title?: string | null;
  weight?: number | null;
}

export type Confidence = "high" | "medium" | "low" | "none";

export interface FormatDetection {
  formatKey: string;
  displayName: string;
  confidence: Confidence;
  matchedBy: string;
}

export interface ShipmentFormatDetection extends FormatDetection {
  itemFormats: Array<{
    sku: string | null;
    name: string | null;
    formatKey: string;
    confidence: Confidence;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SKU prefix → format mapping (checked first, highest confidence) */
const SKU_PREFIX_RULES: Array<{ prefix: string; formatKey: string; displayName: string }> = [
  { prefix: "2XLP-", formatKey: "LP", displayName: "2xLP" },
  { prefix: "LP-", formatKey: "LP", displayName: "Vinyl LP" },
  { prefix: "MLP-", formatKey: "LP", displayName: "Mini LP" },
  { prefix: "CD-", formatKey: "CD", displayName: "CD" },
  { prefix: "CS-", formatKey: "Cassette", displayName: "Cassette" },
  { prefix: "7IN-", formatKey: '7"', displayName: '7" Single' },
  { prefix: "SI-", formatKey: '7"', displayName: '7" Single' },
  { prefix: "MAG-", formatKey: "Other", displayName: "Magazine" },
  { prefix: "SHIRT-", formatKey: "T-Shirt", displayName: "T-Shirt" },
  { prefix: "TS-", formatKey: "T-Shirt", displayName: "T-Shirt" },
  { prefix: "TB-", formatKey: "Cassette", displayName: "Cassette" },
  { prefix: "EB-", formatKey: "Other", displayName: "Book" },
  { prefix: "BOOK-", formatKey: "Other", displayName: "Book" },
  { prefix: "BK-", formatKey: "Other", displayName: "Book" },
  { prefix: "BAG-", formatKey: "Other", displayName: "Bag" },
  { prefix: "TOTE-", formatKey: "Other", displayName: "Tote Bag" },
  { prefix: "POSTER-", formatKey: "Other", displayName: "Poster" },
  { prefix: "PATCH-", formatKey: "Other", displayName: "Patch" },
  { prefix: "MERCH-", formatKey: "Other", displayName: "Merch" },
  { prefix: "FRAME-", formatKey: "Other", displayName: "Frame" },
];

/** Title keyword → format mapping (checked second, medium confidence) */
const TITLE_KEYWORD_RULES: Array<{ keyword: string; formatKey: string; displayName: string }> = [
  { keyword: " lp", formatKey: "LP", displayName: "Vinyl LP" },
  { keyword: "vinyl", formatKey: "LP", displayName: "Vinyl LP" },
  { keyword: '12"', formatKey: "LP", displayName: '12" Vinyl' },
  { keyword: "2xlp", formatKey: "LP", displayName: "2xLP" },
  { keyword: ' 7"', formatKey: '7"', displayName: '7" Single' },
  { keyword: "compact disc", formatKey: "CD", displayName: "CD" },
  { keyword: " cd", formatKey: "CD", displayName: "CD" },
  { keyword: "cassette", formatKey: "Cassette", displayName: "Cassette" },
  { keyword: " cs", formatKey: "Cassette", displayName: "Cassette" },
  { keyword: " tape", formatKey: "Cassette", displayName: "Cassette" },
  { keyword: "t-shirt", formatKey: "T-Shirt", displayName: "T-Shirt" },
  { keyword: "tee", formatKey: "T-Shirt", displayName: "T-Shirt" },
  { keyword: "poster", formatKey: "Other", displayName: "Poster" },
  { keyword: "tote", formatKey: "Other", displayName: "Tote Bag" },
  { keyword: "box set", formatKey: "Other", displayName: "Box Set" },
];

/** Weight-based heuristic thresholds (ounces). Last resort fallback. */
const WEIGHT_HEURISTICS: Array<{ minOz: number; formatKey: string; displayName: string }> = [
  { minOz: 12, formatKey: "LP", displayName: "Vinyl LP (weight heuristic)" },
  { minOz: 6, formatKey: '7"', displayName: '7" Single (weight heuristic)' },
  { minOz: 0, formatKey: "CD", displayName: "CD (weight heuristic)" },
];

/** Format priority for shipment-level detection (lower = higher priority = bigger mailer) */
const FORMAT_PRIORITY: Record<string, number> = {
  LP: 1,
  '7"': 2,
  "T-Shirt": 3,
  Cassette: 4,
  CD: 5,
  Other: 6,
  unknown: 999,
};

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Detect the packaging format of a single item from SKU, title, or weight.
 */
export function detectFormat(item: ShipmentItem | null | undefined): FormatDetection {
  if (!item) {
    return {
      formatKey: "unknown",
      displayName: "Unknown",
      confidence: "none",
      matchedBy: "no item",
    };
  }

  // 1. SKU prefix match (high confidence)
  const sku = (item.sku ?? "").toUpperCase();
  if (sku.length > 0) {
    for (const rule of SKU_PREFIX_RULES) {
      if (sku.startsWith(rule.prefix)) {
        return {
          formatKey: rule.formatKey,
          displayName: rule.displayName,
          confidence: "high",
          matchedBy: `sku_prefix:${rule.prefix}`,
        };
      }
    }
  }

  // 2. Title keyword match (medium confidence)
  const title = (item.name ?? item.title ?? "").toLowerCase();
  if (title.length > 0) {
    for (const rule of TITLE_KEYWORD_RULES) {
      if (title.includes(rule.keyword)) {
        return {
          formatKey: rule.formatKey,
          displayName: rule.displayName,
          confidence: "medium",
          matchedBy: `title_keyword:${rule.keyword.trim()}`,
        };
      }
    }
  }

  // 3. Weight heuristic (low confidence)
  const weight = typeof item.weight === "number" ? item.weight : null;
  if (weight !== null && weight > 0) {
    for (const h of WEIGHT_HEURISTICS) {
      if (weight >= h.minOz) {
        return {
          formatKey: h.formatKey,
          displayName: h.displayName,
          confidence: "low",
          matchedBy: `weight:>=${h.minOz}oz`,
        };
      }
    }
  }

  return {
    formatKey: "unknown",
    displayName: "Unknown",
    confidence: "none",
    matchedBy: "no match",
  };
}

/**
 * Detect the dominant packaging format for a multi-item shipment.
 *
 * Returns the HIGHEST-priority format across all items. A shipment with
 * 1 LP and 3 CDs uses the LP mailer cost because LP is the biggest item.
 */
export function detectShipmentFormat(items: ShipmentItem[]): ShipmentFormatDetection {
  if (!items || items.length === 0) {
    return {
      formatKey: "unknown",
      displayName: "Unknown",
      confidence: "none",
      matchedBy: "empty shipment",
      itemFormats: [],
    };
  }

  const itemDetections = items.map((item) => ({
    item,
    detection: detectFormat(item),
  }));

  // Find highest priority (lowest number) format
  let best = itemDetections[0];
  for (let i = 1; i < itemDetections.length; i++) {
    const current = itemDetections[i];
    const bestPrio = FORMAT_PRIORITY[best.detection.formatKey] ?? 999;
    const currentPrio = FORMAT_PRIORITY[current.detection.formatKey] ?? 999;
    if (currentPrio < bestPrio) {
      best = current;
    }
  }

  return {
    formatKey: best.detection.formatKey,
    displayName: best.detection.displayName,
    confidence: best.detection.confidence,
    matchedBy: best.detection.matchedBy,
    itemFormats: itemDetections.map((d) => ({
      sku: d.item.sku ?? null,
      name: d.item.name ?? d.item.title ?? null,
      formatKey: d.detection.formatKey,
      confidence: d.detection.confidence,
    })),
  };
}

/**
 * Load format rules from warehouse_format_rules and merge with built-in rules.
 * DB rules take precedence (they can override built-in patterns).
 */
export async function loadFormatRules(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
): Promise<void> {
  const { data: dbRules, error } = await supabase
    .from("warehouse_format_rules")
    .select("format_pattern, format_name, priority")
    .eq("workspace_id", workspaceId)
    .order("priority", { ascending: true });

  if (error) {
    logger.warn("Failed to load format rules from DB, using built-in only", {
      error: error.message,
    });
    return;
  }

  // DB rules are ILIKE patterns (e.g. "%vinyl%lp%") — we don't dynamically inject
  // them into the detection engine yet. For now they're used by the billing calculator.
  // The built-in SKU_PREFIX_RULES and TITLE_KEYWORD_RULES cover the main cases.
  logger.info(`Loaded ${dbRules?.length ?? 0} format rules from DB`, { workspaceId });
}

/**
 * Map a Bandcamp `api_data.type_name` value (or any free-text format hint)
 * to one of our canonical `format_name` strings. Returns null if the input
 * doesn't confidently map to a known format.
 *
 * Used by the format backfill to leverage Bandcamp metadata for variants
 * whose `format_name` is NULL but whose Bandcamp mapping has a clear type.
 *
 * Canonical output set matches the existing `format_name` distribution:
 *   "LP" | "CD" | "Cassette" | "7\"" | "T-Shirt" | "Other"
 */
export function bandcampTypeNameToFormat(typeName: string | null | undefined): string | null {
  if (!typeName) return null;
  const t = typeName.trim().toLowerCase();
  if (t.length === 0) return null;
  // Order matters: 7" / Cassette / CD checked BEFORE LP/vinyl (Bandcamp uses
  // strings like `7" Vinyl` and `Cassette Tape` that would otherwise hit LP).
  if (/(7 ?inch|7"|flexi|single)/.test(t)) return '7"';
  if (/(cassette|tape)/.test(t)) return "Cassette";
  if (/(compact disc|^cd$|cd reissue|cd ep|cd album)/.test(t)) return "CD";
  if (/(record\/vinyl|vinyl|^lp$|lp record|2x ?lp|12 ?inch|12")/.test(t)) return "LP";
  if (/(t-?shirt|shirt|tee|hoodie|sweater|sweatshirt|long ?sleeve|crewneck|hat|cap)/.test(t)) {
    return "T-Shirt";
  }
  if (
    /(bag|tote|poster|print|sticker|pin|patch|button|zine|book|magazine|slipmat|bandana|merch|usb)/.test(
      t,
    )
  ) {
    return "Other";
  }
  return null;
}

/**
 * Look up the material cost for a detected format from warehouse_format_costs.
 */
export async function getMaterialsCost(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  formatKey: string,
): Promise<{ pickPackCost: number; materialCost: number } | null> {
  const { data } = await supabase
    .from("warehouse_format_costs")
    .select("pick_pack_cost, material_cost")
    .eq("workspace_id", workspaceId)
    .eq("format_name", formatKey)
    .maybeSingle();

  if (!data) return null;

  return {
    pickPackCost: Number(data.pick_pack_cost),
    materialCost: Number(data.material_cost),
  };
}
