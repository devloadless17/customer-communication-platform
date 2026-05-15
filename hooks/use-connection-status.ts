"use client";

import { useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";

/**
 * Combined view of the client's network and realtime state. Drives the
 * connection banner and reconnect-side-effects (auto-refresh of stale data).
 *
 * Why two signals rather than one:
 *   - `navigator.onLine` catches "wifi went down", "laptop closed", "ethernet
 *     unplugged" — browser-level disconnects. It does NOT catch backend or
 *     reverse-proxy outages.
 *   - Socket.io's connect/disconnect events catch backend outages and
 *     transient WS drops, but say nothing about whether the user has
 *     internet at all.
 *
 * The combined state collapses both into a single semantic value:
 *   - `online`        — everything's fine. Banner hidden.
 *   - `reconnecting`  — browser claims online, socket is down. Backend dropped
 *                       us; Socket.io is auto-reconnecting in the background.
 *   - `offline`       — browser says we're offline. Sends will fail fast.
 *
 * `wasDisconnected` arms the "refresh on recovery" side-effect: when state
 * returns to `online` AFTER a real drop, consumers re-fetch server-rendered
 * data so events missed during the gap don't stay silently lost. The first
 * mount doesn't count as a recovery.
 */

export type ConnectionState = "online" | "reconnecting" | "offline";

export interface ConnectionStatus {
  state: ConnectionState;
  /** True if we recently came back from a disconnect — clears on next render
   *  cycle for consumers that want a one-shot effect. Use the
   *  `onRecovered` callback for a more ergonomic API. */
  recovered: boolean;
}

export function useConnectionStatus(opts?: {
  /** Fires once each time we transition back to `online` after a drop. */
  onRecovered?: () => void;
}): ConnectionStatus {
  const [state, setState] = useState<ConnectionState>(() => {
    if (typeof window === "undefined") return "online";
    if (!navigator.onLine) return "offline";
    return getClientSocket().connected ? "online" : "reconnecting";
  });
  const [recovered, setRecovered] = useState(false);

  // Track the previous state to distinguish "first-mount online" from
  // "online again after a drop". Only the latter should trigger refreshes.
  const everDisconnected = useRef(false);
  const onRecoveredRef = useRef(opts?.onRecovered);
  useEffect(() => {
    onRecoveredRef.current = opts?.onRecovered;
  }, [opts?.onRecovered]);

  useEffect(() => {
    const socket = getClientSocket();

    const compute = () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return "offline";
      return socket.connected ? "online" : "reconnecting";
    };

    const apply = () => {
      const next = compute();
      setState((prev) => {
        if (prev === next) return prev;
        if (prev !== "online" && next === "online" && everDisconnected.current) {
          // Real recovery — arm the flag and fire the callback once.
          setRecovered(true);
          onRecoveredRef.current?.();
          // Drop the flag on the next tick so consumers can use it in a
          // useEffect without it sticking around.
          queueMicrotask(() => setRecovered(false));
        }
        if (next !== "online") {
          everDisconnected.current = true;
        }
        return next;
      });
    };

    const onConnect = () => apply();
    const onDisconnect = () => apply();
    const onOnline = () => {
      // Browser regained network — nudge the socket so we don't wait for its
      // backoff to retry. Cheap no-op if already connected.
      if (!socket.connected) socket.connect();
      apply();
    };
    const onOffline = () => apply();

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // Initial reconcile (in case state diverged between the lazy initializer
    // and effect mount — e.g. an offline event fired between them).
    apply();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return { state, recovered };
}
