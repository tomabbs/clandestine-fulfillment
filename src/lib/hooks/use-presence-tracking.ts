"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";

export interface OnlineUser {
  userId: string;
  userName: string;
  role: string;
  currentPage: string;
}

export function usePresenceTracking(user: {
  userId: string;
  userName: string;
  role: string;
  currentPage: string;
}) {
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    );
    const channel = supabase.channel("presence:warehouse");

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<OnlineUser>();
        const users: OnlineUser[] = [];
        for (const presences of Object.values(state)) {
          for (const p of presences) {
            users.push({
              userId: p.userId,
              userName: p.userName,
              role: p.role,
              currentPage: p.currentPage,
            });
          }
        }
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            userId: user.userId,
            userName: user.userName,
            role: user.role,
            currentPage: user.currentPage,
          });
        }
      });

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
    };
  }, [user.userId, user.userName, user.role, user.currentPage]);

  return {
    onlineUsers,
    onlineCount: onlineUsers.length,
  };
}
