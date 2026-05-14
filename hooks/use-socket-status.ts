"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";

/**
 * Reactive view of the websocket's connection state. Lights up the green dot
 * in the sidebar when we're talking to the server; switches to red the
 * moment the transport drops so the user knows their inbox is stale.
 */
export function useSocketStatus(): { connected: boolean } {
  const [connected, setConnected] = useState(() => {
    if (typeof window === "undefined") return false;
    return getClientSocket().connected;
  });

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
