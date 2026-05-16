"use client";

import { io, type Socket } from "socket.io-client";

import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@/lib/socket/events";

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Singleton client socket. Hooks subscribe/unsubscribe by joining and leaving
 * rooms; we never tear the underlying connection down.
 *
 * Safe-guard against React StrictMode in dev mounting components twice — the
 * factory only ever creates one connection per page.
 */

let socket: ClientSocket | null = null;

export function getClientSocket(): ClientSocket {
  if (typeof window === "undefined") {
    throw new Error("getClientSocket called on the server");
  }
  if (socket) return socket;

  socket = io({
    path: SOCKET_PATH,
    transports: ["websocket", "polling"],
    autoConnect: true,
    reconnection: true,
    // Exponential backoff with jitter. Fixed 500ms re-tries would dog-pile
    // the server when a whole team reconnects after a deploy or transient
    // outage. The first reconnect is fast (~500ms-625ms) so a momentary
    // hiccup recovers instantly; subsequent attempts back off geometrically
    // to a 5s ceiling. `randomizationFactor` adds ±25% jitter to each delay
    // so a team of N agents doesn't all retry at the same millisecond.
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.25,
    // Same-origin: forwards the Better Auth session cookie so the server-side
    // io.use() middleware can authenticate the handshake.
    withCredentials: true,
  });

  return socket;
}

/**
 * Tear the singleton down. Called on sign-out so:
 *   1) the server fires a `disconnect` for this socket and removes the user
 *      from the presence set (other tabs see the green dot drop immediately),
 *   2) the now-signed-out tab can't keep receiving team events if Next does
 *      a soft client-side nav to /login instead of a hard reload.
 *
 * `disconnect()` also opts out of Socket.io's auto-reconnect, which is what
 * we want here.
 */
export function closeClientSocket(): void {
  if (!socket) return;
  socket.disconnect();
  socket = null;
}
