"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

export interface EditorPresence {
  userId: string;
  userName: string;
  editingField: string | null;
  joinedAt: string;
}

export interface RemoteChange {
  userId: string;
  userName: string;
  savedFields: string[];
  timestamp: string;
}

interface UseCollaborativeEditingOptions {
  resourceType: string;
  resourceId: string;
  userName: string;
  userId: string;
}

export function useCollaborativeEditing({
  resourceType,
  resourceId,
  userName,
  userId,
}: UseCollaborativeEditingOptions) {
  const [activeEditors, setActiveEditors] = useState<EditorPresence[]>([]);
  const [remoteChanges, setRemoteChanges] = useState<RemoteChange[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const editingFieldRef = useRef<string | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    );
    const channelName = `collab:${resourceType}:${resourceId}`;
    const channel = supabase.channel(channelName);

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<EditorPresence>();
        const editors: EditorPresence[] = [];
        for (const presences of Object.values(state)) {
          for (const p of presences) {
            if (p.userId !== userId) {
              editors.push({
                userId: p.userId,
                userName: p.userName,
                editingField: p.editingField,
                joinedAt: p.joinedAt,
              });
            }
          }
        }
        setActiveEditors(editors);
      })
      .on("broadcast", { event: "saved" }, ({ payload }) => {
        if (payload.userId !== userId) {
          setRemoteChanges((prev) => [
            ...prev,
            {
              userId: payload.userId,
              userName: payload.userName,
              savedFields: payload.savedFields,
              timestamp: payload.timestamp,
            },
          ]);
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            userId,
            userName,
            editingField: null,
            joinedAt: new Date().toISOString(),
          });
        }
      });

    channelRef.current = channel;

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [resourceType, resourceId, userName, userId]);

  const startEditing = useCallback(
    async (fieldName: string) => {
      editingFieldRef.current = fieldName;
      await channelRef.current?.track({
        userId,
        userName,
        editingField: fieldName,
        joinedAt: new Date().toISOString(),
      });
    },
    [userId, userName],
  );

  const stopEditing = useCallback(async () => {
    editingFieldRef.current = null;
    await channelRef.current?.track({
      userId,
      userName,
      editingField: null,
      joinedAt: new Date().toISOString(),
    });
  }, [userId, userName]);

  const isFieldBeingEdited = useCallback(
    (fieldName: string) => activeEditors.some((e) => e.editingField === fieldName),
    [activeEditors],
  );

  const getFieldEditor = useCallback(
    (fieldName: string) => activeEditors.find((e) => e.editingField === fieldName) ?? null,
    [activeEditors],
  );

  const broadcastSave = useCallback(
    async (savedFields: string[]) => {
      await channelRef.current?.send({
        type: "broadcast",
        event: "saved",
        payload: {
          userId,
          userName,
          savedFields,
          timestamp: new Date().toISOString(),
        },
      });
    },
    [userId, userName],
  );

  const dismissChanges = useCallback(() => {
    setRemoteChanges([]);
  }, []);

  return {
    activeEditors,
    editingFields: activeEditors
      .filter((e) => e.editingField !== null)
      .map((e) => ({ field: e.editingField as string, editor: e })),
    startEditing,
    stopEditing,
    isFieldBeingEdited,
    getFieldEditor,
    broadcastSave,
    remoteChanges,
    dismissChanges,
  };
}
