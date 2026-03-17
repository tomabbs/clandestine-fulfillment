import type { InboundStatus } from "./types";

const VALID_TRANSITIONS: Record<InboundStatus, InboundStatus[]> = {
  expected: ["arrived", "issue"],
  arrived: ["checking_in", "issue"],
  checking_in: ["checked_in", "issue"],
  checked_in: [],
  issue: ["expected", "arrived", "checking_in"],
};

export function isValidTransition(from: InboundStatus, to: InboundStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
