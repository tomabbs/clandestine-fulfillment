import type { WarehouseFormatRule } from "@/lib/shared/types";

/**
 * Detects the format (LP, CD, 7", Cassette, Merch, etc.) of a product
 * by matching title/SKU/tags against warehouse_format_rules sorted by priority.
 */
export function detectFormat(
  title: string | null,
  sku: string | null,
  tags: string[],
  formatRules: WarehouseFormatRule[],
): string {
  const searchText = [title ?? "", sku ?? "", ...tags].join(" ").toLowerCase();

  // Sort by priority descending — higher priority rules match first
  const sorted = [...formatRules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    const pattern = rule.format_pattern.toLowerCase();
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(searchText)) {
        return rule.format_name;
      }
    } catch {
      // If format_pattern isn't valid regex, fall back to simple includes
      if (searchText.includes(pattern)) {
        return rule.format_name;
      }
    }
  }

  return "Unknown";
}
