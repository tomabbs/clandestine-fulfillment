import { describe, expect, it } from "vitest";
import {
  criticalItemsStatus,
  driftStatus,
  propagationLagStatus,
  syncStalenessStatus,
  unpaidInvoiceStatus,
  webhookSilenceDetected,
} from "@/trigger/lib/sensors";

describe("sensor threshold logic", () => {
  describe("driftStatus", () => {
    it("healthy when no mismatches", () => {
      expect(driftStatus(0)).toBe("healthy");
    });

    it("warning for 1-5 mismatches", () => {
      expect(driftStatus(1)).toBe("warning");
      expect(driftStatus(5)).toBe("warning");
    });

    it("critical for >5 mismatches", () => {
      expect(driftStatus(6)).toBe("critical");
      expect(driftStatus(100)).toBe("critical");
    });
  });

  describe("propagationLagStatus (Rule #71)", () => {
    it("fresh when <5 minutes", () => {
      expect(propagationLagStatus(0)).toBe("healthy");
      expect(propagationLagStatus(4.9)).toBe("healthy");
    });

    it("warning (delayed) when 5-30 minutes", () => {
      expect(propagationLagStatus(5)).toBe("warning");
      expect(propagationLagStatus(29)).toBe("warning");
    });

    it("critical (stale) when >=30 minutes", () => {
      expect(propagationLagStatus(30)).toBe("critical");
      expect(propagationLagStatus(120)).toBe("critical");
    });
  });

  describe("syncStalenessStatus", () => {
    it("healthy when recently synced", () => {
      expect(syncStalenessStatus(10)).toBe("healthy");
    });

    it("warning when 30-120 min since sync", () => {
      expect(syncStalenessStatus(45)).toBe("warning");
    });

    it("critical when >120 min since sync", () => {
      expect(syncStalenessStatus(150)).toBe("critical");
    });

    it("critical when never synced (null)", () => {
      expect(syncStalenessStatus(null)).toBe("critical");
    });

    it("supports custom thresholds", () => {
      expect(syncStalenessStatus(15, 10, 60)).toBe("warning");
      expect(syncStalenessStatus(5, 10, 60)).toBe("healthy");
    });
  });

  describe("webhookSilenceDetected (Rule #17)", () => {
    it("detects silence when webhooks >6hr ago but poller finds orders", () => {
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
      expect(webhookSilenceDetected(sevenHoursAgo, new Date().toISOString(), true)).toBe(true);
    });

    it("no silence when webhooks are recent", () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      expect(webhookSilenceDetected(oneHourAgo, new Date().toISOString(), true)).toBe(false);
    });

    it("no silence when poller found no orders", () => {
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
      expect(webhookSilenceDetected(sevenHoursAgo, new Date().toISOString(), false)).toBe(false);
    });

    it("no silence when no webhook ever received", () => {
      expect(webhookSilenceDetected(null, new Date().toISOString(), true)).toBe(false);
    });
  });

  describe("unpaidInvoiceStatus", () => {
    it("healthy when no overdue invoices", () => {
      expect(unpaidInvoiceStatus(0)).toBe("healthy");
    });

    it("warning when any overdue", () => {
      expect(unpaidInvoiceStatus(1)).toBe("warning");
      expect(unpaidInvoiceStatus(5)).toBe("warning");
    });
  });

  describe("criticalItemsStatus", () => {
    it("healthy when no open critical items", () => {
      expect(criticalItemsStatus(0)).toBe("healthy");
    });

    it("warning when critical items are stale", () => {
      expect(criticalItemsStatus(3)).toBe("warning");
    });
  });
});
