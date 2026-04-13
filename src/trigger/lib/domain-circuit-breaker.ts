import { logger } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Extract the canonical circuit-breaker key from a Bandcamp URL.
 * - `*.bandcamp.com` -> subdomain (e.g. "truepanther")
 * - Custom domains (e.g. music.sufjan.com) -> full hostname
 */
export function extractSubdomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.endsWith(".bandcamp.com")) {
      return hostname.split(".")[0];
    }
    return hostname;
  } catch {
    return null;
  }
}

interface CircuitState {
  state: string;
  cooldown_until: string | null;
  effective_rps: number;
}

/**
 * Check if a domain's circuit breaker allows requests.
 * Returns true if the request should proceed.
 *
 * Half-open circuits allow exactly one probe request through.
 * Dead URL probes bypass open circuits (ignoreOpen = true).
 */
export async function checkCircuitBreaker(
  supabase: SupabaseClient,
  workspaceId: string,
  subdomain: string,
  options?: { ignoreOpen?: boolean },
): Promise<{ allowed: boolean; effectiveRps: number }> {
  const { data } = await supabase
    .from("bandcamp_domain_health")
    .select("state, cooldown_until, effective_rps")
    .eq("workspace_id", workspaceId)
    .eq("subdomain", subdomain)
    .single<CircuitState>();

  if (!data) {
    return { allowed: true, effectiveRps: 1.0 };
  }

  if (data.state === "closed") {
    return { allowed: true, effectiveRps: data.effective_rps };
  }

  if (data.state === "half_open") {
    return { allowed: true, effectiveRps: data.effective_rps };
  }

  // state === "open"
  if (options?.ignoreOpen) {
    return { allowed: true, effectiveRps: data.effective_rps };
  }

  // Check if cooldown has expired -> transition to half_open
  if (data.cooldown_until && new Date(data.cooldown_until) <= new Date()) {
    const { data: updated } = await supabase
      .from("bandcamp_domain_health")
      .update({ state: "half_open", updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("subdomain", subdomain)
      .eq("state", "open")
      .select("state")
      .single();

    if (updated) {
      logger.info("Circuit breaker transitioned to half_open", { workspaceId, subdomain });
      return { allowed: true, effectiveRps: data.effective_rps };
    }
  }

  return { allowed: false, effectiveRps: data.effective_rps };
}

/**
 * Record a successful scrape for circuit-breaker and AIMD tracking.
 * Uses SQL-native math via the record_domain_success RPC for atomicity.
 */
export async function recordCircuitSuccess(
  supabase: SupabaseClient,
  workspaceId: string,
  subdomain: string,
): Promise<void> {
  const { error } = await supabase.rpc("record_domain_success", {
    p_workspace_id: workspaceId,
    p_subdomain: subdomain,
  });
  if (error) {
    logger.warn("Failed to record domain success", { workspaceId, subdomain, error: error.message });
  }
}

/**
 * Record a failed scrape. Uses SQL-native AIMD math via the record_domain_failure RPC.
 * Returns the new circuit state for logging/decision-making.
 */
export async function recordCircuitFailure(
  supabase: SupabaseClient,
  workspaceId: string,
  subdomain: string,
  httpStatus?: number,
): Promise<{ failCount: number; domainState: string } | null> {
  const { data, error } = await supabase.rpc("record_domain_failure", {
    p_workspace_id: workspaceId,
    p_subdomain: subdomain,
    p_is_429: httpStatus === 429,
  });

  if (error) {
    logger.warn("Failed to record domain failure", { workspaceId, subdomain, error: error.message });
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;

  if (row.domain_state === "open") {
    logger.warn("Circuit breaker OPENED for domain", {
      workspaceId,
      subdomain,
      failCount: row.fail_count,
      cooldownUntil: row.cooldown,
    });
  }

  return { failCount: row.fail_count, domainState: row.domain_state };
}

/**
 * Classify an HTTP error into a failure reason for the last_failure_reason taxonomy.
 */
export function classifyFailureReason(
  httpStatus: number | undefined,
  error: unknown,
): string {
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 410) return "gone";
  if (httpStatus === 408 || httpStatus === 504) return "timeout";
  if (httpStatus && httpStatus >= 500) return "server_error";
  if (String(error).includes("parse") || String(error).includes("tralbum")) return "parse_failure";
  return "server_error";
}

/**
 * Calculate delay with jitter based on effective RPS.
 * Prevents thundering herd when multiple tasks resume after cooldown.
 */
export function calculateDelayMs(effectiveRps: number): number {
  const baseDelay = 1000 / Math.max(effectiveRps, 0.1);
  const jitter = Math.random() * baseDelay * 0.3;
  return Math.round(baseDelay + jitter);
}
