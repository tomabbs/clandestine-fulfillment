/**
 * Phase 0 follow-up — `getConnectionPolicyHealth` Server Action tests.
 *
 * Pins the contract:
 *   1. Staff-only.
 *   2. Non-Shopify connections are rejected.
 *   3. Missing connection rejects.
 *   4. Mapping fetch error surfaces (does NOT silently fall through to
 *      `deriveConnectionPolicyHealth([])` which would mis-report `delayed`).
 *   5. Disconnected (auth-failed) connection -> state='disconnected'.
 *   6. No mappings + active connection -> state='delayed' with no SKU sample.
 *   7. Drift mappings -> state='policy_drift', driftSkusSampled capped at
 *      POLICY_HEALTH_DRIFT_SAMPLE_LIMIT, only includes !preorder_whitelist
 *      CONTINUE entries.
 *   8. Whitelisted CONTINUE + DENY mix with fresh audit -> state='healthy'.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireAuth, mockServiceFrom } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockServiceFrom: vi.fn(),
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: mockRequireAuth,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: vi.fn() }, from: vi.fn() }),
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

// `auditShopifyPolicy` shares the file but its own surface (auditShopifyConnection,
// tasks.trigger) is not exercised by this Server Action — mock to no-ops so
// the file imports cleanly.
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));
vi.mock("@/trigger/tasks/shopify-policy-audit", () => ({ auditShopifyConnection: vi.fn() }));

import { getConnectionPolicyHealth } from "@/actions/shopify-policy";
import { POLICY_HEALTH_DRIFT_SAMPLE_LIMIT } from "@/lib/shared/constants";

const STAFF_AUTH = {
  supabase: { from: vi.fn() },
  authUserId: "auth-1",
  userRecord: {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "ws-1",
    org_id: null,
    role: "admin" as const,
    email: "admin@test.com",
    name: "Admin",
  },
  isStaff: true,
};

const CLIENT_AUTH = {
  ...STAFF_AUTH,
  isStaff: false,
  userRecord: { ...STAFF_AUTH.userRecord, role: "client" as const },
};

const CONN_ID = "22222222-2222-4222-8222-222222222222";

type Conn = {
  id: string;
  platform: string;
  connection_status: "pending" | "active" | "disabled_auth_failure" | "error";
};

type Mapping = {
  last_inventory_policy: "DENY" | "CONTINUE" | null;
  preorder_whitelist: boolean;
  last_policy_check_at: string | null;
  remote_sku: string | null;
};

/**
 * Single-purpose `from(...)` dispatcher that handles both:
 *   - `client_store_connections.select(...).eq(...).maybeSingle()`
 *   - `client_store_sku_mappings.select(...).eq(...).eq(...)`  (no terminator;
 *     the action awaits the chain directly)
 *
 * Either side can be set to throw via `connError` / `mappingError`.
 */
function mockTables(opts: {
  conn: Conn | null;
  connError?: string;
  mappings?: Mapping[];
  mappingError?: string;
}) {
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === "client_store_connections") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve(
                opts.connError
                  ? { data: null, error: { message: opts.connError } }
                  : { data: opts.conn, error: null },
              ),
          }),
        }),
      };
    }
    if (table === "client_store_sku_mappings") {
      // `.eq("connection_id").eq("is_active")` — second .eq is the awaitable.
      const result = opts.mappingError
        ? { data: null, error: { message: opts.mappingError } }
        : { data: opts.mappings ?? [], error: null };
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve(result),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

const ACTIVE_CONN: Conn = { id: CONN_ID, platform: "shopify", connection_status: "active" };
// Time anchors are computed relative to wall-clock at module load, NOT
// hardcoded ISO strings. Hardcoded timestamps decay past the 48h
// freshness boundary as real-time rolls forward (caused the
// "whitelisted CONTINUE + DENY mix → state='healthy'" assertion to flip
// to 'delayed' in CI on 2026-04-24, ~56h after the prior anchor of
// 2026-04-22T06:00Z). 6h ago is comfortably inside the 48h window for
// every test that injects FRESH_AUDIT as the simulated last_policy_check_at.
const NOW = new Date().toISOString();
const FRESH_AUDIT = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

describe("getConnectionPolicyHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue(STAFF_AUTH);
  });

  it("rejects non-staff callers", async () => {
    mockRequireAuth.mockResolvedValueOnce(CLIENT_AUTH);
    await expect(getConnectionPolicyHealth({ connectionId: CONN_ID })).rejects.toThrow(/Forbidden/);
  });

  it("rejects non-Shopify connections", async () => {
    mockTables({ conn: { ...ACTIVE_CONN, platform: "woocommerce" } });
    await expect(getConnectionPolicyHealth({ connectionId: CONN_ID })).rejects.toThrow(
      /only applies to Shopify/,
    );
  });

  it("rejects when the connection lookup returns no row", async () => {
    mockTables({ conn: null });
    await expect(getConnectionPolicyHealth({ connectionId: CONN_ID })).rejects.toThrow(
      /Connection not found/,
    );
  });

  it("surfaces the mapping fetch error rather than silently degrading", async () => {
    mockTables({ conn: ACTIVE_CONN, mappingError: "permission denied" });
    await expect(getConnectionPolicyHealth({ connectionId: CONN_ID })).rejects.toThrow(
      /Mapping snapshot fetch failed: permission denied/,
    );
  });

  it("auth-failed connection -> state='disconnected' regardless of mappings", async () => {
    mockTables({
      conn: { ...ACTIVE_CONN, connection_status: "disabled_auth_failure" },
      mappings: [
        // Even with drift present, disconnected wins — the operator can't
        // remediate drift on a disconnected store.
        {
          last_inventory_policy: "CONTINUE",
          preorder_whitelist: false,
          last_policy_check_at: FRESH_AUDIT,
          remote_sku: "SKU-1",
        },
      ],
    });
    const r = await getConnectionPolicyHealth({ connectionId: CONN_ID });
    expect(r.state).toBe("disconnected");
    expect(r.driftSkusSampled).toEqual([]);
  });

  it("active connection + zero mappings -> state='delayed' with empty SKU sample", async () => {
    mockTables({ conn: ACTIVE_CONN, mappings: [] });
    const r = await getConnectionPolicyHealth({ connectionId: CONN_ID });
    expect(r.state).toBe("delayed");
    expect(r.driftCount).toBe(0);
    expect(r.driftSkusSampled).toEqual([]);
  });

  it("drift mappings -> state='policy_drift' and SKUs sampled (cap honored)", async () => {
    // Build POLICY_HEALTH_DRIFT_SAMPLE_LIMIT + 3 drift rows so we can confirm
    // the cap actually fires. Mix in a whitelisted CONTINUE (must NOT count
    // as drift) and a DENY row (must NOT appear in the sample).
    const driftRows: Mapping[] = Array.from({ length: POLICY_HEALTH_DRIFT_SAMPLE_LIMIT + 3 }).map(
      (_, i) => ({
        last_inventory_policy: "CONTINUE",
        preorder_whitelist: false,
        last_policy_check_at: FRESH_AUDIT,
        remote_sku: `DRIFT-${i + 1}`,
      }),
    );
    const noiseRows: Mapping[] = [
      {
        last_inventory_policy: "CONTINUE",
        preorder_whitelist: true, // intentional, not drift
        last_policy_check_at: FRESH_AUDIT,
        remote_sku: "WHITELIST-1",
      },
      {
        last_inventory_policy: "DENY",
        preorder_whitelist: false,
        last_policy_check_at: FRESH_AUDIT,
        remote_sku: "DENY-1",
      },
    ];
    mockTables({ conn: ACTIVE_CONN, mappings: [...driftRows, ...noiseRows] });
    const r = await getConnectionPolicyHealth({ connectionId: CONN_ID });
    expect(r.state).toBe("policy_drift");
    expect(r.driftCount).toBe(driftRows.length);
    expect(r.driftSkusSampled).toHaveLength(POLICY_HEALTH_DRIFT_SAMPLE_LIMIT);
    expect(r.driftSkusSampled.every((sku) => sku.startsWith("DRIFT-"))).toBe(true);
  });

  it("whitelisted CONTINUE + DENY mix with fresh audit -> state='healthy', no SKU sample", async () => {
    mockTables({
      conn: ACTIVE_CONN,
      mappings: [
        {
          last_inventory_policy: "CONTINUE",
          preorder_whitelist: true,
          last_policy_check_at: FRESH_AUDIT,
          remote_sku: "WHITELIST-1",
        },
        {
          last_inventory_policy: "DENY",
          preorder_whitelist: false,
          last_policy_check_at: FRESH_AUDIT,
          remote_sku: "DENY-1",
        },
      ],
    });
    const r = await getConnectionPolicyHealth({ connectionId: CONN_ID });
    expect(r.state).toBe("healthy");
    expect(r.driftSkusSampled).toEqual([]);
    expect(r.lastAuditAt).toBe(FRESH_AUDIT);
  });

  // Anchor: `now` is not threaded through this loader (the helper defaults
  // to `new Date()`). The 'delayed' boundary is exercised in the helper's
  // own unit test; here we just confirm zero mappings collapses correctly.
  it("returns the connectionId on the result envelope so the UI can key by it", async () => {
    mockTables({ conn: ACTIVE_CONN, mappings: [] });
    const r = await getConnectionPolicyHealth({ connectionId: CONN_ID });
    expect(r.connectionId).toBe(CONN_ID);
  });
});

// Sentinel: NOW const is referenced once to keep the timestamp anchor visible
// at the top of the test for future hand-edits. Not part of any assertion.
void NOW;
