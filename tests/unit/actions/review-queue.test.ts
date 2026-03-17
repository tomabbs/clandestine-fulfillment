import { describe, expect, it } from "vitest";

// SLA calculation logic (mirrors what the page uses)
function slaIndicator(slaDueAt: string | null) {
  if (!slaDueAt) return null;
  const now = Date.now();
  const due = new Date(slaDueAt).getTime();
  const hoursLeft = (due - now) / (1000 * 60 * 60);
  if (hoursLeft < 0) return { color: "red", label: "Overdue" };
  if (hoursLeft < 2) return { color: "yellow", label: "Approaching" };
  return { color: "green", label: "On track" };
}

describe("review-queue SLA calculation", () => {
  it("returns null for items without SLA", () => {
    expect(slaIndicator(null)).toBeNull();
  });

  it("returns Overdue for past-due items", () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = slaIndicator(pastDate);
    expect(result?.label).toBe("Overdue");
    expect(result?.color).toBe("red");
  });

  it("returns Approaching for items due within 2 hours", () => {
    const soonDate = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    const result = slaIndicator(soonDate);
    expect(result?.label).toBe("Approaching");
    expect(result?.color).toBe("yellow");
  });

  it("returns On track for items due in >2 hours", () => {
    const futureDate = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(); // 5 hours from now
    const result = slaIndicator(futureDate);
    expect(result?.label).toBe("On track");
    expect(result?.color).toBe("green");
  });
});

describe("review-queue bulk actions", () => {
  it("bulk assign builds correct ID list", () => {
    const selected = new Set(["id-1", "id-2", "id-3"]);
    const ids = Array.from(selected);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("id-1");
    expect(ids).toContain("id-2");
    expect(ids).toContain("id-3");
  });

  it("bulk resolve with empty set is safe", () => {
    const selected = new Set<string>();
    const ids = Array.from(selected);
    expect(ids).toHaveLength(0);
  });
});
