"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSocketReconnect } from "@/hooks/use-socket-reconnect";

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
  // Guards the async setCount against a post-unmount write, and holds the single
  // debounce timer SHARED by the call:* frames + the reconnect trigger — so a
  // reconnect landing within 400ms of a call frame still coalesces to one GET.
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await apiFetch("/api/calls/live-count");
      if (!res.ok) return;
      const json = (await res.json()) as { count?: unknown };
      if (aliveRef.current && typeof json.count === "number") setCount(json.count);
    } catch {
      // best-effort chrome — ignore transient failures
    }
  }, []);
  const debounced = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void refetch(), 400);
  }, [refetch]);

  // Reconvergence: a call:ended frame missed while offline (past the 30s socket
  // recovery window) would leave the badge stuck — call events are rare, so
  // unlike unread there's no steady frame to self-heal. Refetch on every real
  // reconnect so we always converge to the authoritative server count.
  useSocketReconnect(debounced);

  useEffect(() => {
    aliveRef.current = true;
    void refetch();
    const socket = getClientSocket();
    socket.on("call:incoming", debounced);
    socket.on("call:ringing", debounced);
    socket.on("call:answered", debounced);
    socket.on("call:ended", debounced);
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      socket.off("call:incoming", debounced);
      socket.off("call:ringing", debounced);
      socket.off("call:answered", debounced);
      socket.off("call:ended", debounced);
    };
  }, [refetch, debounced]);
  return count;
}
