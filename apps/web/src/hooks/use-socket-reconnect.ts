"use client";

import { useEffect, useRef } from "react";

import { getClientSocket } from "@/lib/socket-client";

/**
 * Shared reconnect / visibility wiring for socket-driven hooks.
 *
 * Encapsulates the skeleton every realtime hook had inlined by hand:
 *   - a firstConnect-skip gate: the initial `connect` is the mount subscription
 *     (SSR/mount data is already current), so ONLY genuine reconnects — a drop
 *     longer than Socket.io's 30s connection-state-recovery window, a deploy /
 *     Caddy bounce, a WiFi hop — fire `onReconnect`.
 *   - an immediate `if (socket.connected) onConnect()`: the shared socket
 *     singleton is usually already connected by the time an effect runs, so no
 *     fresh `connect` event fires — burn the first-connect here so the NEXT real
 *     `connect` is correctly treated as a reconnect.
 *   - an optional `visibilitychange` handler: fires `onVisible` when the tab
 *     returns to the foreground (a backgrounded / throttled tab can miss frames
 *     while the socket stays nominally connected).
 *
 * Callbacks are read through refs so the internal effect can stay mounted for
 * the socket singleton's lifetime without re-binding on every render — pass
 * inline closures freely; the latest one always runs. Any debounce / coalescing
 * a consumer wants stays in its own callback.
 */
export function useSocketReconnect(
  onReconnect: () => void,
  onVisible?: () => void,
): void {
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  // Static per call site (a hook either wants the visibility branch or not), so
  // it's safe to decide listener registration once on mount.
  const wantsVisible = onVisible !== undefined;

  useEffect(() => {
    const socket = getClientSocket();
    const firstConnectRef = { value: true };
    const onConnect = () => {
      // First connect = the initial subscription; mount/SSR data already covers
      // it. Every later connect is a reconnect after a drop past the recovery
      // window.
      if (firstConnectRef.value) {
        firstConnectRef.value = false;
        return;
      }
      onReconnectRef.current();
    };
    const onVisibilityChange = () => {
      if (
        typeof document === "undefined" ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      onVisibleRef.current?.();
    };

    socket.on("connect", onConnect);
    // Burn the first-connect skip for the already-connected singleton.
    if (socket.connected) onConnect();
    if (wantsVisible && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      socket.off("connect", onConnect);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [wantsVisible]);
}
