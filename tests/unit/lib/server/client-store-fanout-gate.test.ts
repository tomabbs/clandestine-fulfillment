import { describe, expect, it } from "vitest";
import { isFanoutAllowed, shouldFanoutToConnection } from "@/lib/server/client-store-fanout-gate";
import type { ClientStoreConnection } from "@/lib/shared/types";

/**
 * Phase 0.8 dormancy gate.
 *
 * The gate is the single chokepoint that decides whether ANY first-party
 * client store push or webhook side-effect can proceed. Every branch matters
 * because adding a regression here would silently re-enable the fanout we
 * just disabled in migration 20260417000003. Tests cover each denial reason
 * so a future "let's relax this" change has to delete a test, not just edit
 * a boolean.
 */

function makeConnection(overrides: Partial<ClientStoreConnection> = {}): ClientStoreConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    org_id: "org-1",
    platform: "shopify",
    store_url: "https://example.myshopify.com",
    api_key: null,
    api_secret: null,
    access_token: null,
    webhook_url: null,
    webhook_secret: null,
    connection_status: "active",
    do_not_fanout: false,
    last_webhook_at: null,
    last_poll_at: null,
    last_error_at: null,
    last_error: null,
    cutover_state: "legacy",
    cutover_started_at: null,
    cutover_completed_at: null,
    shadow_mode_log_id: null,
    shadow_window_tolerance_seconds: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as unknown as ClientStoreConnection;
}

describe("client-store-fanout-gate", () => {
  it("allows a healthy active connection", () => {
    const decision = shouldFanoutToConnection(makeConnection());
    expect(decision).toEqual({ allow: true });
    expect(isFanoutAllowed(makeConnection())).toBe(true);
  });

  it("denies do_not_fanout regardless of connection_status", () => {
    const decision = shouldFanoutToConnection(makeConnection({ do_not_fanout: true }));
    expect(decision).toEqual({ allow: false, reason: "do_not_fanout" });
  });

  it("denies disabled_auth_failure even when do_not_fanout=false", () => {
    const decision = shouldFanoutToConnection(
      makeConnection({ connection_status: "disabled_auth_failure" }),
    );
    expect(decision).toEqual({ allow: false, reason: "auth_failed" });
  });

  it("denies error connection_status", () => {
    const decision = shouldFanoutToConnection(makeConnection({ connection_status: "error" }));
    expect(decision).toEqual({ allow: false, reason: "error" });
  });

  it("denies pending connection_status (credentials not yet provided)", () => {
    const decision = shouldFanoutToConnection(makeConnection({ connection_status: "pending" }));
    expect(decision).toEqual({ allow: false, reason: "pending" });
  });

  it("do_not_fanout takes precedence over connection_status checks", () => {
    // A degraded connection that is also marked dormant should still report
    // do_not_fanout as the reason, because that is the primary semantic the
    // operator relies on (Phase 0.8 migration set this on every Shopify /
    // WooCommerce / Squarespace connection regardless of health).
    const decision = shouldFanoutToConnection(
      makeConnection({ do_not_fanout: true, connection_status: "error" }),
    );
    expect(decision.reason).toBe("do_not_fanout");
  });

  it("isFanoutAllowed mirrors shouldFanoutToConnection.allow", () => {
    const dormant = makeConnection({ do_not_fanout: true });
    expect(isFanoutAllowed(dormant)).toBe(false);
    const healthy = makeConnection();
    expect(isFanoutAllowed(healthy)).toBe(true);
  });

  // Phase 3 Pass 1 §9.4 D1 — defensive cutover_state validation.
  // The DB CHECK constraint + NOT NULL DEFAULT 'legacy' should make these
  // branches unreachable on production data, but the gate is the
  // belt-and-suspenders enforcement point. A bad migration / hand-fired
  // SQL / future enum widening that landed an unrecognized cutover_state
  // value MUST be rejected here so it surfaces in monitoring instead of
  // silently fanning out under undefined semantics.
  it.each([
    ["legacy"],
    ["shadow"],
    ["direct"],
  ] as const)("allows cutover_state=%s on a healthy active connection", (state) => {
    const decision = shouldFanoutToConnection(makeConnection({ cutover_state: state }));
    expect(decision).toEqual({ allow: true });
  });

  it("denies a connection with an unrecognized cutover_state value (defensive)", () => {
    const decision = shouldFanoutToConnection(
      // Force an invalid value through the type cast — production data is
      // protected by the CHECK constraint, but runtime defense protects
      // against a future enum-widening migration that misses a callsite.
      makeConnection({ cutover_state: "rolling_back" as unknown as "legacy" }),
    );
    expect(decision).toEqual({ allow: false, reason: "invalid_cutover_state" });
  });

  it("treats NULL cutover_state as 'legacy' (matches DB NOT NULL DEFAULT)", () => {
    // The DB column is NOT NULL DEFAULT 'legacy', so a row that came from
    // the DB cannot actually have null/undefined here. We treat null as the
    // default rather than as invalid because (a) the row is provably safe
    // and (b) it keeps pre-Phase-3 fixtures and any partial-projection
    // SELECTs from triggering false positives.
    const decision = shouldFanoutToConnection(
      makeConnection({ cutover_state: null as unknown as "legacy" }),
    );
    expect(decision).toEqual({ allow: true });
  });

  it("do_not_fanout precedence — denies even when cutover_state=shadow is set", () => {
    // The DB CHECK constraint blocks (shadow|direct, do_not_fanout=true)
    // from ever landing on a real row, but if someone bypasses the DB
    // (e.g. a unit test like this one), do_not_fanout must still win.
    const decision = shouldFanoutToConnection(
      makeConnection({ cutover_state: "shadow", do_not_fanout: true }),
    );
    expect(decision).toEqual({ allow: false, reason: "do_not_fanout" });
  });
});
