/**
 * Phase 0 / §9.1 D3 — `auditShopifyPolicy` Server Action tests.
 *
 * Pins the contract:
 *   1. Staff-only — non-staff callers get 'Forbidden — staff only'.
 *   2. Connection validation — non-Shopify connections are rejected.
 *   3. fixMode='audit_only' — runs audit, never enqueues a Trigger task.
 *   4. fixMode='fix_drift' with drift > 0 — enqueues `shopify-policy-fix`
 *      via tasks.trigger and returns the run id.
 *   5. fixMode='fix_drift' with drift = 0 — does NOT enqueue, returns
 *      enqueuedRunId='' (no-op signal).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRequireAuth, mockServiceFrom, mockTasksTrigger, mockAuditConnection } = vi.hoisted(
  () => ({
    mockRequireAuth: vi.fn(),
    mockServiceFrom: vi.fn(),
    mockTasksTrigger: vi.fn(),
    mockAuditConnection: vi.fn(),
  }),
);

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: mockRequireAuth,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: vi.fn() }, from: vi.fn() }),
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTasksTrigger },
}));

vi.mock("@/trigger/tasks/shopify-policy-audit", () => ({
  auditShopifyConnection: mockAuditConnection,
}));

import { auditShopifyPolicy } from "@/actions/shopify-policy";

// ── Helpers ────────────────────────────────────────────────────────────────

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

const SHOPIFY_CONN = {
  id: "22222222-2222-4222-8222-222222222222",
  workspace_id: "ws-1",
  store_url: "https://shop.example.com",
  platform: "shopify",
  api_key: "shpat_xxx",
};

function mockConnLookup(row: typeof SHOPIFY_CONN | null) {
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === "client_store_connections") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("auditShopifyPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-staff callers", async () => {
    mockRequireAuth.mockResolvedValueOnce(CLIENT_AUTH);
    await expect(auditShopifyPolicy({ connectionId: SHOPIFY_CONN.id })).rejects.toThrow(
      /staff only/i,
    );
    expect(mockTasksTrigger).not.toHaveBeenCalled();
    expect(mockAuditConnection).not.toHaveBeenCalled();
  });

  it("rejects non-Shopify connections", async () => {
    mockRequireAuth.mockResolvedValueOnce(STAFF_AUTH);
    mockConnLookup({ ...SHOPIFY_CONN, platform: "bandcamp" });
    await expect(auditShopifyPolicy({ connectionId: SHOPIFY_CONN.id })).rejects.toThrow(
      /only applies to Shopify/i,
    );
    expect(mockAuditConnection).not.toHaveBeenCalled();
  });

  it("audit_only: runs audit, returns report, never enqueues Trigger task", async () => {
    mockRequireAuth.mockResolvedValueOnce(STAFF_AUTH);
    mockConnLookup(SHOPIFY_CONN);
    mockAuditConnection.mockResolvedValueOnce({
      connectionId: SHOPIFY_CONN.id,
      workspaceId: "ws-1",
      storeUrl: SHOPIFY_CONN.store_url,
      status: "ok",
      variantsScanned: 100,
      mappingsUpdated: 100,
      driftCount: 5,
      driftSkus: ["SKU-A", "SKU-B", "SKU-C", "SKU-D", "SKU-E"],
      unmappedSkipped: 0,
    });

    const result = await auditShopifyPolicy({
      connectionId: SHOPIFY_CONN.id,
      fixMode: "audit_only",
    });

    expect(result.mode).toBe("audit_only");
    expect(mockTasksTrigger).not.toHaveBeenCalled();
    expect(mockAuditConnection).toHaveBeenCalledTimes(1);
    if (result.mode === "audit_only") {
      expect(result.report.driftCount).toBe(5);
    }
  });

  it("fix_drift with driftCount > 0: enqueues shopify-policy-fix and returns run id", async () => {
    mockRequireAuth.mockResolvedValueOnce(STAFF_AUTH);
    mockConnLookup(SHOPIFY_CONN);
    mockAuditConnection.mockResolvedValueOnce({
      connectionId: SHOPIFY_CONN.id,
      workspaceId: "ws-1",
      storeUrl: SHOPIFY_CONN.store_url,
      status: "ok",
      variantsScanned: 100,
      mappingsUpdated: 100,
      driftCount: 3,
      driftSkus: ["SKU-A", "SKU-B", "SKU-C"],
      unmappedSkipped: 0,
    });
    mockTasksTrigger.mockResolvedValueOnce({ id: "run_abc123" });

    const result = await auditShopifyPolicy({
      connectionId: SHOPIFY_CONN.id,
      fixMode: "fix_drift",
    });

    expect(mockTasksTrigger).toHaveBeenCalledTimes(1);
    expect(mockTasksTrigger).toHaveBeenCalledWith("shopify-policy-fix", {
      connectionId: SHOPIFY_CONN.id,
      workspaceId: "ws-1",
      triggeredBy: STAFF_AUTH.userRecord.id,
    });
    expect(result.mode).toBe("fix_drift");
    if (result.mode === "fix_drift") {
      expect(result.enqueuedRunId).toBe("run_abc123");
      expect(result.driftCount).toBe(3);
    }
  });

  it("fix_drift with driftCount=0: does NOT enqueue, returns empty run id", async () => {
    mockRequireAuth.mockResolvedValueOnce(STAFF_AUTH);
    mockConnLookup(SHOPIFY_CONN);
    mockAuditConnection.mockResolvedValueOnce({
      connectionId: SHOPIFY_CONN.id,
      workspaceId: "ws-1",
      storeUrl: SHOPIFY_CONN.store_url,
      status: "ok",
      variantsScanned: 100,
      mappingsUpdated: 100,
      driftCount: 0,
      driftSkus: [],
      unmappedSkipped: 0,
    });

    const result = await auditShopifyPolicy({
      connectionId: SHOPIFY_CONN.id,
      fixMode: "fix_drift",
    });

    expect(mockTasksTrigger).not.toHaveBeenCalled();
    expect(result.mode).toBe("fix_drift");
    if (result.mode === "fix_drift") {
      expect(result.enqueuedRunId).toBe("");
      expect(result.driftCount).toBe(0);
    }
  });

  it("fix_drift when audit returned non-ok status: does NOT enqueue (avoid fixing partial data)", async () => {
    mockRequireAuth.mockResolvedValueOnce(STAFF_AUTH);
    mockConnLookup(SHOPIFY_CONN);
    mockAuditConnection.mockResolvedValueOnce({
      connectionId: SHOPIFY_CONN.id,
      workspaceId: "ws-1",
      storeUrl: SHOPIFY_CONN.store_url,
      status: "scope_error",
      error: "missing scope: read_products",
      variantsScanned: 0,
      mappingsUpdated: 0,
      driftCount: 0,
      driftSkus: [],
      unmappedSkipped: 0,
    });

    const result = await auditShopifyPolicy({
      connectionId: SHOPIFY_CONN.id,
      fixMode: "fix_drift",
    });

    expect(mockTasksTrigger).not.toHaveBeenCalled();
    if (result.mode === "fix_drift") {
      expect(result.enqueuedRunId).toBe("");
    }
  });
});
