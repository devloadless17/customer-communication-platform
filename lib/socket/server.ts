// Note: no `server-only` import here — server.ts imports this file outside
// of Next's bundler context. Misuse is guarded by getIO() throwing when the
// singleton isn't initialized.

import type { Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";

import { auth } from "@/lib/auth/better-auth";
import { db } from "@/lib/db";
import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from "@/lib/socket/events";
import type { Role } from "@/lib/types";

export type IO = IOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Module-level singleton — both server.ts (boot) and API routes (request
 * handlers) import this file in the SAME Node process, so they share state.
 *
 * Without the global guard, dev hot-reload spawns a new IO server on every
 * server.ts change while the old one is still listening.
 */

interface SocketGlobals {
  io?: IO;
  /** team → user → set of socket ids. Empty user set means user is offline. */
  presence?: Map<string, Map<string, Set<string>>>;
  /** conversation → user → set of socket ids. Same shape, scoped to threads. */
  typing?: Map<string, Map<string, Set<string>>>;
}

const globalForIO = globalThis as unknown as { __ccpIO?: SocketGlobals };
const state: SocketGlobals = (globalForIO.__ccpIO ??= {});

export function initSocketServer(http: HttpServer): IO {
  if (state.io) return state.io;

  state.presence ??= new Map();
  state.typing ??= new Map();

  const io: IO = new IOServer(http, {
    path: SOCKET_PATH,
    serveClient: false,
    cors: {
      // The browser is same-origin in normal use (Caddy fronts both the app
      // and the websocket), but reflecting `Origin: *` with credentials
      // would let a phishing page open a websocket on behalf of a logged-in
      // user. Lock to BETTER_AUTH_URL (the canonical public origin) in prod
      // and fall back to permissive only when no env is set (local dev).
      origin: process.env.BETTER_AUTH_URL || true,
      credentials: true,
    },
    transports: ["websocket", "polling"],
    // Replay events a client missed during a brief drop (tab sleep, wifi
    // blip, phone lock) instead of leaving its inbox silently stale until the
    // next manual refetch. Safe on a single instance — when we scale out this
    // needs the Redis adapter to work, which is already the planned trigger
    // for adding Redis at all.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      // `true` (was `false`) — skipping middlewares on a recovered session
      // means we do NOT re-run the Better Auth getSession + user lookup on
      // every brief reconnect. The session that's being resumed was already
      // auth-validated; re-validating it for every wifi blip turned a single
      // user's reload-storm into N DB roundtrips and contributed to the
      // production hang on hard-reload-with-many-images. On full re-handshake
      // (cookie expired, deactivation, etc.) the middleware DOES run.
      skipMiddlewares: true,
    },
    // Socket payloads are tiny (typing/presence events ~tens of bytes, the
    // largest is `message:new` with a ~2 KB body cap). Defaulting to 1 MB
    // means one malicious or buggy client can pin a full megabyte of RAM
    // per frame; 64 KB is generous for the real surface and shrinks the
    // DoS window. PingTimeout/Interval tuned slightly tighter than defaults
    // so a dead browser tab is reaped within ~25s instead of ~45s, freeing
    // up presence + room memberships sooner.
    maxHttpBufferSize: 64 * 1024,
    pingTimeout: 20_000,
    pingInterval: 25_000,
    // Turn off compression: our messages are JSON and almost never large
    // enough to benefit, and perMessageDeflate adds CPU + per-socket
    // memory state (zlib stream). Single-instance + small payloads → off
    // is strictly better.
    perMessageDeflate: false,
  });

  // -------------------------------------------------------------------------
  // Auth middleware. Runs once per handshake; rejects sockets without a valid
  // Better Auth session. After this runs, socket.data.userId/teamId/role are
  // trustworthy — DO NOT read identity from event payloads.
  //
  // Cost: one DB roundtrip per handshake (Better Auth's getSession reads
  // Session + User by token). Connection-state-recovery means a brief drop
  // doesn't re-handshake, so the cost is per-real-connect, not per-tick.
  // -------------------------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      // Forward the cookie header from the websocket handshake into a Headers
      // object that Better Auth's getSession can read. The handshake includes
      // every cookie the browser would send to a same-origin HTTP request.
      const reqHeaders = new Headers();
      const cookieHeader = socket.handshake.headers.cookie;
      if (cookieHeader) reqHeaders.set("cookie", cookieHeader);

      const session = await auth.api.getSession({ headers: reqHeaders });
      const userId = session?.user?.id;
      const teamId = (session?.user as { teamId?: string } | undefined)?.teamId;
      if (!userId || !teamId) {
        return next(new Error("unauthorized"));
      }
      // Deactivation gate. Better Auth's getSession reads from the in-cookie
      // cache (5 min) and the Session row — neither knows about
      // `deactivatedAt`. Without this check a deactivated user's still-valid
      // cookie keeps authorizing fresh socket connections, letting them
      // observe team events long after an admin disabled them. Match the
      // page (lib/auth/current-user.ts) and API (lib/auth/helpers.ts) gates.
      const dbUser = await db.user.findUnique({
        where: { id: userId },
        select: { deactivatedAt: true },
      });
      if (!dbUser || dbUser.deactivatedAt) {
        return next(new Error("unauthorized"));
      }
      socket.data.userId = userId;
      socket.data.teamId = teamId;
      socket.data.role = (session!.user as { role?: Role }).role as Role;
      socket.data.typingIn = new Set();
      next();
    } catch (err) {
      console.error("[socket] auth middleware error", err);
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    // Identity comes from the handshake, not from the client. Add presence
    // immediately — no client "hello" required anymore.
    const teamId = socket.data.teamId!;
    const userId = socket.data.userId!;

    // Auto-join the team room on connect. Previously a client only joined
    // by explicitly emitting `subscribe:team`, which meant any code path
    // that forgot the emit (or any connection that closed before the emit
    // landed during reload-storm thrash) silently received zero team-wide
    // events. The room is per-team anyway — there's no reason a socket
    // authenticated for team T shouldn't be in team T's room.
    socket.join(teamRoom(teamId));

    addPresence(teamId, userId, socket.id);
    // Snapshot to this socket so its dot lights up immediately.
    socket.emit("presence:update", { teamId, onlineUserIds: snapshotPresence(teamId) });
    // Broadcast a fresh snapshot to other team members.
    io.to(teamRoom(teamId)).emit("presence:update", {
      teamId,
      onlineUserIds: snapshotPresence(teamId),
    });

    socket.on("subscribe:team", ({ teamId: requestedTeamId }) => {
      // Multi-tenancy guardrail: agents can only subscribe to their own team.
      // CLAUDE.md rule 2 — multi-tenancy from day one.
      // Now mostly a no-op (auto-join handles the common case) but kept for
      // backwards compat with clients that explicitly emit it, and as a
      // signal to send the user a fresh presence snapshot on demand.
      if (requestedTeamId !== teamId) return;
      socket.join(teamRoom(teamId));
      socket.emit("presence:update", { teamId, onlineUserIds: snapshotPresence(teamId) });
    });

    socket.on("subscribe:conversation", async ({ conversationId }) => {
      // Idempotency check first: useConversationEvents re-emits this on every
      // reconnect, so a long-lived session sees many subscribes for the same
      // conversation. Skip the DB lookup + emit if we're already in the room.
      // Socket.io's join() is internally idempotent, but the auth round-trip
      // and the typing-state emit aren't — those would fire N times per
      // session for the same id without this guard.
      const roomName = conversationRoom(conversationId);
      if (socket.rooms.has(roomName)) return;

      // Multi-tenancy guardrail: verify the conversation belongs to the
      // socket's team before joining its room. Without this, an authenticated
      // user from team A could subscribe to a conversation in team B and
      // receive every event broadcast there. Today only typing flows through
      // conversation rooms (message/note events go via emitToTeam), but this
      // is the door anything cross-tenant would slip through.
      try {
        const owns = await db.conversation.findFirst({
          where: { id: conversationId, teamId },
          select: { id: true },
        });
        if (!owns) return; // silently drop — don't tell pokers what's missing
      } catch (err) {
        console.error("[socket] subscribe:conversation lookup failed", err);
        return;
      }
      socket.join(roomName);
      socket.emit("typing:update", {
        conversationId,
        typingUserIds: snapshotTyping(conversationId),
      });
    });

    socket.on("unsubscribe:conversation", ({ conversationId }) => {
      socket.leave(conversationRoom(conversationId));
      if (socket.data.typingIn?.delete(conversationId)) {
        removeTyping(conversationId, userId, socket.id);
        io.to(conversationRoom(conversationId)).emit("typing:update", {
          conversationId,
          typingUserIds: snapshotTyping(conversationId),
        });
      }
    });

    socket.on("typing:start", ({ conversationId }) => {
      const wasTyping = socket.data.typingIn?.has(conversationId);
      socket.data.typingIn?.add(conversationId);
      addTyping(conversationId, userId, socket.id);
      if (!wasTyping) {
        io.to(conversationRoom(conversationId)).emit("typing:update", {
          conversationId,
          typingUserIds: snapshotTyping(conversationId),
        });
      }
    });

    socket.on("typing:stop", ({ conversationId }) => {
      if (!socket.data.typingIn?.delete(conversationId)) return;
      removeTyping(conversationId, userId, socket.id);
      io.to(conversationRoom(conversationId)).emit("typing:update", {
        conversationId,
        typingUserIds: snapshotTyping(conversationId),
      });
    });

    socket.on("disconnect", () => {
      // Drop typing flags first — they're scoped to conversation rooms and
      // need their own emit even if presence didn't change.
      if (socket.data.typingIn) {
        for (const conversationId of socket.data.typingIn) {
          removeTyping(conversationId, userId, socket.id);
          io.to(conversationRoom(conversationId)).emit("typing:update", {
            conversationId,
            typingUserIds: snapshotTyping(conversationId),
          });
        }
        socket.data.typingIn.clear();
      }

      const wentOffline = removePresence(teamId, userId, socket.id);
      if (wentOffline) {
        io.to(teamRoom(teamId)).emit("presence:update", {
          teamId,
          onlineUserIds: snapshotPresence(teamId),
        });
      }
    });
  });

  state.io = io;
  return io;
}

/**
 * Hard-throwing accessor — use only in code paths that genuinely cannot
 * proceed without the IO server (e.g. the custom server startup script).
 * For request handlers / webhooks, prefer `getIOOrNull` so a webhook firing
 * during boot doesn't 500 (which makes Meta retry the entire batch).
 */
export function getIO(): IO {
  const io = getIOOrNull();
  if (!io) {
    throw new Error(
      "Socket.io server not initialized. Start the app via the custom server (`npm run dev`), not `next dev`.",
    );
  }
  return io;
}

export function getIOOrNull(): IO | null {
  return state.io ?? null;
}

/**
 * Hard-disconnect every live socket for a given user across the whole IO
 * server. Used by the deactivation flow — without this, a deactivated user
 * keeps receiving live team events on their already-open tabs until they
 * happen to reload. The handshake gate only guards new connections.
 *
 * Returns the number of sockets disconnected, mainly for logging.
 */
export function disconnectUserSockets(userId: string): number {
  const io = getIOOrNull();
  if (!io) return 0;
  let count = 0;
  // The presence map tracks one socketId set per (team, user). Walk every
  // team — typical case is one team per user but multi-team accounts are a
  // future plan, and the cost is negligible (Map iteration over a tiny set).
  for (const teamMap of state.presence!.values()) {
    const sockets = teamMap.get(userId);
    if (!sockets) continue;
    for (const socketId of sockets) {
      const sock = io.sockets.sockets.get(socketId);
      if (sock) {
        sock.disconnect(true);
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------

export const teamRoom = (teamId: string) => `team:${teamId}`;
export const conversationRoom = (id: string) => `conv:${id}`;

// ---------------------------------------------------------------------------
// Presence + typing tracking. Per-user *socket* sets, not booleans, because
// the same agent often has two tabs open — closing one shouldn't show them
// offline / not-typing.
// ---------------------------------------------------------------------------

function addPresence(teamId: string, userId: string, socketId: string): void {
  const team = state.presence!.get(teamId) ?? new Map<string, Set<string>>();
  const sockets = team.get(userId) ?? new Set<string>();
  sockets.add(socketId);
  team.set(userId, sockets);
  state.presence!.set(teamId, team);
}

function removePresence(teamId: string, userId: string, socketId: string): boolean {
  const team = state.presence!.get(teamId);
  if (!team) return false;
  const sockets = team.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    team.delete(userId);
    if (team.size === 0) state.presence!.delete(teamId);
    return true;
  }
  return false;
}

function snapshotPresence(teamId: string): string[] {
  const team = state.presence!.get(teamId);
  return team ? [...team.keys()] : [];
}

function addTyping(conversationId: string, userId: string, socketId: string): void {
  const convo = state.typing!.get(conversationId) ?? new Map<string, Set<string>>();
  const sockets = convo.get(userId) ?? new Set<string>();
  sockets.add(socketId);
  convo.set(userId, sockets);
  state.typing!.set(conversationId, convo);
}

function removeTyping(conversationId: string, userId: string, socketId: string): void {
  const convo = state.typing!.get(conversationId);
  if (!convo) return;
  const sockets = convo.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) convo.delete(userId);
  if (convo.size === 0) state.typing!.delete(conversationId);
}

function snapshotTyping(conversationId: string): string[] {
  const convo = state.typing!.get(conversationId);
  return convo ? [...convo.keys()] : [];
}

// ---------------------------------------------------------------------------
// Typed emit helpers — the only thing app code should reach for. Keeps every
// emit going through the typed event surface so a typo is a build error.
// ---------------------------------------------------------------------------

export function emitToTeam<E extends keyof ServerToClientEvents>(
  teamId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  const io = getIOOrNull();
  if (!io) {
    // Webhook arrived before the custom server finished bootstrapping the
    // IO singleton. Don't throw — that would 500 and trigger a Meta retry
    // storm for an event we already persisted to the DB. Live clients
    // missed it for a few hundred ms; their next reconnect-backfill
    // (use-conversation-events) picks it up.
    console.warn(`[socket] emitToTeam("${event}") dropped — IO not initialized yet`);
    return;
  }
  io.to(teamRoom(teamId)).emit(event, ...args);
}

export function emitToConversation<E extends keyof ServerToClientEvents>(
  conversationId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  const io = getIOOrNull();
  if (!io) {
    console.warn(`[socket] emitToConversation("${event}") dropped — IO not initialized yet`);
    return;
  }
  io.to(conversationRoom(conversationId)).emit(event, ...args);
}

/**
 * Tell every connected client on the team that a shared catalog moved.
 * Clients respond with `router.refresh()` — see use-catalog-sync. Use this
 * after every create / update / delete / reorder on a catalog table so
 * other agents' UIs stay current without a manual reload.
 *
 * Scopes mirror the `team:catalog:changed` event's discriminator. Adding a
 * new catalog: add the literal to that event, then emit from your route.
 */
export function emitCatalogChange(
  teamId: string,
  scope: Parameters<ServerToClientEvents["team:catalog:changed"]>[0]["scope"],
) {
  emitToTeam(teamId, "team:catalog:changed", { teamId, scope });
}
