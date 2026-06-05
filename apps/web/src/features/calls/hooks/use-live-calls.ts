"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Team-wide count of LIVE calls (ringing or in progress) — drives the inbox
 * "Calls" badge ("2" when two agents are on calls). Seeds with one cheap fetch,
 * then debounce-refetches on the `call:*` socket frames (all fan to the team
 * room). Authoritative server count with no client-side delta accounting, so it
 * can't drift; best-effort — a failed fetch just leaves the badge as-is.
 *
 * Mirrors the AppRail's `useInboxUnread` pattern.
 */
export function useLiveCalls(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetch = async () => {
      try {
        const res = await apiFetch("/api/calls/live-count");
        if (!res.ok) return;
        const json = (await res.json()) as { count?: unknown };
        if (alive && typeof json.count === "number") setCount(json.count);
      } catch {
        // best-effort chrome — ignore transient failures
      }
    };
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 400);
    };
    void refetch();
    const socket = getClientSocket();
    socket.on("call:incoming", debounced);
    socket.on("call:ringing", debounced);
    socket.on("call:answered", debounced);
    socket.on("call:ended", debounced);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("call:incoming", debounced);
      socket.off("call:ringing", debounced);
      socket.off("call:answered", debounced);
      socket.off("call:ended", debounced);
    };
  }, []);
  return count;
}
