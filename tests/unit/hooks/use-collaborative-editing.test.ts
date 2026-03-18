import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock Supabase Channel ---

type PresenceCallback = (payload: { event: string }) => void;
type BroadcastCallback = (payload: { payload: Record<string, unknown> }) => void;

let presenceSyncCallback: PresenceCallback | null = null;
let broadcastSavedCallback: BroadcastCallback | null = null;
let _trackedState: Record<string, unknown> | null = null;
let presenceStateData: Record<string, Array<Record<string, unknown>>> = {};

const mockChannel = {
  on: vi.fn().mockImplementation(function (
    this: typeof mockChannel,
    type: string,
    opts: { event: string },
    cb: PresenceCallback | BroadcastCallback,
  ) {
    if (type === "presence" && opts.event === "sync") {
      presenceSyncCallback = cb as PresenceCallback;
    }
    if (type === "broadcast" && opts.event === "saved") {
      broadcastSavedCallback = cb as BroadcastCallback;
    }
    return this;
  }),
  subscribe: vi.fn().mockImplementation(async (cb: (status: string) => void) => {
    cb("SUBSCRIBED");
    return mockChannel;
  }),
  track: vi.fn().mockImplementation(async (state: Record<string, unknown>) => {
    _trackedState = state;
  }),
  untrack: vi.fn(),
  send: vi.fn(),
  presenceState: vi.fn().mockImplementation(() => presenceStateData),
};

const mockRemoveChannel = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: () => ({
    channel: vi.fn().mockReturnValue(mockChannel),
    removeChannel: mockRemoveChannel,
  }),
}));

import { useCollaborativeEditing } from "@/lib/hooks/use-collaborative-editing";

describe("useCollaborativeEditing", () => {
  const defaultOptions = {
    resourceType: "product",
    resourceId: "prod-1",
    userName: "Alice",
    userId: "user-alice",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    presenceSyncCallback = null;
    broadcastSavedCallback = null;
    _trackedState = null;
    presenceStateData = {};
  });

  it("subscribes to channel on mount and tracks presence", () => {
    renderHook(() => useCollaborativeEditing(defaultOptions));

    expect(mockChannel.on).toHaveBeenCalledTimes(2);
    expect(mockChannel.subscribe).toHaveBeenCalledTimes(1);
    expect(mockChannel.track).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-alice",
        userName: "Alice",
        editingField: null,
      }),
    );
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useCollaborativeEditing(defaultOptions));
    unmount();

    expect(mockChannel.untrack).toHaveBeenCalled();
    expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
  });

  it("returns empty activeEditors initially", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));
    expect(result.current.activeEditors).toEqual([]);
  });

  it("excludes self from activeEditors on presence sync", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    presenceStateData = {
      "key-alice": [
        { userId: "user-alice", userName: "Alice", editingField: null, joinedAt: "2025-01-01" },
      ],
      "key-bob": [
        { userId: "user-bob", userName: "Bob", editingField: "title", joinedAt: "2025-01-01" },
      ],
    };

    act(() => {
      presenceSyncCallback?.({ event: "sync" });
    });

    expect(result.current.activeEditors).toHaveLength(1);
    expect(result.current.activeEditors[0].userName).toBe("Bob");
    expect(result.current.activeEditors[0].editingField).toBe("title");
  });

  it("isFieldBeingEdited returns true when another user edits that field", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    presenceStateData = {
      "key-bob": [
        { userId: "user-bob", userName: "Bob", editingField: "price", joinedAt: "2025-01-01" },
      ],
    };

    act(() => {
      presenceSyncCallback?.({ event: "sync" });
    });

    expect(result.current.isFieldBeingEdited("price")).toBe(true);
    expect(result.current.isFieldBeingEdited("title")).toBe(false);
  });

  it("getFieldEditor returns the editor for a given field", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    presenceStateData = {
      "key-bob": [
        { userId: "user-bob", userName: "Bob", editingField: "price", joinedAt: "2025-01-01" },
      ],
    };

    act(() => {
      presenceSyncCallback?.({ event: "sync" });
    });

    const editor = result.current.getFieldEditor("price");
    expect(editor?.userName).toBe("Bob");
    expect(result.current.getFieldEditor("title")).toBeNull();
  });

  it("startEditing tracks the field via presence", async () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    await act(async () => {
      await result.current.startEditing("title");
    });

    expect(mockChannel.track).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-alice",
        userName: "Alice",
        editingField: "title",
      }),
    );
  });

  it("stopEditing clears the editing field", async () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    await act(async () => {
      await result.current.startEditing("title");
    });

    await act(async () => {
      await result.current.stopEditing();
    });

    expect(mockChannel.track).toHaveBeenLastCalledWith(
      expect.objectContaining({ editingField: null }),
    );
  });

  it("broadcastSave sends a broadcast event", async () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    await act(async () => {
      await result.current.broadcastSave(["title", "price"]);
    });

    expect(mockChannel.send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "saved",
      payload: expect.objectContaining({
        userId: "user-alice",
        userName: "Alice",
        savedFields: ["title", "price"],
      }),
    });
  });

  it("receives remote changes from broadcast events", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    act(() => {
      broadcastSavedCallback?.({
        payload: {
          userId: "user-bob",
          userName: "Bob",
          savedFields: ["description"],
          timestamp: "2025-01-01T12:00:00Z",
        },
      });
    });

    expect(result.current.remoteChanges).toHaveLength(1);
    expect(result.current.remoteChanges[0].userName).toBe("Bob");
    expect(result.current.remoteChanges[0].savedFields).toEqual(["description"]);
  });

  it("ignores broadcast events from self", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    act(() => {
      broadcastSavedCallback?.({
        payload: {
          userId: "user-alice",
          userName: "Alice",
          savedFields: ["title"],
          timestamp: "2025-01-01T12:00:00Z",
        },
      });
    });

    expect(result.current.remoteChanges).toHaveLength(0);
  });

  it("dismissChanges clears remoteChanges", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    act(() => {
      broadcastSavedCallback?.({
        payload: {
          userId: "user-bob",
          userName: "Bob",
          savedFields: ["sku"],
          timestamp: "2025-01-01T12:00:00Z",
        },
      });
    });

    expect(result.current.remoteChanges).toHaveLength(1);

    act(() => {
      result.current.dismissChanges();
    });

    expect(result.current.remoteChanges).toHaveLength(0);
  });

  it("editingFields returns field+editor pairs for active editors", () => {
    const { result } = renderHook(() => useCollaborativeEditing(defaultOptions));

    presenceStateData = {
      "key-bob": [
        { userId: "user-bob", userName: "Bob", editingField: "title", joinedAt: "2025-01-01" },
      ],
      "key-carol": [
        { userId: "user-carol", userName: "Carol", editingField: null, joinedAt: "2025-01-01" },
      ],
    };

    act(() => {
      presenceSyncCallback?.({ event: "sync" });
    });

    expect(result.current.editingFields).toHaveLength(1);
    expect(result.current.editingFields[0].field).toBe("title");
    expect(result.current.editingFields[0].editor.userName).toBe("Bob");
  });
});
