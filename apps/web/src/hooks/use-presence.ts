"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";

/**
 * Realtime online-teammate set for a team.
 *
 * Drives the green dot in the sidebar — a teammate is "online" iff they have
 * at least one open socket. The server tracks per-user socket counts so a
 * second tab closing doesn't flip the dot off.
 *
 * Identity is established at the handshake (JWT cookie). The hook fires
 * `presence:request` on mount and on every `connect` so a route-nav into
 * /inbox (no reconnect) or a long offline reconnect refreshes state without
 * a page reload — the handshake-time snapshot would otherwise have been
 * emitted before any listener was attached.
 */
export function usePresence(teamId: string, _userId: string): { onlineUserIds: Set<string> } {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const socket = getClientSocket();

    const onUpdate: Parameters<typeof socket.on<"presence:update">>[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      setOnlineUserIds(new Set(payload.onlineUserIds));
    };
    const requestSnapshot = (): void => {
      socket.emit("presence:request");
    };

    socket.on("presence:update", onUpdate);
    socket.on("connect", requestSnapshot);
    if (socket.connected) requestSnapshot();

    return () => {
      socket.off("presence:update", onUpdate);
      socket.off("connect", requestSnapshot);
    };
  }, [teamId]);

  return { onlineUserIds };
}
