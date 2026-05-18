import { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { ServerOptions } from "socket.io";

import { SOCKET_PATH } from "@ccp/shared/socket/events";

/**
 * IoAdapter subclass that centralizes Socket.io server tuning. One file to
 * grep for, not a five-field hunt across the codebase.
 *
 * Notable choices:
 *   - `path` MUST match the client (`SOCKET_PATH = "/api/socket"`).
 *   - `connectionStateRecovery` replays missed events for up to 2 min so a
 *     tab-sleep or wifi blip doesn't leave the inbox stale.
 *   - `skipMiddlewares: true` on recovery avoids re-running the auth
 *     handshake on every brief reconnect — without it, a hard-reload
 *     storm becomes N DB roundtrips per user.
 *   - `maxHttpBufferSize: 64 KiB` — payloads are tiny; the 1 MiB default
 *     is a memory-pin DoS vector for the size we actually use.
 *   - `perMessageDeflate: false` — JSON payloads are too small to compress
 *     usefully; deflate adds CPU + per-socket zlib state.
 *   - `pingTimeout/pingInterval` slightly tighter than defaults so dead
 *     tabs are reaped within ~25s.
 */
export class WsAdapter extends IoAdapter {
  constructor(app: INestApplicationContext) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const merged: Partial<ServerOptions> = {
      ...(options ?? {}),
      path: SOCKET_PATH,
      serveClient: false,
      cors: {
        // Same posture as the Next.js socket server: lock to BETTER_AUTH_URL
        // in prod (the canonical public origin Caddy fronts), open in dev so
        // localhost:3000 can connect to the api on localhost:4000.
        origin: process.env.BETTER_AUTH_URL || true,
        credentials: true,
      },
      transports: ["websocket", "polling"],
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
      },
      maxHttpBufferSize: 64 * 1024,
      pingTimeout: 20_000,
      pingInterval: 25_000,
      perMessageDeflate: false,
    };
    return super.createIOServer(port, merged as ServerOptions);
  }
}
