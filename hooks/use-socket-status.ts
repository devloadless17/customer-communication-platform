"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";

/**
 * Reactive view of the websocket's connection state. Lights up the green dot
 * in the sidebar when we're talking to the server; switches to red the
 * moment the transport drops so the user knows their inbox is stale.
 */
export function useSocketStatus(): { connected: boolean } {
  // Always start as `false`. Reading `socket.connected` in the initializer
  // SSR-rendered `false` but the client mount could read `true` (the
  // module-level socket can connect before React commits), and that delta
  // lit up as a React hydration mismatch in the sidebar status dot. The
  // useEffect below resyncs the real value on the first post-hydration
  // render — one extra render, no flicker, no warning.
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getClientSocket();
    setConnected(socket.connected);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  return { connected };
}
