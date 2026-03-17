import { describe, expect, it } from "vitest";
import { shouldSkipSku } from "@/trigger/tasks/redis-backfill";

describe("redis-backfill", () => {
  describe("shouldSkipSku — race condition protection (Rule #27)", () => {
    it("skips SKU when last_redis_write_at is after backfill start", () => {
      const backfillStartedAt = "2026-03-17T08:00:00.000Z";
      const lastRedisWriteAt = "2026-03-17T08:00:01.000Z"; // 1 second after

      expect(shouldSkipSku(lastRedisWriteAt, backfillStartedAt)).toBe(true);
    });

    it("does NOT skip when last_redis_write_at is before backfill start", () => {
      const backfillStartedAt = "2026-03-17T08:00:00.000Z";
      const lastRedisWriteAt = "2026-03-17T07:59:59.000Z"; // 1 second before

      expect(shouldSkipSku(lastRedisWriteAt, backfillStartedAt)).toBe(false);
    });

    it("does NOT skip when last_redis_write_at is null (never written)", () => {
      const backfillStartedAt = "2026-03-17T08:00:00.000Z";

      expect(shouldSkipSku(null, backfillStartedAt)).toBe(false);
    });

    it("does NOT skip when timestamps are exactly equal", () => {
      const timestamp = "2026-03-17T08:00:00.000Z";

      expect(shouldSkipSku(timestamp, timestamp)).toBe(false);
    });

    it("handles writes hours after backfill started", () => {
      const backfillStartedAt = "2026-03-17T03:00:00.000Z";
      const lastRedisWriteAt = "2026-03-17T03:15:00.000Z";

      expect(shouldSkipSku(lastRedisWriteAt, backfillStartedAt)).toBe(true);
    });
  });

  describe("mismatch detection", () => {
    it("backfill result tracks skipped live writes separately from updates", () => {
      // Simulates the stats tracking
      const levels = [
        { sku: "A", last_redis_write_at: "2026-03-17T02:00:00Z" }, // before start → update
        { sku: "B", last_redis_write_at: "2026-03-17T04:00:00Z" }, // after start → skip
        { sku: "C", last_redis_write_at: null }, // null → update
      ];

      const backfillStartedAt = "2026-03-17T03:00:00Z";
      let updated = 0;
      let skipped = 0;

      for (const level of levels) {
        if (shouldSkipSku(level.last_redis_write_at, backfillStartedAt)) {
          skipped++;
        } else {
          updated++;
        }
      }

      expect(updated).toBe(2);
      expect(skipped).toBe(1);
    });
  });
});
