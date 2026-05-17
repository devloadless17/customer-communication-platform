"use client";

import { useEffect, useRef, useState } from "react";

import { getClientSocket, isSocketTeardown } from "@/lib/socket-client";

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

/**
 * Grace period on first mount before we surface a "reconnecting" banner.
 * The Socket.io handshake takes ~100-500ms on a healthy connection — without
 * a grace, every page refresh briefly renders the amber "Reconnecting…"
 * banner while the WS comes up. After this window we assume the server is
 * actually unreachable and start surfacing the banner.
 */
const INITIAL_CONNECT_GRACE_MS = 3000;

export function useConnectionStatus(opts?: {
  /** Fires once each time we transition back to `online` after a drop. */
  onRecovered?: () => void;
}): ConnectionStatus {
  // Optimistic start: assume online until we have proof otherwise. The lazy
  // initializer used to return "reconnecting" when the socket hadn't finished
  // its handshake yet — that's what flashed the banner on every refresh.
  const [state, setState] = useState<ConnectionState>(() => {
    if (typeof window === "undefined") return "online";
    if (!navigator.onLine) return "offline";
    return "online";
  });
  const [recovered, setRecovered] = useState(false);

  // Tracks whether we've ever actually been connected. We only flip to
  // "reconnecting" once we've either had a successful connect (any later
  // drop is a real reconnect) OR exceeded the initial-connect grace
  // (something is wrong with the server / network — surface it).
  const allowReconnectingBanner = useRef(false);
  const everDisconnected = useRef(false);
  const onRecoveredRef = useRef(opts?.onRecovered);
  useEffect(() => {
    onRecoveredRef.current = opts?.onRecovered;
  }, [opts?.onRecovered]);

  useEffect(() => {
    const socket = getClientSocket();

    const compute = (): ConnectionState => {
      // Signout / org-delete in progress: a hard nav to /logout is queued
      // behind us. Don't surface "Reconnecting…" for that doomed socket —
      // the user has nothing to do about it and the banner just flashes.
      if (isSocketTeardown()) return "online";
      if (typeof navigator !== "undefined" && !navigator.onLine) return "offline";
      if (socket.connected) return "online";
      // Pre-handshake on a fresh page load — suppress the banner. Once
      // either the grace period elapses or we've seen a real connect, this
      // gate opens and subsequent disconnects show the banner immediately.
      return allowReconnectingBanner.current ? "reconnecting" : "online";
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

    const onConnect = () => {
      // First successful connect arms the banner for any later drops.
      allowReconnectingBanner.current = true;
      apply();
    };
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

    // Grace-period timer: if we still haven't connected by the time it
    // fires, open the banner gate. This is what makes "server actually
    // down on first load" eventually visible to the user.
    const graceTimer = window.setTimeout(() => {
      if (!socket.connected) {
        allowReconnectingBanner.current = true;
        apply();
      }
    }, INITIAL_CONNECT_GRACE_MS);

    // If the socket is already connected by the time this effect runs
    // (e.g. a remount after a soft navigation), arm immediately so a later
    // drop banners without waiting for the grace timer.
    if (socket.connected) {
      allowReconnectingBanner.current = true;
    }

    apply();

    return () => {
      window.clearTimeout(graceTimer);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return { state, recovered };
}
