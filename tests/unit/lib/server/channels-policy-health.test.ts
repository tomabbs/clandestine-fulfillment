/**
 * Phase 0 / §9.1 D2 — Channels page health derivation tests.
 *
 * Pins the truth table:
 *
 *  +-------------------+-----------------------+--------------------+
 *  | connectionStatus  | mappings              | result.state       |
 *  +-------------------+-----------------------+--------------------+
 *  | disabled_auth_*   | (any)                 | disconnected       |
 *  | active            | drifted (>=1 mapping) | policy_drift       |
 *  | active            | all clean, audit <48h | healthy            |
 *  | active            | all clean, audit >48h | delayed            |
 *  | active            | no audit ever         | delayed            |
 *  | active            | CONTINUE+whitelisted  | healthy (NO drift) |
 *  +-------------------+-----------------------+--------------------+
 */

import { describe, expect, it } from "vitest";
import { deriveConnectionPolicyHealth } from "@/lib/server/channels-policy-health";

const NOW = new Date("2026-04-21T12:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
const STALE = new Date(NOW.getTime() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago

describe("deriveConnectionPolicyHealth", () => {
  it("returns 'disconnected' on auth failure regardless of mappings", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "disabled_auth_failure",
      mappings: [
        { last_inventory_policy: "DENY", preorder_whitelist: false, last_policy_check_at: RECENT },
      ],
      now: NOW,
    });
    expect(result.state).toBe("disconnected");
    expect(result.reason).toMatch(/auth/i);
  });

  it("returns 'policy_drift' when at least one CONTINUE non-whitelisted mapping exists", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "active",
      mappings: [
        { last_inventory_policy: "DENY", preorder_whitelist: false, last_policy_check_at: RECENT },
        {
          last_inventory_policy: "CONTINUE",
          preorder_whitelist: false,
          last_policy_check_at: RECENT,
        },
      ],
      now: NOW,
    });
    expect(result.state).toBe("policy_drift");
    expect(result.driftCount).toBe(1);
  });

  it("CONTINUE + preorder_whitelist=true does NOT count as drift (legitimate exemption)", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "active",
      mappings: [
        {
          last_inventory_policy: "CONTINUE",
          preorder_whitelist: true,
          last_policy_check_at: RECENT,
        },
        { last_inventory_policy: "DENY", preorder_whitelist: false, last_policy_check_at: RECENT },
      ],
      now: NOW,
    });
    expect(result.state).toBe("healthy");
    expect(result.driftCount).toBe(0);
  });

  it("returns 'delayed' when no mapping has been audited in the staleness window", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "active",
      mappings: [
        { last_inventory_policy: "DENY", preorder_whitelist: false, last_policy_check_at: STALE },
      ],
      now: NOW,
    });
    expect(result.state).toBe("delayed");
    expect(result.lastAuditAt).toBe(STALE);
  });

  it("returns 'delayed' with null lastAuditAt when audit has never run", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "active",
      mappings: [
        { last_inventory_policy: null, preorder_whitelist: false, last_policy_check_at: null },
      ],
      now: NOW,
    });
    expect(result.state).toBe("delayed");
    expect(result.lastAuditAt).toBeNull();
    expect(result.reason).toMatch(/has not run yet/i);
  });

  it("uses the NEWEST mapping audit timestamp for staleness (not the oldest)", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "active",
      mappings: [
        { last_inventory_policy: "DENY", preorder_whitelist: false, last_policy_check_at: STALE },
        { last_inventory_policy: "DENY", preorder_whitelist: false, last_policy_check_at: RECENT },
      ],
      now: NOW,
    });
    expect(result.state).toBe("healthy");
    expect(result.lastAuditAt).toBe(RECENT);
  });

  it("drift takes precedence over staleness — a drifted-but-stale connection is policy_drift, not delayed", () => {
    const result = deriveConnectionPolicyHealth({
      connectionStatus: "active",
      mappings: [
        {
          last_inventory_policy: "CONTINUE",
          preorder_whitelist: false,
          last_policy_check_at: STALE,
        },
      ],
      now: NOW,
    });
    expect(result.state).toBe("policy_drift");
  });
});
