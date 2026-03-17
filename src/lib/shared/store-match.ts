export interface AutoMatchSuggestion {
  storeId: string;
  storeName: string;
  suggestedOrgId: string;
  suggestedOrgName: string;
  confidence: number;
}

export function computeMatchSuggestions(
  unmappedStores: Array<{ id: string; store_name: string | null }>,
  orgs: Array<{ id: string; name: string }>,
): AutoMatchSuggestion[] {
  const suggestions: AutoMatchSuggestion[] = [];

  for (const store of unmappedStores) {
    if (!store.store_name) continue;

    const storeLower = store.store_name.toLowerCase();
    let bestMatch: { orgId: string; orgName: string; confidence: number } | null = null;

    for (const org of orgs) {
      const orgLower = org.name.toLowerCase();
      let confidence = 0;

      if (storeLower === orgLower) {
        confidence = 1.0;
      } else if (storeLower.includes(orgLower) || orgLower.includes(storeLower)) {
        // Partial/contains match — scale by how much of the strings overlap
        const overlapLen = Math.min(storeLower.length, orgLower.length);
        const maxLen = Math.max(storeLower.length, orgLower.length);
        confidence = 0.5 + 0.3 * (overlapLen / maxLen);
      } else {
        // Token-based similarity: check if any words overlap
        const storeTokens = storeLower.split(/[\s\-_]+/).filter(Boolean);
        const orgTokens = orgLower.split(/[\s\-_]+/).filter(Boolean);
        const matchingTokens = storeTokens.filter((t) =>
          orgTokens.some((ot) => ot.includes(t) || t.includes(ot)),
        );
        if (matchingTokens.length > 0) {
          confidence =
            0.3 * (matchingTokens.length / Math.max(storeTokens.length, orgTokens.length));
        }
      }

      if (confidence > 0 && (!bestMatch || confidence > bestMatch.confidence)) {
        bestMatch = { orgId: org.id, orgName: org.name, confidence };
      }
    }

    if (bestMatch && bestMatch.confidence >= 0.3) {
      suggestions.push({
        storeId: store.id,
        storeName: store.store_name,
        suggestedOrgId: bestMatch.orgId,
        suggestedOrgName: bestMatch.orgName,
        confidence: Math.round(bestMatch.confidence * 100) / 100,
      });
    }
  }

  return suggestions;
}
