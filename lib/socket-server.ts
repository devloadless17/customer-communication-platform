// Note: no `server-only` import here — server.ts imports this file outside
// of Next's bundler context. Misuse is guarded by getIO() throwing when the
// singleton isn't initialized.

import type { Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import { getToken } from "next-auth/jwt";

import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from "@/lib/socket-events";
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
  });

  // -------------------------------------------------------------------------
  // Auth middleware. Runs once per handshake; rejects sockets without a valid
  // NextAuth session cookie. After this runs, socket.data.userId/teamId/role
  // are trustworthy — DO NOT read identity from event payloads.
  // -------------------------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      const headers = socket.handshake.headers as Record<string, string>;
      const token = await getToken({
        req: { headers },
        secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
        // Auth.js cookie prefix changes between http/https. Production behind
        // a TLS-terminating proxy will need this true.
        secureCookie: process.env.NODE_ENV === "production",
      });
      if (!token?.id || !token.teamId) {
        return next(new Error("unauthorized"));
      }
      socket.data.userId = token.id as string;
      socket.data.teamId = token.teamId as string;
      socket.data.role = token.role as Role;
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

    socket.on("subscribe:conversation", ({ conversationId }) => {
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
