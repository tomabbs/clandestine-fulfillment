/**
 * Order Pages Transition Phase 0 — invalidateOrderSurfaces contract tests.
 *
 * The contract is that every documented `OrderSurfaceKind` maps to the
 * route paths described in the Cache Contract Addendum. The CI guard
 * forbids inline `revalidatePath('/admin/orders'` outside of this file,
 * so these tests function as the single point of truth that enforces the
 * addendum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

import { invalidateOrderSurfaces } from "@/lib/server/invalidate-order-surfaces";

describe("invalidateOrderSurfaces", () => {
  beforeEach(() => {
    revalidatePathMock.mockReset();
  });
  afterEach(() => {
    revalidatePathMock.mockReset();
  });

  function capturedPaths(): string[] {
    return Array.from(
      new Set(revalidatePathMock.mock.calls.map((args) => args[0] as string)),
    ).sort();
  }

  it("direct.list invalidates /admin/orders + /admin/orders-legacy", async () => {
    await invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["direct.list"] });
    expect(capturedPaths()).toEqual(["/admin/orders", "/admin/orders-legacy"]);
  });

  it("mirror.list invalidates /admin/orders + /admin/orders/shipstation", async () => {
    await invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["mirror.list"] });
    expect(capturedPaths()).toEqual(["/admin/orders", "/admin/orders/shipstation"]);
  });

  it("mirrorLinks invalidates orders + mirror + diagnostics", async () => {
    await invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["mirrorLinks"] });
    expect(capturedPaths()).toEqual([
      "/admin/orders",
      "/admin/orders/diagnostics",
      "/admin/orders/shipstation",
    ]);
  });

  it("holds invalidates only /admin/orders/holds", async () => {
    await invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["holds"] });
    expect(capturedPaths()).toEqual(["/admin/orders/holds"]);
  });

  it("preorderDashboard invalidates /admin/preorders", async () => {
    await invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["preorderDashboard"] });
    expect(capturedPaths()).toEqual(["/admin/preorders"]);
  });

  it("transitionDiagnostics invalidates /admin/orders/diagnostics", async () => {
    await invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["transitionDiagnostics"] });
    expect(capturedPaths()).toEqual(["/admin/orders/diagnostics"]);
  });

  it("writebackStatus invalidates /admin/orders + per-order detail when id provided", async () => {
    await invalidateOrderSurfaces({
      workspaceId: "w1",
      warehouseOrderId: "order-123",
      kinds: ["writebackStatus"],
    });
    expect(capturedPaths()).toEqual(["/admin/orders", "/admin/orders/order-123"]);
  });

  it("dedupes across multiple kinds", async () => {
    await invalidateOrderSurfaces({
      workspaceId: "w1",
      kinds: ["direct.list", "mirror.list"],
    });
    expect(capturedPaths()).toEqual([
      "/admin/orders",
      "/admin/orders-legacy",
      "/admin/orders/shipstation",
    ]);
  });

  it("swallows revalidatePath errors so callers cannot abort on cache failures", async () => {
    revalidatePathMock.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(
      invalidateOrderSurfaces({ workspaceId: "w1", kinds: ["direct.list"] }),
    ).resolves.toBeUndefined();
  });
});
