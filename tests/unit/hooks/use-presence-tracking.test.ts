import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock Supabase Channel ---

type PresenceCallback = () => void;

let presenceSyncCallback: PresenceCallback | null = null;
let presenceStateData: Record<string, Array<Record<string, unknown>>> = {};

const mockChannel = {
  on: vi.fn().mockImplementation(function (
    this: typeof mockChannel,
    _type: string,
    _opts: { event: string },
    cb: PresenceCallback,
  ) {
    presenceSyncCallback = cb;
    return this;
  }),
  subscribe: vi.fn().mockImplementation(async (cb: (status: string) => void) => {
    cb("SUBSCRIBED");
    return mockChannel;
  }),
  track: vi.fn(),
  untrack: vi.fn(),
  presenceState: vi.fn().mockImplementation(() => presenceStateData),
};

const mockRemoveChannel = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: () => ({
    channel: vi.fn().mockReturnValue(mockChannel),
    removeChannel: mockRemoveChannel,
  }),
}));

import { usePresenceTracking } from "@/lib/hooks/use-presence-tracking";

describe("usePresenceTracking", () => {
  const defaultUser = {
    userId: "user-1",
    userName: "Alice",
    role: "admin",
    currentPage: "/admin/products",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    presenceSyncCallback = null;
    presenceStateData = {};
  });

  it("subscribes to presence:warehouse channel", () => {
    renderHook(() => usePresenceTracking(defaultUser));

    expect(mockChannel.subscribe).toHaveBeenCalledTimes(1);
    expect(mockChannel.track).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        userName: "Alice",
        role: "admin",
        currentPage: "/admin/products",
      }),
    );
  });

  it("returns empty onlineUsers initially", () => {
    const { result } = renderHook(() => usePresenceTracking(defaultUser));
    expect(result.current.onlineUsers).toEqual([]);
    expect(result.current.onlineCount).toBe(0);
  });

  it("updates onlineUsers on presence sync", () => {
    const { result } = renderHook(() => usePresenceTracking(defaultUser));

    presenceStateData = {
      "key-1": [
        {
          userId: "user-1",
          userName: "Alice",
          role: "admin",
          currentPage: "/admin/products",
        },
      ],
      "key-2": [
        {
          userId: "user-2",
          userName: "Bob",
          role: "warehouse_manager",
          currentPage: "/admin/scan",
        },
      ],
    };

    act(() => {
      presenceSyncCallback?.();
    });

    expect(result.current.onlineUsers).toHaveLength(2);
    expect(result.current.onlineCount).toBe(2);
    expect(result.current.onlineUsers.map((u) => u.userName)).toContain("Alice");
    expect(result.current.onlineUsers.map((u) => u.userName)).toContain("Bob");
  });

  it("cleans up on unmount", () => {
    const { unmount } = renderHook(() => usePresenceTracking(defaultUser));
    unmount();

    expect(mockChannel.untrack).toHaveBeenCalled();
    expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
  });

  it("tracks currentPage from user prop", () => {
    renderHook(() =>
      usePresenceTracking({
        ...defaultUser,
        currentPage: "/admin/billing",
      }),
    );

    expect(mockChannel.track).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: "/admin/billing" }),
    );
  });
});
