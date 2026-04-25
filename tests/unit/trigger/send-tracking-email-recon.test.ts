// Slice 4 — send-tracking-email-recon per-workspace attribution.
//
// Pre-Slice-4 the recon task wrote a single sensor row whose workspace_id
// was set to a SHIPMENT id — a typing pun that violated the FK constraint
// and caused the row insert to silently fail in production.
// This test pins down the new aggregatePerWorkspace helper that the task
// now uses to compute per-workspace counts.

import { describe, expect, it } from "vitest";
import { aggregatePerWorkspace } from "@/trigger/tasks/send-tracking-email-recon";

describe("aggregatePerWorkspace (Slice 4 recon attribution fix)", () => {
  it("attributes scanned counts per workspace", () => {
    const shipments = [
      { id: "s1", workspace_id: "ws-a" },
      { id: "s2", workspace_id: "ws-a" },
      { id: "s3", workspace_id: "ws-b" },
    ];
    const result = aggregatePerWorkspace(shipments, [], 0);
    expect(result.get("ws-a")).toEqual({ scanned: 2, missing: 0, refired: 0 });
    expect(result.get("ws-b")).toEqual({ scanned: 1, missing: 0, refired: 0 });
  });

  it("DROPS shipments with workspace_id=null (sensor_readings.workspace_id is NOT NULL)", () => {
    const shipments = [
      { id: "s1", workspace_id: null },
      { id: "s2", workspace_id: "ws-a" },
    ];
    const result = aggregatePerWorkspace(shipments, [], 0);
    expect(result.has("null")).toBe(false);
    expect(result.has("")).toBe(false);
    // Only ws-a appears
    expect(Array.from(result.keys())).toEqual(["ws-a"]);
  });

  it("attributes missing expectations by joining missing.shipment_id back to the shipment row", () => {
    const shipments = [
      { id: "s1", workspace_id: "ws-a" },
      { id: "s2", workspace_id: "ws-b" },
    ];
    const missing = [
      { shipment_id: "s1", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s2", trigger_status: "delivered" as const, reason: "x" },
      { shipment_id: "s2", trigger_status: "shipped" as const, reason: "x" },
    ];
    const result = aggregatePerWorkspace(shipments, missing, 0);
    expect(result.get("ws-a")?.missing).toBe(1);
    expect(result.get("ws-b")?.missing).toBe(2);
  });

  it("ignores missing rows whose shipment_id is not in the shipment set (defensive)", () => {
    const shipments = [{ id: "s1", workspace_id: "ws-a" }];
    const missing = [
      { shipment_id: "s1", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s99-orphan", trigger_status: "shipped" as const, reason: "x" },
    ];
    const result = aggregatePerWorkspace(shipments, missing, 0);
    expect(result.get("ws-a")?.missing).toBe(1);
    expect(Array.from(result.keys())).toEqual(["ws-a"]);
  });

  it("attributes refired count proportionally by each workspace's share of missing", () => {
    // Two workspaces: ws-a has 3/4 of misses, ws-b has 1/4. Refired=8 total.
    // ws-a should get round(3/4 * 8) = 6, ws-b should get round(1/4 * 8) = 2.
    const shipments = [
      { id: "s1", workspace_id: "ws-a" },
      { id: "s2", workspace_id: "ws-a" },
      { id: "s3", workspace_id: "ws-a" },
      { id: "s4", workspace_id: "ws-b" },
    ];
    const missing = [
      { shipment_id: "s1", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s2", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s3", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s4", trigger_status: "shipped" as const, reason: "x" },
    ];
    const result = aggregatePerWorkspace(shipments, missing, 8);
    expect(result.get("ws-a")?.refired).toBe(6);
    expect(result.get("ws-b")?.refired).toBe(2);
  });

  it("refired=0 when no missing rows (no division-by-zero)", () => {
    const shipments = [{ id: "s1", workspace_id: "ws-a" }];
    const result = aggregatePerWorkspace(shipments, [], 0);
    expect(result.get("ws-a")?.refired).toBe(0);
  });

  it("refired=0 across workspaces with no missing items", () => {
    // ws-a has misses, ws-b doesn't. Only ws-a gets refired count.
    const shipments = [
      { id: "s1", workspace_id: "ws-a" },
      { id: "s2", workspace_id: "ws-b" },
    ];
    const missing = [{ shipment_id: "s1", trigger_status: "shipped" as const, reason: "x" }];
    const result = aggregatePerWorkspace(shipments, missing, 5);
    expect(result.get("ws-a")?.refired).toBe(5);
    expect(result.get("ws-b")?.refired).toBe(0);
  });

  it("handles empty input cleanly", () => {
    const result = aggregatePerWorkspace([], [], 0);
    expect(result.size).toBe(0);
  });

  it("handles many workspaces with mixed scanned/missing distributions", () => {
    const shipments = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      workspace_id: `ws-${i % 3}`,
    }));
    const missing = [
      { shipment_id: "s0", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s3", trigger_status: "shipped" as const, reason: "x" },
      { shipment_id: "s1", trigger_status: "shipped" as const, reason: "x" },
    ];
    const result = aggregatePerWorkspace(shipments, missing, 3);
    expect(result.get("ws-0")?.scanned).toBe(10);
    expect(result.get("ws-1")?.scanned).toBe(10);
    expect(result.get("ws-2")?.scanned).toBe(10);
    expect(result.get("ws-0")?.missing).toBe(2);
    expect(result.get("ws-1")?.missing).toBe(1);
    expect(result.get("ws-2")?.missing).toBe(0);
  });
});
