"use client";

import { io, type Socket } from "socket.io-client";

import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@ccp/shared/socket/events";

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Singleton client socket. Hooks subscribe/unsubscribe by joining and leaving
 * rooms; we never tear the underlying connection down.
 *
 * Safe-guard against React StrictMode in dev mounting components twice — the
 * factory only ever creates one connection per page.
 */

let socket: ClientSocket | null = null;
// One-way "this tab is on its way out" flag. Set by closeClientSocket() when
// the user signs out or deletes their org. The connection-status hook reads
// this to suppress the amber "Reconnecting…" banner during the gap between
// `socket.disconnect()` firing and the subsequent hard navigation to /logout
// — without it, the banner has time to render for ~1 frame and the user sees
// a flash they can't act on.
let teardown = false;

export function isSocketTeardown(): boolean {
  return teardown;
}

export function getClientSocket(): ClientSocket {
  if (typeof window === "undefined") {
    throw new Error("getClientSocket called on the server");
  }
  if (socket) return socket;

  // Optional cross-origin target. When the NestJS api process owns Socket.io
  // (Phase 2+ of the migration), point the browser at it via
  // `NEXT_PUBLIC_API_URL=http://localhost:4000` in dev, or leave unset in
  // prod when Caddy fronts both ports under the same hostname. Empty string
  // / unset → connect to current origin, identical to pre-migration behavior.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

  socket = io(apiUrl || undefined, {
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
    // Forwards the Better Auth session cookie so the server-side handshake
    // can authenticate. With cross-origin targets the server must also send
    // `Access-Control-Allow-Credentials: true` (NestJS WsAdapter does this).
    withCredentials: true,
  });

  // One-shot DX guard. The most common dev misconfig is "Next.js and NestJS
  // running on different ports without NEXT_PUBLIC_API_URL set" — the
  // socket falls back to same-origin (current page) where there's nothing
  // listening on /socket.io/, so the user sees "Reconnecting…" forever
  // with no obvious cause. Logging once on the first failed attempt makes
  // the cause discoverable from the browser console.
  let warned = false;
  socket.on("connect_error", (err) => {
    if (warned || teardown) return;
    warned = true;
    const target = apiUrl || `${window.location.origin} (same-origin fallback)`;
    // eslint-disable-next-line no-console
    console.warn(
      `[socket] connect_error against ${target}: ${err.message}. ` +
        (apiUrl
          ? "Verify the api process is running and reachable from the browser."
          : "Set NEXT_PUBLIC_API_URL to the NestJS api URL if running web + api on different ports in dev."),
    );
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
  teardown = true;
  if (!socket) return;
  socket.disconnect();
  socket = null;
}
