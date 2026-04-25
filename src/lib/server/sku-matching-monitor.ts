export interface SkuMatchingPerfEventRow {
  workspace_id: string;
  event_type: string;
  duration_ms: number | null;
  conflict_count: number | null;
  created_at: string;
}

export interface SkuMatchingMonitoringSummary {
  workspaceLoadP90Ms: number | null;
  previewCount: number;
  acceptanceCount: number;
  reviewOnlyCount: number;
  acceptanceRate: number | null;
  latestConflictCount: number;
  earliestConflictCount: number;
  conflictGrowth: number;
  status: "healthy" | "warning";
  reasons: string[];
}

export const SKU_MATCHING_P90_BUDGET_MS = 3000;
export const SKU_MATCHING_CONFLICT_ALERT_DELTA = 10;
export const SKU_MATCHING_CONFLICT_ALERT_COUNT = 20;

function percentile(values: number[], percentileRank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileRank) - 1),
  );
  return sorted[index] ?? null;
}

export function summarizeSkuMatchingMonitoring(
  events: SkuMatchingPerfEventRow[],
): SkuMatchingMonitoringSummary {
  const loadDurations = events
    .filter(
      (event) => event.event_type === "workspace_load" && typeof event.duration_ms === "number",
    )
    .map((event) => event.duration_ms as number);
  const workspaceLoadP90Ms = percentile(loadDurations, 0.9);

  const previewCount = events.filter((event) => event.event_type === "preview_open").length;
  const acceptanceCount = events.filter((event) =>
    ["match_accept", "bulk_accept"].includes(event.event_type),
  ).length;
  const reviewOnlyCount = Math.max(previewCount - acceptanceCount, 0);
  const acceptanceRate = previewCount > 0 ? acceptanceCount / previewCount : null;

  const loadEventsWithConflicts = events
    .filter(
      (event) => event.event_type === "workspace_load" && typeof event.conflict_count === "number",
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const earliestConflictCount = loadEventsWithConflicts[0]?.conflict_count ?? 0;
  const latestConflictCount = loadEventsWithConflicts.at(-1)?.conflict_count ?? 0;
  const conflictGrowth = latestConflictCount - earliestConflictCount;

  const reasons: string[] = [];
  if (workspaceLoadP90Ms != null && workspaceLoadP90Ms > SKU_MATCHING_P90_BUDGET_MS) {
    reasons.push(`workspace_load_p90>${SKU_MATCHING_P90_BUDGET_MS}`);
  }
  if (
    latestConflictCount >= SKU_MATCHING_CONFLICT_ALERT_COUNT &&
    conflictGrowth >= SKU_MATCHING_CONFLICT_ALERT_DELTA
  ) {
    reasons.push("conflict_growth");
  }

  return {
    workspaceLoadP90Ms,
    previewCount,
    acceptanceCount,
    reviewOnlyCount,
    acceptanceRate,
    latestConflictCount,
    earliestConflictCount,
    conflictGrowth,
    status: reasons.length > 0 ? "warning" : "healthy",
    reasons,
  };
}
