import type { ConversationStatus } from "@/lib/shared/types";

export type SupportQueueType =
  | "needs_triage"
  | "mine"
  | "waiting_on_staff"
  | "waiting_on_client"
  | "sla_breach_soon"
  | "sla_breached"
  | "unassigned"
  | "snoozed"
  | "resolved";

export interface QueueConversationShape {
  status: ConversationStatus;
  assigned_to: string | null;
  category?: string | null;
  priority?: string | null;
  snoozed_until?: string | null;
  next_response_due_at?: string | null;
  sla_paused?: boolean | null;
}

export interface QueueFlags {
  needsTriage: boolean;
  mine: boolean;
  waitingOnStaff: boolean;
  waitingOnClient: boolean;
  slaBreachSoon: boolean;
  slaBreached: boolean;
  unassigned: boolean;
  snoozed: boolean;
  resolved: boolean;
  onTrack: boolean;
}

export function isSupportResolved(status: ConversationStatus): boolean {
  return status === "resolved" || status === "closed";
}

export function getSupportQueueFlags(
  conversation: QueueConversationShape,
  viewerId: string | null,
  now: Date = new Date(),
): QueueFlags {
  const resolved = isSupportResolved(conversation.status);
  const snoozed =
    !!conversation.snoozed_until && new Date(conversation.snoozed_until).getTime() > now.getTime();
  const dueAt = conversation.next_response_due_at
    ? new Date(conversation.next_response_due_at)
    : null;
  const dueInMs = dueAt ? dueAt.getTime() - now.getTime() : null;
  const slaActive = !resolved && !snoozed && !conversation.sla_paused;
  const slaBreached = !!dueAt && slaActive && dueAt.getTime() < now.getTime();
  const slaBreachSoon =
    !!dueAt && slaActive && !slaBreached && dueInMs !== null && dueInMs <= 60 * 60 * 1000;

  return {
    needsTriage:
      !resolved &&
      !snoozed &&
      (!conversation.assigned_to || !conversation.category || !conversation.priority),
    mine: !!viewerId && conversation.assigned_to === viewerId && !resolved && !snoozed,
    waitingOnStaff: conversation.status === "waiting_on_staff" && !snoozed,
    waitingOnClient: conversation.status === "waiting_on_client",
    slaBreachSoon,
    slaBreached,
    unassigned: !conversation.assigned_to && !resolved,
    snoozed,
    resolved,
    onTrack: !resolved && !slaBreachSoon && !slaBreached,
  };
}

export function conversationMatchesQueue(
  conversation: QueueConversationShape,
  queue: SupportQueueType,
  viewerId: string | null,
  now: Date = new Date(),
): boolean {
  const flags = getSupportQueueFlags(conversation, viewerId, now);
  switch (queue) {
    case "needs_triage":
      return flags.needsTriage;
    case "mine":
      return flags.mine;
    case "waiting_on_staff":
      return flags.waitingOnStaff;
    case "waiting_on_client":
      return flags.waitingOnClient;
    case "sla_breach_soon":
      return flags.slaBreachSoon;
    case "sla_breached":
      return flags.slaBreached;
    case "unassigned":
      return flags.unassigned;
    case "snoozed":
      return flags.snoozed;
    case "resolved":
      return flags.resolved;
  }
}
