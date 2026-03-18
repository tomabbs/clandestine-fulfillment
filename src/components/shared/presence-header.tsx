"use client";

import type { OnlineUser } from "@/lib/hooks/use-presence-tracking";

const MAX_VISIBLE_USERS = 5;

interface PresenceHeaderProps {
  onlineUsers: OnlineUser[];
}

export function PresenceHeader({ onlineUsers }: PresenceHeaderProps) {
  if (onlineUsers.length === 0) return null;

  const visible = onlineUsers.slice(0, MAX_VISIBLE_USERS);
  const overflow = onlineUsers.length - MAX_VISIBLE_USERS;

  return (
    <div className="flex items-center gap-2 ml-auto">
      <div className="flex items-center gap-1.5">
        {visible.map((user) => (
          <div key={user.userId} className="flex items-center gap-1" title={user.userName}>
            <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
            <span className="text-xs text-muted-foreground whitespace-nowrap">{user.userName}</span>
          </div>
        ))}
        {overflow > 0 && <span className="text-xs text-muted-foreground">+{overflow}</span>}
      </div>
    </div>
  );
}
