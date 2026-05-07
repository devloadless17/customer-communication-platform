// Note: no `server-only` import here — server.ts imports this file outside
// of Next's bundler context. Misuse is guarded by getIO() throwing when the
// singleton isn't initialized.

import type { Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";

import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from "@/lib/socket-events";

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

const globalForIO = globalThis as unknown as { __ccpIO?: IO };

export function initSocketServer(http: HttpServer): IO {
  if (globalForIO.__ccpIO) return globalForIO.__ccpIO;

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

  io.on("connection", (socket) => {
    socket.on("subscribe:team", ({ teamId }) => {
      socket.join(teamRoom(teamId));
    });
    socket.on("subscribe:conversation", ({ conversationId }) => {
      socket.join(conversationRoom(conversationId));
    });
    socket.on("unsubscribe:conversation", ({ conversationId }) => {
      socket.leave(conversationRoom(conversationId));
    });
  });

  globalForIO.__ccpIO = io;
  return io;
}

export function getIO(): IO {
  if (!globalForIO.__ccpIO) {
    throw new Error(
      "Socket.io server not initialized. Start the app via the custom server (`npm run dev`), not `next dev`.",
    );
  }
  return globalForIO.__ccpIO;
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------

export const teamRoom = (teamId: string) => `team:${teamId}`;
export const conversationRoom = (id: string) => `conv:${id}`;

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
