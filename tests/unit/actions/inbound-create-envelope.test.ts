import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAuth = vi.fn();
const mockCreateServiceRoleClient = vi.fn();
const mockTaskTrigger = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/lib/server/supabase-server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/supabase-server")>(
    "@/lib/server/supabase-server",
  );
  return {
    ...actual,
    createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
  };
});

vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: (...args: unknown[]) => mockTaskTrigger(...args),
  },
}));

describe("inbound create action envelopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskTrigger.mockResolvedValue({ id: "task-1" });
  });

  it("returns structured error for invalid inbound input", async () => {
    const { createInbound } = await import("../../../src/actions/inbound");
    const result = await createInbound({
      items: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("required inbound fields");
    }
  });

  it("returns org-assignment error when user has no org", async () => {
    mockRequireAuth.mockResolvedValue({
      userRecord: { id: "u1", workspace_id: "ws1", org_id: null, role: "client" },
    });
    mockCreateServiceRoleClient.mockReturnValue({ from: vi.fn() });

    const { createInbound } = await import("../../../src/actions/inbound");
    const result = await createInbound({
      items: [{ title: "Record LP", expected_quantity: 1 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not linked to an organization");
    }
  });

  it("returns success envelope when shipment + items insert succeed", async () => {
    mockRequireAuth.mockResolvedValue({
      userRecord: { id: "u1", workspace_id: "ws1", org_id: "org1", role: "client" },
    });

    const from = vi.fn((table: string) => {
      if (table === "warehouse_inbound_shipments") {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: "ship-1" }, error: null }),
            }),
          }),
        };
      }
      if (table === "warehouse_inbound_items") {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: [{ id: "item-1", sku: "PENDING-abc12345" }],
              error: null,
            }),
          }),
        };
      }
      if (table === "warehouse_product_variants") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }
      return {};
    });
    mockCreateServiceRoleClient.mockReturnValue({ from });

    const { createInbound } = await import("../../../src/actions/inbound");
    const result = await createInbound({
      tracking_number: "1ZTEST",
      items: [{ title: "New Vinyl", expected_quantity: 2 }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.id).toBe("ship-1");
    }
    expect(mockTaskTrigger).toHaveBeenCalled();
  });
});
