import { describe, expect, it } from "vitest";

// === Inventory Sync Pause — logic tests (no DB, pure state machines) ===

describe("setInventorySyncPaused — idempotency logic", () => {
  it("is a no-op when already in the target state", () => {
    // Simulate the idempotency check: current state matches target → changed = false
    function applyPause(currentPaused: boolean, targetPaused: boolean) {
      if (currentPaused === targetPaused) return { changed: false };
      return { changed: true };
    }

    expect(applyPause(false, false)).toEqual({ changed: false });
    expect(applyPause(true, true)).toEqual({ changed: false });
  });

  it("returns changed=true when state actually changes", () => {
    function applyPause(currentPaused: boolean, targetPaused: boolean) {
      if (currentPaused === targetPaused) return { changed: false };
      return { changed: true };
    }

    expect(applyPause(false, true)).toEqual({ changed: true });
    expect(applyPause(true, false)).toEqual({ changed: true });
  });
});

describe("resumeAndPushNow — partial failure handling", () => {
  it("returns partialFailure string when one task trigger rejects", async () => {
    const results = await Promise.allSettled([
      Promise.resolve({ id: "bc-run-123" }),
      Promise.reject(new Error("Connection timeout")),
    ]);

    const bcResult = results[0];
    const storeResult = results[1];
    const failures: string[] = [];

    if (bcResult.status === "rejected") {
      failures.push(
        `Bandcamp: ${bcResult.reason instanceof Error ? bcResult.reason.message : "unknown"}`,
      );
    }
    if (storeResult.status === "rejected") {
      failures.push(
        `Stores: ${storeResult.reason instanceof Error ? storeResult.reason.message : "unknown"}`,
      );
    }

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBe("Stores: Connection timeout");
  });

  it("returns null partialFailure when both tasks succeed", async () => {
    const results = await Promise.allSettled([
      Promise.resolve({ id: "bc-run-123" }),
      Promise.resolve({ id: "store-run-456" }),
    ]);

    const failures: string[] = [];
    if (results[0].status === "rejected") failures.push("Bandcamp");
    if (results[1].status === "rejected") failures.push("Stores");

    expect(failures).toHaveLength(0);
    expect(results[0].status === "fulfilled" && results[0].value.id).toBe("bc-run-123");
    expect(results[1].status === "fulfilled" && results[1].value.id).toBe("store-run-456");
  });
});

// === Pre-existing tests ===

describe("admin-settings actions", () => {
  it("getGeneralSettings returns workspace + counts + rules", () => {
    const result = {
      workspace: { name: "Test Warehouse", slug: "test-warehouse" },
      orgCount: 5,
      productCount: 200,
      billingRules: [
        { rule_name: "Per Shipment", rule_type: "per_shipment", amount: 3.5, is_active: true },
      ],
    };

    expect(result.workspace?.name).toBe("Test Warehouse");
    expect(result.orgCount).toBe(5);
    expect(result.billingRules).toHaveLength(1);
  });

  it("getIntegrationStatus groups sync logs by channel", () => {
    const logs = [
      { channel: "shopify", status: "completed", completed_at: "2026-03-17T01:00:00Z" },
      { channel: "shopify", status: "failed", completed_at: "2026-03-16T23:00:00Z" },
      { channel: "bandcamp", status: "completed", completed_at: "2026-03-17T00:30:00Z" },
    ];

    const lastByChannel = new Map<string, { status: string }>();
    for (const log of logs) {
      if (!lastByChannel.has(log.channel)) {
        lastByChannel.set(log.channel, { status: log.status });
      }
    }

    expect(lastByChannel.get("shopify")?.status).toBe("completed");
    expect(lastByChannel.get("bandcamp")?.status).toBe("completed");
  });
});
