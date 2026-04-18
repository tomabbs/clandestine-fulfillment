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
});
