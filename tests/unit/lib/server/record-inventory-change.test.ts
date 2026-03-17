import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
const mockAdjustInventory = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/clients/redis-inventory", () => ({
  adjustInventory: (...args: unknown[]) => mockAdjustInventory(...args),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    rpc: mockRpc,
  }),
}));

import { recordInventoryChange } from "@/lib/server/record-inventory-change";

describe("recordInventoryChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const baseParams = {
    workspaceId: "ws-1",
    sku: "SKU-001",
    delta: -2,
    source: "shopify" as const,
    correlationId: "wh:abc123",
    metadata: { order_id: "order-1" },
  };

  describe("execution order (Rule #43)", () => {
    it("calls Redis before Postgres", async () => {
      const callOrder: string[] = [];

      mockAdjustInventory.mockImplementation(async () => {
        callOrder.push("redis");
        return 8;
      });
      mockRpc.mockImplementation(async () => {
        callOrder.push("postgres");
        return { error: null };
      });

      await recordInventoryChange(baseParams);

      expect(callOrder).toEqual(["redis", "postgres"]);
    });

    it("passes correct args to Redis adjustInventory", async () => {
      mockAdjustInventory.mockResolvedValue(8);
      mockRpc.mockResolvedValue({ error: null });

      await recordInventoryChange(baseParams);

      expect(mockAdjustInventory).toHaveBeenCalledWith("SKU-001", "available", -2, "wh:abc123");
    });

    it("passes correct args to Postgres RPC (Rule #64)", async () => {
      mockAdjustInventory.mockResolvedValue(8);
      mockRpc.mockResolvedValue({ error: null });

      await recordInventoryChange(baseParams);

      expect(mockRpc).toHaveBeenCalledWith("record_inventory_change_txn", {
        p_workspace_id: "ws-1",
        p_sku: "SKU-001",
        p_delta: -2,
        p_source: "shopify",
        p_correlation_id: "wh:abc123",
        p_metadata: { order_id: "order-1" },
      });
    });
  });

  describe("idempotency", () => {
    it("returns alreadyProcessed=true when Redis returns null", async () => {
      mockAdjustInventory.mockResolvedValue(null);

      const result = await recordInventoryChange(baseParams);

      expect(result).toEqual({
        success: true,
        newQuantity: null,
        alreadyProcessed: true,
      });
      // Postgres should NOT be called when already processed
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe("success path", () => {
    it("returns success with new quantity when both steps succeed", async () => {
      mockAdjustInventory.mockResolvedValue(8);
      mockRpc.mockResolvedValue({ error: null });

      const result = await recordInventoryChange(baseParams);

      expect(result).toEqual({
        success: true,
        newQuantity: 8,
        alreadyProcessed: false,
      });
    });

    it("defaults metadata to empty object when not provided", async () => {
      mockAdjustInventory.mockResolvedValue(10);
      mockRpc.mockResolvedValue({ error: null });

      await recordInventoryChange({
        workspaceId: "ws-1",
        sku: "SKU-001",
        delta: 5,
        source: "manual",
        correlationId: "manual:user:123",
      });

      expect(mockRpc).toHaveBeenCalledWith(
        "record_inventory_change_txn",
        expect.objectContaining({ p_metadata: {} }),
      );
    });
  });

  describe("error handling", () => {
    it("returns success=false when Postgres RPC fails (Redis drift case)", async () => {
      mockAdjustInventory.mockResolvedValue(8);
      mockRpc.mockResolvedValue({ error: { message: "DB connection error" } });

      const result = await recordInventoryChange(baseParams);

      expect(result).toEqual({
        success: false,
        newQuantity: 8,
        alreadyProcessed: false,
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Postgres RPC failed after Redis write"),
      );
    });

    it("handles Postgres RPC exception", async () => {
      mockAdjustInventory.mockResolvedValue(8);
      mockRpc.mockRejectedValue(new Error("Network timeout"));

      const result = await recordInventoryChange(baseParams);

      expect(result).toEqual({
        success: false,
        newQuantity: 8,
        alreadyProcessed: false,
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Postgres RPC exception after Redis write"),
        expect.any(Error),
      );
    });

    it("does NOT roll back Redis when Postgres fails (reconciliation sensor catches drift)", async () => {
      mockAdjustInventory.mockResolvedValue(8);
      mockRpc.mockResolvedValue({ error: { message: "constraint violation" } });

      await recordInventoryChange(baseParams);

      // Redis adjustInventory should have been called exactly once (no rollback call)
      expect(mockAdjustInventory).toHaveBeenCalledTimes(1);
    });
  });
});
