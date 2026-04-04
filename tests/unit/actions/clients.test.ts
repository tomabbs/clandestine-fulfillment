import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

const mockServerClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn().mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" }),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => mockServerClient,
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/shared/onboarding", () => ({
  parseOnboardingState: (state: Record<string, unknown> | null) => {
    if (!state) return [];
    return Object.entries(state).map(([key, val]) => ({
      key,
      label: key,
      completed: !!val,
    }));
  },
}));

// Import after mocks
import type { GetClientsResult, MonthlySales } from "@/actions/clients";
import {
  createClient,
  getClientBilling,
  getClientDetail,
  getClientProducts,
  getClientSales,
  getClientSettings,
  getClientShipments,
  getClientStores,
  getClients,
  updateClient,
  updateOnboardingStep,
} from "@/actions/clients";

// --- Helpers ---

/**
 * Build a Proxy-based chainable mock that resolves to `result` when awaited.
 * Any method call (.select(), .eq(), .in(), etc.) returns the same proxy.
 * Awaiting it resolves to the provided result.
 */
function chainMock(result: unknown) {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(result);
      }
      // Any method call returns a function that returns the proxy again
      return (..._args: unknown[]) => new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}

/**
 * Sets up mockFrom to return chainMock results for sequential `.from()` calls.
 * Note: requireStaff() consumes the first mockFrom call (provided in beforeEach),
 * so action data queries start from the second call onward.
 */
function setupFromSequence(results: unknown[]) {
  for (const result of results) {
    mockFrom.mockReturnValueOnce(chainMock(result));
  }
}

describe("clients server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  // === getClients ===

  describe("getClients", () => {
    it("returns empty result with unmatched count when no orgs exist", async () => {
      setupFromSequence([
        // organizations query
        { data: [], count: 0 },
        // unmatched shipments
        { count: 3 },
      ]);

      const result = await getClients();

      expect(result.clients).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.unmatchedShipments).toBe(3);
    });

    it("returns enriched client stats for each org", async () => {
      const orgA = {
        id: "org-a",
        name: "Alpha Records",
        slug: "alpha",
        billing_email: "bill@alpha.com",
        onboarding_state: {},
        created_at: "2025-01-01T00:00:00Z",
      };

      setupFromSequence([
        // organizations
        { data: [orgA], count: 1 },
        // products
        { data: [{ org_id: "org-a" }, { org_id: "org-a" }] },
        // variants
        {
          data: [
            { id: "v1", warehouse_products: { org_id: "org-a" } },
            { id: "v2", warehouse_products: { org_id: "org-a" } },
            { id: "v3", warehouse_products: { org_id: "org-a" } },
          ],
        },
        // shipments this month
        { data: [{ org_id: "org-a" }] },
        // billing snapshots
        {
          data: [
            {
              org_id: "org-a",
              grand_total: 125.5,
              stripe_invoice_id: "in_123",
              created_at: "2025-06-01",
            },
          ],
        },
        // unmatched shipments
        { count: 0 },
      ]);

      const result: GetClientsResult = await getClients();

      expect(result.clients).toHaveLength(1);
      const client = result.clients[0];
      expect(client.name).toBe("Alpha Records");
      expect(client.slug).toBe("alpha");
      expect(client.productCount).toBe(2);
      expect(client.variantCount).toBe(3);
      expect(client.shipmentsThisMonth).toBe(1);
      expect(client.lastBillingTotal).toBe(125.5);
      expect(client.stripeStatus).toBe("connected");
    });

    it("marks stripeStatus as none when no stripe_invoice_id", async () => {
      const org = {
        id: "org-b",
        name: "Beta",
        slug: "beta",
        billing_email: null,
        onboarding_state: {},
        created_at: "2025-01-01T00:00:00Z",
      };

      setupFromSequence([
        { data: [org], count: 1 },
        { data: [] },
        { data: [] },
        { data: [] },
        {
          data: [
            {
              org_id: "org-b",
              grand_total: 50,
              stripe_invoice_id: null,
              created_at: "2025-05-01",
            },
          ],
        },
        { count: 0 },
      ]);

      const result = await getClients();
      expect(result.clients[0].stripeStatus).toBe("none");
      expect(result.clients[0].lastBillingTotal).toBe(50);
    });

    it("returns null lastBillingTotal when no billing snapshots exist", async () => {
      const org = {
        id: "org-c",
        name: "Gamma",
        slug: "gamma",
        billing_email: null,
        onboarding_state: {},
        created_at: "2025-01-01T00:00:00Z",
      };

      setupFromSequence([
        { data: [org], count: 1 },
        { data: [] },
        { data: [] },
        { data: [] },
        { data: [] },
        { count: 0 },
      ]);

      const result = await getClients();
      expect(result.clients[0].lastBillingTotal).toBeNull();
      expect(result.clients[0].stripeStatus).toBe("none");
    });

    it("aggregates totalProducts and totalShipmentsThisMonth across all clients", async () => {
      const orgs = [
        {
          id: "org-1",
          name: "A",
          slug: "a",
          billing_email: null,
          onboarding_state: {},
          created_at: "2025-01-01T00:00:00Z",
        },
        {
          id: "org-2",
          name: "B",
          slug: "b",
          billing_email: null,
          onboarding_state: {},
          created_at: "2025-01-01T00:00:00Z",
        },
      ];

      setupFromSequence([
        { data: orgs, count: 2 },
        { data: [{ org_id: "org-1" }, { org_id: "org-1" }, { org_id: "org-2" }] },
        { data: [] },
        { data: [{ org_id: "org-1" }, { org_id: "org-2" }, { org_id: "org-2" }] },
        { data: [] },
        { count: 5 },
      ]);

      const result = await getClients();
      expect(result.totalProducts).toBe(3);
      expect(result.totalShipmentsThisMonth).toBe(3);
      expect(result.unmatchedShipments).toBe(5);
    });

    it("uses latest billing snapshot per org (first in desc order)", async () => {
      const org = {
        id: "org-d",
        name: "Delta",
        slug: "delta",
        billing_email: null,
        onboarding_state: {},
        created_at: "2025-01-01T00:00:00Z",
      };

      setupFromSequence([
        { data: [org], count: 1 },
        { data: [] },
        { data: [] },
        { data: [] },
        {
          data: [
            // Most recent (desc order)
            {
              org_id: "org-d",
              grand_total: 200,
              stripe_invoice_id: "in_new",
              created_at: "2025-06-01",
            },
            // Older
            {
              org_id: "org-d",
              grand_total: 100,
              stripe_invoice_id: null,
              created_at: "2025-05-01",
            },
          ],
        },
        { count: 0 },
      ]);

      const result = await getClients();
      expect(result.clients[0].lastBillingTotal).toBe(200);
      expect(result.clients[0].stripeStatus).toBe("connected");
    });

    it("passes search filter to organizations query", async () => {
      setupFromSequence([{ data: [], count: 0 }, { count: 0 }]);

      await getClients({ search: "alpha" });

      expect(mockFrom).toHaveBeenCalledWith("organizations");
    });
  });

  // === createClient ===

  describe("createClient", () => {
    it("creates org and portal settings", async () => {
      const insertMock = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "new-org" }, error: null }),
        }),
      });

      // workspaces query
      setupFromSequence([{ data: { id: "ws-1" }, error: null }]);

      // organizations insert
      mockFrom.mockReturnValueOnce({ insert: insertMock });

      // portal_admin_settings insert
      const settingsInsert = vi.fn().mockResolvedValue({ error: null });
      mockFrom.mockReturnValueOnce({ insert: settingsInsert });

      const result = await createClient({ name: "Gamma", slug: "gamma" });

      expect(result.orgId).toBe("new-org");
      expect(mockFrom).toHaveBeenCalledWith("organizations");
      expect(mockFrom).toHaveBeenCalledWith("portal_admin_settings");
    });

    it("throws when no workspace found", async () => {
      setupFromSequence([{ data: null, error: null }]);

      await expect(createClient({ name: "X", slug: "x" })).rejects.toThrow("No workspace found");
    });

    it("throws when insert fails", async () => {
      setupFromSequence([{ data: { id: "ws-1" }, error: null }]);

      const insertMock = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "duplicate slug" },
          }),
        }),
      });
      mockFrom.mockReturnValueOnce({ insert: insertMock });

      await expect(createClient({ name: "Dup", slug: "dup" })).rejects.toThrow(
        "Failed to create org: duplicate slug",
      );
    });
  });

  // === updateClient ===

  describe("updateClient", () => {
    it("updates organization fields", async () => {
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      mockFrom.mockReturnValueOnce({ update: updateMock });

      const result = await updateClient("org-1", { name: "New Name" });

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith("organizations");
      expect(updateMock).toHaveBeenCalledWith({ name: "New Name" });
    });
  });

  // === updateOnboardingStep ===

  describe("updateOnboardingStep", () => {
    it("merges step into existing onboarding state", async () => {
      // select current state
      setupFromSequence([{ data: { onboarding_state: { login: true } }, error: null }]);

      // update with merged state
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      mockFrom.mockReturnValueOnce({ update: updateMock });

      const result = await updateOnboardingStep("org-1", "store_connections", true);

      expect(result.success).toBe(true);
      expect(updateMock).toHaveBeenCalledWith({
        onboarding_state: { login: true, store_connections: true },
      });
    });

    it("handles null initial onboarding state", async () => {
      setupFromSequence([{ data: { onboarding_state: null }, error: null }]);

      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      mockFrom.mockReturnValueOnce({ update: updateMock });

      const result = await updateOnboardingStep("org-1", "login", true);

      expect(result.success).toBe(true);
      expect(updateMock).toHaveBeenCalledWith({
        onboarding_state: { login: true },
      });
    });
  });

  // === getClientDetail ===

  describe("getClientDetail", () => {
    it("returns null when org not found", async () => {
      setupFromSequence([{ data: null }]);
      const result = await getClientDetail("nonexistent");
      expect(result).toBeNull();
    });

    it("returns org with product, variant, and shipment counts", async () => {
      setupFromSequence([
        // org
        { data: { id: "org-1", name: "Test", onboarding_state: {} } },
        // products count
        { count: 5 },
        // variants
        { data: [{ id: "v1" }, { id: "v2" }, { id: "v3" }] },
        // shipments count
        { count: 10 },
      ]);

      const result = await getClientDetail("org-1");
      expect(result).not.toBeNull();
      expect(result?.productCount).toBe(5);
      expect(result?.variantCount).toBe(3);
      expect(result?.shipmentCount).toBe(10);
    });
  });

  // === getClientProducts ===

  describe("getClientProducts", () => {
    it("returns empty array when no products", async () => {
      setupFromSequence([{ data: [] }]);
      const result = await getClientProducts("org-1");
      expect(result).toEqual([]);
    });

    it("returns products with variant counts", async () => {
      setupFromSequence([
        // products
        {
          data: [
            {
              id: "p1",
              title: "Vinyl A",
              vendor: "Label",
              product_type: "LP",
              status: "active",
              created_at: "2025-01-01",
            },
            {
              id: "p2",
              title: "CD B",
              vendor: "Label",
              product_type: "CD",
              status: "draft",
              created_at: "2025-01-02",
            },
          ],
        },
        // variants
        {
          data: [{ product_id: "p1" }, { product_id: "p1" }, { product_id: "p2" }],
        },
      ]);

      const result = await getClientProducts("org-1");
      expect(result).toHaveLength(2);
      expect(result[0].variant_count).toBe(2);
      expect(result[1].variant_count).toBe(1);
    });
  });

  // === getClientShipments ===

  describe("getClientShipments", () => {
    it("returns empty array when no shipments", async () => {
      setupFromSequence([{ data: [] }]);
      const result = await getClientShipments("org-1");
      expect(result).toEqual([]);
    });

    it("enriches shipments with order numbers", async () => {
      setupFromSequence([
        // shipments
        {
          data: [
            {
              id: "s1",
              order_id: "ord-1",
              tracking_number: "1Z999",
              carrier: "UPS",
              service: "Ground",
              ship_date: "2025-06-01",
              status: "shipped",
              shipping_cost: 12.5,
              voided: false,
            },
          ],
        },
        // orders
        { data: [{ id: "ord-1", order_number: "ORD-1001" }] },
      ]);

      const result = await getClientShipments("org-1");
      expect(result).toHaveLength(1);
      expect(result[0].order_number).toBe("ORD-1001");
      expect(result[0].tracking_number).toBe("1Z999");
    });
  });

  // === getClientSales ===

  describe("getClientSales", () => {
    it("returns empty when no orders", async () => {
      setupFromSequence([{ data: [] }]);
      const result = await getClientSales("org-1");
      expect(result.months).toEqual([]);
      expect(result.totalUnits).toBe(0);
      expect(result.totalRevenue).toBe(0);
    });

    it("aggregates monthly sales correctly", async () => {
      setupFromSequence([
        // orders
        {
          data: [
            { id: "o1", total_price: 50, created_at: "2025-06-15T00:00:00Z" },
            { id: "o2", total_price: 30, created_at: "2025-06-20T00:00:00Z" },
            { id: "o3", total_price: 40, created_at: "2025-05-10T00:00:00Z" },
          ],
        },
        // order items
        {
          data: [
            { order_id: "o1", quantity: 2, price: 25 },
            { order_id: "o2", quantity: 1, price: 30 },
            { order_id: "o3", quantity: 3, price: 10 },
          ],
        },
        // shipments
        {
          data: [
            { ship_date: "2025-06-16", shipping_cost: 5.5 },
            { ship_date: "2025-05-11", shipping_cost: 3.0 },
          ],
        },
      ]);

      const result = await getClientSales("org-1");
      expect(result.months).toHaveLength(2);

      // June: 2*25 + 1*30 = 80 revenue, 5.5 cost
      const june = result.months.find((m: MonthlySales) => m.month === "2025-06");
      expect(june).toBeDefined();
      expect(june?.units).toBe(3);
      expect(june?.revenue).toBe(80);
      expect(june?.cost).toBe(5.5);

      // May: 3*10 = 30 revenue, 3.0 cost
      const may = result.months.find((m: MonthlySales) => m.month === "2025-05");
      expect(may).toBeDefined();
      expect(may?.units).toBe(3);
      expect(may?.revenue).toBe(30);
      expect(may?.cost).toBe(3);

      expect(result.totalUnits).toBe(6);
      expect(result.totalRevenue).toBe(110);
    });

    it("calculates margin percentage correctly", async () => {
      setupFromSequence([
        { data: [{ id: "o1", total_price: 100, created_at: "2025-06-01T00:00:00Z" }] },
        { data: [{ order_id: "o1", quantity: 10, price: 10 }] },
        { data: [{ ship_date: "2025-06-02", shipping_cost: 25 }] },
      ]);

      const result = await getClientSales("org-1");
      const month = result.months[0];
      // Revenue 100, cost 25, margin = (100-25)/100 = 75%
      expect(month.margin_pct).toBe(75);
    });
  });

  // === getClientBilling ===

  describe("getClientBilling", () => {
    it("returns billing snapshots", async () => {
      setupFromSequence([
        {
          data: [
            {
              id: "b1",
              billing_period: "2025-06",
              grand_total: 150,
              status: "paid",
              created_at: "2025-07-01",
            },
            {
              id: "b2",
              billing_period: "2025-05",
              grand_total: 120,
              status: "sent",
              created_at: "2025-06-01",
            },
          ],
        },
      ]);

      const result = await getClientBilling("org-1");
      expect(result).toHaveLength(2);
      expect(result[0].billing_period).toBe("2025-06");
    });

    it("returns empty array when no snapshots", async () => {
      setupFromSequence([{ data: null }]);
      const result = await getClientBilling("org-1");
      expect(result).toEqual([]);
    });
  });

  // === getClientStores ===

  describe("getClientStores", () => {
    it("returns ShipStation stores for org", async () => {
      setupFromSequence([
        {
          data: [
            {
              id: "ss1",
              store_name: "Main Store",
              marketplace_name: "Shopify",
              store_id: 12345,
              created_at: "2025-01-01",
            },
          ],
        },
        { data: [] },
      ]);

      const result = await getClientStores("org-1");
      expect(result.legacy).toHaveLength(1);
      expect(result.legacy[0].store_name).toBe("Main Store");
    });

    it("returns empty arrays when no stores", async () => {
      setupFromSequence([{ data: null }, { data: null }]);
      const result = await getClientStores("org-1");
      expect(result.legacy).toEqual([]);
      expect(result.connections).toEqual([]);
    });
  });

  // === getClientSettings ===

  describe("getClientSettings", () => {
    it("returns org, portal settings, and billing rules", async () => {
      setupFromSequence([
        // org
        {
          data: {
            id: "org-1",
            service_type: "full_service",
            shopify_vendor_name: "TestVendor",
            pirate_ship_name: "PIRATE-1",
            stripe_customer_id: "cus_123",
            storage_fee_waived: false,
          },
        },
        // portal settings
        { data: { settings: { show_inventory: true, show_billing: false } } },
        // billing rules
        {
          data: [
            { rule_name: "Base Fee", rule_type: "per_shipment", amount: 3.5, is_active: true },
          ],
        },
      ]);

      const result = await getClientSettings("org-1");
      expect(result.org?.service_type).toBe("full_service");
      expect(result.portalSettings).toEqual({ show_inventory: true, show_billing: false });
      expect(result.billingRules).toHaveLength(1);
      expect(result.billingRules[0].rule_name).toBe("Base Fee");
    });

    it("returns empty portal settings when none configured", async () => {
      setupFromSequence([{ data: { id: "org-1" } }, { data: null }, { data: [] }]);

      const result = await getClientSettings("org-1");
      expect(result.portalSettings).toEqual({});
      expect(result.billingRules).toEqual([]);
    });
  });
});
