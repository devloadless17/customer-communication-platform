"use client";

import { flushSync } from "react-dom";
import { io, type Socket } from "socket.io-client";

import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@ccp/shared/socket/events";

import { BROWSER_API_BASE } from "./api/browser-base";

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

  // Recreating the socket means we're past the previous teardown — clear the
  // flag so the connection-status banner can show again on the new session.
  // Without this, signing back in within the same SPA session leaves the
  // banner permanently suppressed.
  teardown = false;

  // Optional cross-origin target — see BROWSER_API_BASE for the resolution
  // rules. Dev cross-port points here at the NestJS api; prod (Caddy) leaves
  // it empty for same-origin fallback.
  const apiUrl = BROWSER_API_BASE;

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
    // Server-side handshake middleware throws `new Error("unauthenticated")`
    // when the session cookie is missing/expired. Socket.io serializes
    // err.message into this event verbatim. Auto-reconnect would otherwise
    // retry forever with the same dead cookie. Route to /logout — which
    // clears the cookie and bounces to /login.
    if (err.message === "unauthenticated") {
      teardown = true;
      try {
        socket?.disconnect();
      } finally {
        socket = null;
      }
      if (window.location.pathname !== "/logout") {
        window.location.href = "/logout";
      }
      return;
    }
    // Transient classes: auth backend is degraded (Postgres flap) OR the
    // handshake rate-limit caught a reconnect storm. In both cases the
    // server is telling us "retry, don't log out." Socket.io's reconnect
    // loop applies its exponential-with-jitter backoff. Log once so a
    // sustained outage is discoverable from the console.
    if (
      err.message === "auth_unavailable" ||
      err.message === "handshake_throttled"
    ) {
      if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[socket] transient connect_error: ${err.message}. ` +
            `Backing off and reconnecting.`,
        );
      }
      return;
    }
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

  // Reset the one-shot warning on every successful (re)connect so a "worked,
  // dropped, came back, dropped again" sequence logs each new outage instead
  // of going silent after the first failure.
  socket.on("connect", () => {
    warned = false;
  });

  return socket;
}

// -----------------------------------------------------------------------
// Local event bus — backstop path for optimistic dispatches.
//
// The original implementation iterated `socket.listeners(event)` and fired
// each handler directly. That worked for the right-rail panel + thread
// header (their listeners ran sync), but the conversation list sidebar
// kept lagging by ~1s — the user reported it consistently, even when the
// other surfaces flipped within a frame.
//
// The relevant difference: the sidebar's listener (useTeamEvents) updates
// state at the InboxShell root, which is a large render. The right-rail's
// listener updates a state local to ContactPanel, which is a tiny render.
// Both setStates ARE scheduled in the same batch, but React 18's
// concurrent renderer is free to pre-empt the InboxShell render between
// commits if it considers it lower-priority — so the right rail's tiny
// re-render commits in the same frame as the click while the heavy
// inbox-shell tree slips into a later frame.
//
// flushSync forces the listener loop to run inside a synchronous commit:
// every setState fired by the dispatched listeners is flushed before the
// dispatch function returns. The two surfaces commit together.
//
// The localBus also gives us a second, socket-independent subscription
// path so any consumer that wants to be 100% sure to receive optimistic
// frames can subscribe via `onLocalSocketEvent` instead of (or in
// addition to) `socket.on`. Useful if a future change moves a listener
// outside React tree where socket.io's lifecycle becomes opaque.
// -----------------------------------------------------------------------
type AnyListener = (payload: unknown) => void;
const localBus = new Map<string, Set<AnyListener>>();

export function onLocalSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  fn: (payload: Parameters<ServerToClientEvents[E]>[0]) => void,
): void {
  const key = event as string;
  let set = localBus.get(key);
  if (!set) {
    set = new Set();
    localBus.set(key, set);
  }
  set.add(fn as AnyListener);
}

export function offLocalSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  fn: (payload: Parameters<ServerToClientEvents[E]>[0]) => void,
): void {
  const set = localBus.get(event as string);
  if (!set) return;
  set.delete(fn as AnyListener);
}

/**
 * Fire a `ServerToClient` event LOCALLY (no network round-trip). Used for
 * optimistic UI when the client knows the change it's about to persist —
 * dispatching the same frame the server will eventually broadcast lets every
 * existing subscriber (sidebar counts, displayed thread reducer, LRU cache)
 * update instantly. The real server frame arriving moments later is absorbed
 * by reducers' identity / no-op bails — the second pass is harmless.
 *
 * Wrapped in `flushSync` so every state update queued by the dispatched
 * listeners is forced to commit before this function returns. Without it,
 * React 18's concurrent renderer was committing the small subtree updates
 * (right-rail ContactPanel via setLiveStatus) inside the click frame but
 * deferring the big InboxShell root update (sidebar conversation list via
 * setConversations) by hundreds of ms — which is what the user kept reporting
 * as "right-rail instant, left sidebar 1s lag".
 */
export function dispatchLocalSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): void {
  const s = socket;
  // Collect every listener once so the iteration is stable even if a handler
  // mutates the listener arrays (e.g. a useEffect cleanup fires mid-loop).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socketListeners: AnyListener[] = s ? (s.listeners(event as any) as AnyListener[]).slice() : [];
  const localListeners = localBus.get(event as string);
  const localCopy: AnyListener[] = localListeners ? Array.from(localListeners) : [];
  const all = socketListeners.length + localCopy.length;
  if (all === 0) return;

  const run = () => {
    for (const fn of socketListeners) {
      try {
        fn(payload);
      } catch (err) {
        // A misbehaving subscriber must not break the optimistic UX.
        // eslint-disable-next-line no-console
        console.error(`[socket] local dispatch ${String(event)} subscriber threw`, err);
      }
    }
    for (const fn of localCopy) {
      try {
        fn(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[socket] local-bus dispatch ${String(event)} subscriber threw`, err);
      }
    }
  };

  // flushSync errors when called during a render phase. The dispatch sites
  // (dropdown onSelect handlers, openConversation callback, etc.) all fire
  // from user events, not from render — so flushSync is safe. Guard anyway:
  // a stray render-phase caller falls back to plain iteration rather than
  // throwing.
  try {
    flushSync(run);
  } catch {
    run();
  }
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
