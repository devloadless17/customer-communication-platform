"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";

/**
 * Realtime online-teammate set for a team.
 *
 * Drives the green dot in the sidebar — a teammate is "online" iff they have
 * at least one open socket. The server tracks per-user socket counts so a
 * second tab closing doesn't flip the dot off.
 *
 * Identity is established at the handshake (JWT cookie), so this hook just
 * listens for `presence:update` snapshots — no client "hello" needed.
 */
export function usePresence(teamId: string, _userId: string): { onlineUserIds: Set<string> } {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const socket = getClientSocket();

    const onUpdate: Parameters<typeof socket.on<"presence:update">>[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      setOnlineUserIds(new Set(payload.onlineUserIds));
    };
    socket.on("presence:update", onUpdate);

    return () => {
      socket.off("presence:update", onUpdate);
    };
  }, [teamId]);

  return { onlineUserIds };
}
