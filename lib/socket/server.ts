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
      // Phase 1 trusts same-origin only because the custom server fronts both
      // the app and the websocket. Phase 2 should tighten with an allowlist
      // pulled from env when we deploy publicly.
      origin: true,
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
      skipMiddlewares: false,
    },
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
      if (requestedTeamId !== teamId) return;
      socket.join(teamRoom(teamId));
      socket.emit("presence:update", { teamId, onlineUserIds: snapshotPresence(teamId) });
    });

    socket.on("subscribe:conversation", async ({ conversationId }) => {
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
      socket.join(conversationRoom(conversationId));
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

export function getIO(): IO {
  if (!state.io) {
    throw new Error(
      "Socket.io server not initialized. Start the app via the custom server (`npm run dev`), not `next dev`.",
    );
  }
  return state.io;
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
  getIO().to(teamRoom(teamId)).emit(event, ...args);
}

export function emitToConversation<E extends keyof ServerToClientEvents>(
  conversationId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  getIO().to(conversationRoom(conversationId)).emit(event, ...args);
}
