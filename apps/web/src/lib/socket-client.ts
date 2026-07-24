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

  // Debug / E2E handle on the singleton. Lets console debugging and the
  // reconnect e2e force a real disconnect+reconnect cycle
  // (`window.__ccpSocket.disconnect(); .connect()`) — Playwright's
  // context.setOffline does NOT reliably close an already-open WebSocket, so
  // it can't exercise the `connect`-driven reconnect-convergence paths. Inert
  // and low-risk: any same-origin script already has full access to the page.
  (window as unknown as { __ccpSocket?: ClientSocket }).__ccpSocket = socket;

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
    // The session is VALID but the app is gating this user — their org is
    // pending review / suspended, or their email isn't verified. Stop the
    // socket (there is nothing to stream, and retrying would loop), but do NOT
    // go to /logout: that DELETES a good session, and the member ends up on a
    // context-free /login rather than the /pending screen explaining the
    // suspension, or the /verify screen that would unblock them.
    //
    // Reload instead. The gate lives in the server-rendered (app) layout, so a
    // reload routes them to the right explanation screen with no client-side
    // duplicate of the rule. Guarded against a loop: the gate screens live
    // outside (app) and never open a socket, so this can only fire once.
    if (err.message === "session_gated") {
      teardown = true;
      try {
        socket?.disconnect();
      } finally {
        socket = null;
      }
      window.location.reload();
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

  // Deploy-safe reconnect. When the api drains sockets on SIGTERM it sends a
  // namespace DISCONNECT packet ('io server disconnect'), and Socket.io's
  // client does NOT auto-reconnect after that reason — so without this every
  // deploy would leave agents on a dead socket ("Reconnecting…" never fires)
  // until they manually reload. Manually reconnect in that case; the new api
  // instance is up within the compose grace window. teardown-guarded so a
  // deliberate eviction (unauthenticated → /logout above) never loops. Other
  // reasons ('transport close', 'ping timeout') already auto-reconnect.
  socket.on("disconnect", (reason) => {
    if (reason === "io server disconnect" && !teardown) {
      socket?.connect();
    }
  });

  return socket;
}

// -----------------------------------------------------------------------
// Optimistic local dispatch.
//
// The original implementation iterated `socket.listeners(event)` and fired
// each handler directly. That worked for the right-rail panel + thread
// header (their listeners ran sync), but the conversation list sidebar kept
// lagging by ~1s. The sidebar's listener (useTeamEvents) updates state at
// the InboxShell root (a large render); React's concurrent renderer could
// pre-empt that between commits while the right rail's tiny ContactPanel
// re-render committed in the same frame as the click.
//
// flushSync forces the listener loop to run inside a synchronous commit:
// every setState fired by the dispatched listeners is flushed before the
// dispatch returns, so all the surfaces commit together.
// -----------------------------------------------------------------------
type AnyListener = (payload: unknown) => void;

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
  if (!s) return;
  // Snapshot the listeners once so iteration is stable even if a handler
  // mutates the listener array (e.g. a useEffect cleanup fires mid-loop).

  const socketListeners: AnyListener[] = (s.listeners(event as any) as AnyListener[]).slice();
  if (socketListeners.length === 0) return;

  const run = () => {
    for (const fn of socketListeners) {
      try {
        fn(payload);
      } catch (err) {
        // A misbehaving subscriber must not break the optimistic UX.

        console.error(`[socket] local dispatch ${String(event)} subscriber threw`, err);
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
 * Batched form — fan multiple `ServerToClient` events through their subscribers
 * in ONE `flushSync` so every queued setState commits in a single paint cycle.
 *
 * Why this exists: an optimistic mutation typically pairs a state-changing
 * frame (`conversation:status`) with a matching timeline pill
 * (`conversation:activity`). Calling `dispatchLocalSocketEvent` twice in a row
 * wraps each in its OWN flushSync, so React commits TWO paints in quick
 * succession — the header chip in paint 1, the activity pill in paint 2. The
 * gap (one rAF tick + the browser's commit work) reads as the activity log
 * lagging the rest of the UI. Bundling both into one flushSync collapses them
 * into a single commit, so the chip + pill land in the same frame.
 *
 * Each entry runs through its own subscriber list; an unsubscribed event is a
 * no-op (matches the single-event form).
 */
type DispatchTuple = {
  [E in keyof ServerToClientEvents]: [E, Parameters<ServerToClientEvents[E]>[0]];
}[keyof ServerToClientEvents];

export function dispatchLocalSocketEvents(events: DispatchTuple[]): void {
  const s = socket;
  if (!s) return;
  if (events.length === 0) return;
  // Snapshot listeners up front for the same iteration-stability reason as
  // the single-event form.
  const plan: { listeners: AnyListener[]; payload: unknown; name: string }[] = [];
  for (const [event, payload] of events) {
    const ls = (s.listeners(event as any) as AnyListener[]).slice();
    if (ls.length > 0) plan.push({ listeners: ls, payload, name: String(event) });
  }
  if (plan.length === 0) return;
  const run = () => {
    for (const { listeners, payload, name } of plan) {
      for (const fn of listeners) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[socket] local batched dispatch ${name} subscriber threw`, err);
        }
      }
    }
  };
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
