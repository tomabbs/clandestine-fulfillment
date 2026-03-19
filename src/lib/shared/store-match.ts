/**
 * Store-to-organization matching logic.
 *
 * Ported from release-manager warehouse-admin-api.js tokenizeStoreName + matchScore.
 * Strips marketplace suffixes before matching, uses token scoring.
 */

export interface AutoMatchSuggestion {
  storeId: string;
  storeName: string;
  suggestedOrgId: string;
  suggestedOrgName: string;
  confidence: number;
}

/** Marketplace platform suffixes stripped before matching */
const MARKETPLACE_SUFFIXES = new Set([
  "bandcamp",
  "shopify",
  "squarespace",
  "woocommerce",
  "bigcartel",
  "etsy",
  "amazon",
  "ebay",
  "store",
  "manual",
  "api",
  "ratebrowser",
  "shipstation",
  "orders",
]);

/**
 * Tokenize a store name for matching:
 * 1. Lowercase
 * 2. Split on spaces, hyphens, underscores
 * 3. Strip marketplace suffixes
 */
function tokenize(name: string): string[] {
  const raw = name
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  return raw.filter((t) => !MARKETPLACE_SUFFIXES.has(t));
}

/**
 * Score a match between store name tokens and an organization.
 * Higher = better match. 0 = no match.
 *
 * Scoring (from old app):
 *   - Token in org name: +2
 *   - Prefix match (token starts with org token or vice versa): +1
 */
function matchScore(tokens: string[], orgName: string): number {
  if (tokens.length === 0) return 0;

  const orgLower = orgName.toLowerCase();
  const orgTokens = orgLower.split(/[\s\-_]+/).filter(Boolean);
  let score = 0;

  for (const token of tokens) {
    if (orgLower.includes(token)) {
      score += 2;
      continue;
    }
    if (orgTokens.some((ot) => ot.startsWith(token) || token.startsWith(ot))) {
      score += 1;
    }
  }

  return score;
}

/**
 * Compute match suggestions using both org names and aliases.
 * Aliases are treated as additional org name variants for scoring.
 */
export function computeMatchSuggestions(
  unmappedStores: Array<{ id: string; store_name: string | null }>,
  orgs: Array<{ id: string; name: string }>,
  aliases?: Array<{ org_id: string; alias_name: string }>,
): AutoMatchSuggestion[] {
  const suggestions: AutoMatchSuggestion[] = [];

  for (const store of unmappedStores) {
    if (!store.store_name) continue;

    const tokens = tokenize(store.store_name);
    if (tokens.length === 0) continue;

    let bestMatch: { orgId: string; orgName: string; score: number } | null = null;

    for (const org of orgs) {
      const score = matchScore(tokens, org.name);
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { orgId: org.id, orgName: org.name, score };
      }
    }

    // Also score against aliases — an alias match credits the owning org
    if (aliases) {
      for (const alias of aliases) {
        const score = matchScore(tokens, alias.alias_name);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          const org = orgs.find((o) => o.id === alias.org_id);
          bestMatch = {
            orgId: alias.org_id,
            orgName: org?.name ?? alias.alias_name,
            score,
          };
        }
      }
    }

    if (bestMatch && bestMatch.score >= 2) {
      const maxPossible = tokens.length * 2;
      const confidence = Math.round((bestMatch.score / maxPossible) * 100) / 100;

      suggestions.push({
        storeId: store.id,
        storeName: store.store_name,
        suggestedOrgId: bestMatch.orgId,
        suggestedOrgName: bestMatch.orgName,
        confidence: Math.min(confidence, 1),
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}
