"use client";

import { io, type Socket } from "socket.io-client";

import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@/lib/socket-events";

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
    reconnectionDelay: 500,
  });

  return socket;
}
