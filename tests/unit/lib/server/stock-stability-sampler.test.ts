/**
 * Unit tests for pure sampler helpers.
 *
 * Scope: `src/lib/server/stock-stability-sampler.ts`.
 *
 * We assert the 15-minute bucketing (idempotency foundation), the row
 * shape (so the insert payload matches the `stock_stability_readings`
 * schema), dedup, ATP math, and the purge-cutoff math.
 */

import { describe, expect, it } from "vitest";
import {
  bucketObservedAt,
  buildPurgeCutoff,
  buildPurgeCutoffIso,
  buildWarehouseSampleRows,
  mergeVariantUniverse,
  SAMPLER_BUCKET_MS,
  SAMPLER_RETENTION_DAYS,
  SAMPLER_WAREHOUSE_SOURCE,
} from "@/lib/server/stock-stability-sampler";

describe("bucketObservedAt", () => {
  it.each([
    ["2026-04-26T14:37:23.123Z", "2026-04-26T14:30:00.000Z"],
    ["2026-04-26T14:44:59.999Z", "2026-04-26T14:30:00.000Z"],
    ["2026-04-26T14:45:00.000Z", "2026-04-26T14:45:00.000Z"],
    ["2026-04-26T14:45:00.001Z", "2026-04-26T14:45:00.000Z"],
    ["2026-04-26T15:00:00.000Z", "2026-04-26T15:00:00.000Z"],
    ["2026-04-26T00:07:30.000Z", "2026-04-26T00:00:00.000Z"],
  ])("floors %s -> %s", (input, expected) => {
    const result = bucketObservedAt(new Date(input));
    expect(result.toISOString()).toBe(expected);
  });

  it("returns a fresh instance on every call (safe to mutate)", () => {
    const input = new Date("2026-04-26T14:30:00Z");
    const first = bucketObservedAt(input);
    const second = bucketObservedAt(input);
    expect(first).not.toBe(second);
    expect(first.toISOString()).toBe(second.toISOString());
  });

  it("throws on invalid dates", () => {
    expect(() => bucketObservedAt(new Date("not-a-date"))).toThrow();
  });

  it("SAMPLER_BUCKET_MS exports 15-minute constant", () => {
    expect(SAMPLER_BUCKET_MS).toBe(15 * 60 * 1000);
  });
});

describe("buildWarehouseSampleRows", () => {
  const workspaceId = "00000000-0000-0000-0000-000000000001";
  const observedAt = new Date("2026-04-26T14:30:00Z");
  const samplerRunId = "sampler:2026-04-26T14:30:00.000Z";

  it("shapes one row per variant with ATP = max(0, available - max(0, committed))", () => {
    const rows = buildWarehouseSampleRows({
      workspaceId,
      samplerRunId,
      observedAt,
      levels: [
        { variant_id: "v-1", available: 10, committed_quantity: 3 },
        { variant_id: "v-2", available: 5, committed_quantity: 7 },
        { variant_id: "v-3", available: 0, committed_quantity: null },
        { variant_id: "v-4", available: null, committed_quantity: null },
        { variant_id: "v-5", available: 4, committed_quantity: -2 },
      ],
    });

    expect(rows).toHaveLength(5);

    expect(rows[0]).toMatchObject({
      workspace_id: workspaceId,
      variant_id: "v-1",
      source: SAMPLER_WAREHOUSE_SOURCE,
      observed_at: "2026-04-26T14:30:00.000Z",
      observed_at_local: "2026-04-26T14:30:00.000Z",
      available: 10,
      committed: 3,
      atp: 7,
      remote_stock_listed: null,
      clock_skew_ms: null,
      sampler_run_id: samplerRunId,
    });

    expect(rows[1]).toMatchObject({ variant_id: "v-2", available: 5, committed: 7, atp: 0 });
    expect(rows[2]).toMatchObject({ variant_id: "v-3", available: 0, committed: null, atp: 0 });
    expect(rows[3]).toMatchObject({
      variant_id: "v-4",
      available: null,
      committed: null,
      atp: null,
    });
    expect(rows[4]).toMatchObject({ variant_id: "v-5", available: 4, committed: 0, atp: 4 });
  });

  it("dedupes variant_ids, preserving first occurrence", () => {
    const rows = buildWarehouseSampleRows({
      workspaceId,
      samplerRunId,
      observedAt,
      levels: [
        { variant_id: "v-1", available: 10, committed_quantity: 3 },
        { variant_id: "v-1", available: 99, committed_quantity: 99 },
        { variant_id: "v-2", available: 5, committed_quantity: 7 },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ variant_id: "v-1", available: 10 });
    expect(rows[1]).toMatchObject({ variant_id: "v-2", available: 5 });
  });

  it("skips rows with a non-string variant_id", () => {
    const rows = buildWarehouseSampleRows({
      workspaceId,
      samplerRunId,
      observedAt,
      levels: [
        { variant_id: "", available: 10, committed_quantity: 3 },
        { variant_id: null as unknown as string, available: 10, committed_quantity: 3 },
        { variant_id: "v-1", available: 10, committed_quantity: 3 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variant_id).toBe("v-1");
  });

  it("returns an empty array for an empty universe", () => {
    const rows = buildWarehouseSampleRows({
      workspaceId,
      samplerRunId,
      observedAt,
      levels: [],
    });
    expect(rows).toEqual([]);
  });
});

describe("buildPurgeCutoff / buildPurgeCutoffIso", () => {
  it("subtracts the default 30-day retention", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    const cutoff = buildPurgeCutoff(now);
    expect(cutoff.toISOString()).toBe("2026-03-27T00:00:00.000Z");
  });

  it("accepts a custom retention window", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    expect(buildPurgeCutoff(now, 1).toISOString()).toBe("2026-04-25T00:00:00.000Z");
    expect(buildPurgeCutoff(now, 7).toISOString()).toBe("2026-04-19T00:00:00.000Z");
  });

  it("rejects non-positive retentionDays", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    expect(() => buildPurgeCutoff(now, 0)).toThrow();
    expect(() => buildPurgeCutoff(now, -1)).toThrow();
    expect(() => buildPurgeCutoff(now, Number.NaN)).toThrow();
  });

  it("ISO variant returns the same result as .toISOString()", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    expect(buildPurgeCutoffIso(now)).toBe(buildPurgeCutoff(now).toISOString());
  });

  it("SAMPLER_RETENTION_DAYS exports 30d default", () => {
    expect(SAMPLER_RETENTION_DAYS).toBe(30);
  });
});

describe("mergeVariantUniverse", () => {
  it("returns deduped union preserving order", () => {
    const merged = mergeVariantUniverse(["v-1", "v-2", "v-3"], ["v-2", "v-4"], ["v-5", "v-1"]);
    expect(merged).toEqual(["v-1", "v-2", "v-3", "v-4", "v-5"]);
  });

  it("filters null/undefined/empty-string entries", () => {
    const merged = mergeVariantUniverse(["v-1", null, undefined, "", "v-2"]);
    expect(merged).toEqual(["v-1", "v-2"]);
  });

  it("returns empty array for no inputs", () => {
    expect(mergeVariantUniverse()).toEqual([]);
  });
});
