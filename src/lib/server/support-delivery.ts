import { tasks } from "@trigger.dev/sdk";
import type { SupportDeliveryChannel } from "@/lib/shared/support-taxonomy";

export interface SupportDeliveryRoute {
  channel: SupportDeliveryChannel;
  recipient?: string | null;
  provider?: string | null;
  providerThreadId?: string | null;
}

interface SupabaseLike {
  from: (table: string) => {
    insert: (value: unknown) => {
      select?: (columns?: string) => { single?: () => Promise<{ data: unknown; error: unknown }> };
    };
    select: (columns?: string) => unknown;
  };
}

export function supportDeliveryIdempotencyKey(
  messageId: string,
  route: SupportDeliveryRoute,
): string {
  return `${messageId}:${route.channel}`;
}

export function nextSupportDeliveryRetryAt(attemptCount: number, now: Date = new Date()): string {
  const retryMinutes = [1, 5, 15, 60, 360];
  const minutes = retryMinutes[Math.min(attemptCount, retryMinutes.length - 1)] ?? 360;
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

export async function enqueueSupportMessageDelivery(messageId: string): Promise<void> {
  await tasks.trigger("support-message-delivery", { messageId });
}

export async function enqueuePendingSupportDeliveryForMessage(messageId: string): Promise<void> {
  await enqueueSupportMessageDelivery(messageId);
}

// Narrow helper used in tests and fallback paths. The action owns concrete
// Supabase writes so it can keep authorization context close to the mutation.
export function normalizeDeliveryRoutes(routes: SupportDeliveryRoute[]): SupportDeliveryRoute[] {
  const seen = new Set<string>();
  const normalized: SupportDeliveryRoute[] = [];
  for (const route of routes) {
    const key = route.channel;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(route);
  }
  return normalized;
}

export type { SupabaseLike };
