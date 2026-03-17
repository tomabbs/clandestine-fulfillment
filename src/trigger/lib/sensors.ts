/**
 * Sensor check functions. Each returns a reading with status + value.
 * Pure threshold logic is exported for testing.
 */

export interface SensorReading {
  sensorName: string;
  status: "healthy" | "warning" | "critical";
  value: Record<string, unknown>;
  message: string;
}

// === Threshold helpers (exported for testing) ===

export function driftStatus(mismatchCount: number): "healthy" | "warning" | "critical" {
  if (mismatchCount === 0) return "healthy";
  if (mismatchCount <= 5) return "warning";
  return "critical";
}

export function propagationLagStatus(maxAgeMinutes: number): "healthy" | "warning" | "critical" {
  if (maxAgeMinutes < 5) return "healthy";
  if (maxAgeMinutes < 30) return "warning";
  return "critical";
}

export function syncStalenessStatus(
  minutesSinceSync: number | null,
  warnThreshold = 30,
  criticalThreshold = 120,
): "healthy" | "warning" | "critical" {
  if (minutesSinceSync === null) return "critical";
  if (minutesSinceSync < warnThreshold) return "healthy";
  if (minutesSinceSync < criticalThreshold) return "warning";
  return "critical";
}

export function webhookSilenceDetected(
  lastWebhookAt: string | null,
  _lastPollAt: string | null,
  pollFoundOrders: boolean,
): boolean {
  if (!lastWebhookAt) return false;
  const silenceHours = (Date.now() - new Date(lastWebhookAt).getTime()) / (1000 * 60 * 60);
  return silenceHours > 6 && pollFoundOrders;
}

export function unpaidInvoiceStatus(overdueCount: number): "healthy" | "warning" | "critical" {
  if (overdueCount === 0) return "healthy";
  return "warning";
}

export function criticalItemsStatus(openCriticalCount: number): "healthy" | "warning" | "critical" {
  if (openCriticalCount === 0) return "healthy";
  return "warning";
}
