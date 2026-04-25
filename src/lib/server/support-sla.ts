export interface SupportSlaPolicy {
  first_response_minutes: number;
  next_response_minutes: number;
  resolution_minutes: number | null;
  business_hours_only?: boolean | null;
}

export interface SupportSlaDeadlines {
  first_response_due_at: string | null;
  next_response_due_at: string | null;
  resolution_due_at: string | null;
}

export const DEFAULT_SUPPORT_SLA_BY_PRIORITY: Record<string, SupportSlaPolicy> = {
  urgent: {
    first_response_minutes: 60,
    next_response_minutes: 60,
    resolution_minutes: 1440,
  },
  high: {
    first_response_minutes: 240,
    next_response_minutes: 240,
    resolution_minutes: 2880,
  },
  normal: {
    first_response_minutes: 1440,
    next_response_minutes: 1440,
    resolution_minutes: 7200,
  },
  low: {
    first_response_minutes: 2880,
    next_response_minutes: 2880,
    resolution_minutes: null,
  },
};

export function calculateSupportSlaDeadlines(
  policy: SupportSlaPolicy | null | undefined,
  from: Date = new Date(),
): SupportSlaDeadlines {
  if (!policy) {
    return {
      first_response_due_at: null,
      next_response_due_at: null,
      resolution_due_at: null,
    };
  }

  return {
    first_response_due_at: addMinutes(from, policy.first_response_minutes).toISOString(),
    next_response_due_at: addMinutes(from, policy.next_response_minutes).toISOString(),
    resolution_due_at:
      policy.resolution_minutes == null
        ? null
        : addMinutes(from, policy.resolution_minutes).toISOString(),
  };
}

export function defaultPolicyForPriority(priority: string): SupportSlaPolicy {
  return DEFAULT_SUPPORT_SLA_BY_PRIORITY[priority] ?? DEFAULT_SUPPORT_SLA_BY_PRIORITY.normal;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}
