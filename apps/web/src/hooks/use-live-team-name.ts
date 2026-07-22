"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";

/**
 * Read the team's display name with live updates. Initialized from the
 * SSR-rendered prop, then patched in place when a `team:renamed` socket
 * frame lands (driven either by THIS tab's optimistic dispatch or by a
 * different admin/tab renaming via the team-room fanout). One subscription
 * per consumer; cleanup on unmount.
 *
 * No filter on `payload.workspaceId` — a socket session is single-team; the
 * server only routes frames for the team it belongs to.
 */
export function useLiveTeamName(initial: string): string {
  const [name, setName] = useState(initial);
  // Accept new SSR-rendered values (RSC refresh / route change).
  useEffect(() => setName(initial), [initial]);
  useEffect(() => {
    const socket = getClientSocket();
    const onRenamed: Parameters<typeof socket.on<"team:renamed">>[1] = (payload) => {
      setName(payload.name);
    };
    socket.on("team:renamed", onRenamed);
    return () => {
      socket.off("team:renamed", onRenamed);
    };
  }, []);
  return name;
}
