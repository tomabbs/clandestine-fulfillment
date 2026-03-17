import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fns
const mockHgetall = vi.fn();
const mockHset = vi.fn();
const mockEval = vi.fn();
const mockPipelineHset = vi.fn();
const mockPipelineExec = vi.fn();

vi.mock("@upstash/redis", () => {
  return {
    Redis: class MockRedis {
      hgetall = mockHgetall;
      hset = mockHset;
      eval = mockEval;
      pipeline() {
        return { hset: mockPipelineHset, exec: mockPipelineExec };
      }
    },
  };
});

vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    UPSTASH_REDIS_REST_URL: "https://test.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
  }),
}));

import {
  _ADJUST_LUA_SCRIPT,
  adjustInventory,
  bulkSetInventory,
  getInventory,
  setInventory,
} from "@/lib/clients/redis-inventory";

describe("redis-inventory", () => {
  beforeEach(() => {
    mockHgetall.mockReset();
    mockHset.mockReset();
    mockEval.mockReset();
    mockPipelineHset.mockReset();
    mockPipelineExec.mockReset();
  });

  describe("getInventory", () => {
    it("returns parsed inventory levels from HGETALL", async () => {
      mockHgetall.mockResolvedValue({
        available: "10",
        committed: "3",
        incoming: "5",
      });

      const result = await getInventory("SKU-001");

      expect(mockHgetall).toHaveBeenCalledWith("inv:SKU-001");
      expect(result).toEqual({ available: 10, committed: 3, incoming: 5 });
    });

    it("returns zeros when key does not exist", async () => {
      mockHgetall.mockResolvedValue(null);

      const result = await getInventory("SKU-MISSING");

      expect(result).toEqual({ available: 0, committed: 0, incoming: 0 });
    });

    it("handles partial data (missing fields default to 0)", async () => {
      mockHgetall.mockResolvedValue({ available: "7" });

      const result = await getInventory("SKU-PARTIAL");

      expect(result).toEqual({ available: 7, committed: 0, incoming: 0 });
    });
  });

  describe("setInventory", () => {
    it("calls HSET with provided fields", async () => {
      mockHset.mockResolvedValue("OK");

      await setInventory("SKU-001", { available: 10, committed: 2 });

      expect(mockHset).toHaveBeenCalledWith("inv:SKU-001", {
        available: 10,
        committed: 2,
      });
    });

    it("skips HSET when no fields provided", async () => {
      await setInventory("SKU-001", {});

      expect(mockHset).not.toHaveBeenCalled();
    });

    it("filters out undefined values", async () => {
      mockHset.mockResolvedValue("OK");

      await setInventory("SKU-001", { available: 5, committed: undefined });

      expect(mockHset).toHaveBeenCalledWith("inv:SKU-001", { available: 5 });
    });
  });

  describe("adjustInventory", () => {
    it("calls Lua script with correct keys and args", async () => {
      mockEval.mockResolvedValue(8);

      const result = await adjustInventory("SKU-001", "available", -2, "wh:abc123");

      expect(mockEval).toHaveBeenCalledWith(
        _ADJUST_LUA_SCRIPT,
        ["processed:wh:abc123", "inv:SKU-001"],
        ["available", -2],
      );
      expect(result).toBe(8);
    });

    it("returns null when idempotency key already exists (duplicate)", async () => {
      mockEval.mockResolvedValue(null);

      const result = await adjustInventory("SKU-001", "available", -2, "wh:abc123");

      expect(result).toBeNull();
    });

    it("handles positive delta (incoming stock)", async () => {
      mockEval.mockResolvedValue(15);

      const result = await adjustInventory("SKU-001", "incoming", 5, "inbound:xyz");

      expect(mockEval).toHaveBeenCalledWith(
        _ADJUST_LUA_SCRIPT,
        ["processed:inbound:xyz", "inv:SKU-001"],
        ["incoming", 5],
      );
      expect(result).toBe(15);
    });
  });

  describe("Lua script structure", () => {
    it("uses SETNX for idempotency check", () => {
      expect(_ADJUST_LUA_SCRIPT).toContain("SETNX");
    });

    it("sets 86400s expiry on idempotency key", () => {
      expect(_ADJUST_LUA_SCRIPT).toContain("EXPIRE");
      expect(_ADJUST_LUA_SCRIPT).toContain("86400");
    });

    it("uses HINCRBY for atomic increment", () => {
      expect(_ADJUST_LUA_SCRIPT).toContain("HINCRBY");
    });

    it("returns nil when SETNX fails (already processed)", () => {
      expect(_ADJUST_LUA_SCRIPT).toContain("return nil");
    });

    it("matches the exact Rule #47 contract", () => {
      expect(_ADJUST_LUA_SCRIPT).toContain("KEYS[1]");
      expect(_ADJUST_LUA_SCRIPT).toContain("KEYS[2]");
      expect(_ADJUST_LUA_SCRIPT).toContain("ARGV[1]");
      expect(_ADJUST_LUA_SCRIPT).toContain("ARGV[2]");
    });
  });

  describe("bulkSetInventory", () => {
    it("pipelines HSET calls for all entries", async () => {
      mockPipelineExec.mockResolvedValue([]);

      await bulkSetInventory([
        { sku: "SKU-001", levels: { available: 10, committed: 2 } },
        { sku: "SKU-002", levels: { available: 5 } },
      ]);

      expect(mockPipelineHset).toHaveBeenCalledTimes(2);
      expect(mockPipelineHset).toHaveBeenCalledWith("inv:SKU-001", {
        available: 10,
        committed: 2,
      });
      expect(mockPipelineHset).toHaveBeenCalledWith("inv:SKU-002", { available: 5 });
      expect(mockPipelineExec).toHaveBeenCalledOnce();
    });

    it("skips entries with no fields", async () => {
      mockPipelineExec.mockResolvedValue([]);

      await bulkSetInventory([
        { sku: "SKU-001", levels: { available: 10 } },
        { sku: "SKU-002", levels: {} },
      ]);

      expect(mockPipelineHset).toHaveBeenCalledTimes(1);
    });

    it("handles empty entries array", async () => {
      mockPipelineExec.mockResolvedValue([]);

      await bulkSetInventory([]);

      expect(mockPipelineHset).not.toHaveBeenCalled();
      expect(mockPipelineExec).toHaveBeenCalledOnce();
    });
  });
});
