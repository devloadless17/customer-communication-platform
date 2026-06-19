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
 *   - `connectionStateRecovery` replays missed events for up to 30s (see
 *     maxDisconnectionDuration below) so a tab-sleep or wifi blip doesn't
 *     leave the inbox stale.
 *   - `skipMiddlewares: false` (default): the auth handshake re-runs on
 *     every recovered reconnect. Earlier `true` lookalike caused two
 *     classes of bug — (1) a deactivated user with a closed laptop could
 *     reconnect within 2 min and survive the deactivation, and (2) the
 *     recovered socket's `client.data` resets but the auth path was
 *     skipped, leaving phantom typing / presence state. The 15s session
 *     cache in `session.guard.ts` already absorbs the per-reconnect DB
 *     cost, so the "N DB roundtrips per reconnect storm" concern that
 *     originally justified `true` no longer applies.
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
        // Mirror the HTTP CORS posture (main.ts): pin to BETTER_AUTH_URL (the
        // canonical public origin Caddy fronts) when set — which validateEnv
        // makes mandatory in prod — and fall back to the explicit dev origins
        // only when it's absent. NEVER reflect-any (`|| true`) WITH
        // `credentials: true`: that combo would let any site open a
        // credentialed socket. The previous `|| true` was dead in prod (env is
        // required) but a latent footgun if that gate ever weakened.
        origin: process.env.BETTER_AUTH_URL
          ? [process.env.BETTER_AUTH_URL]
          : ["http://localhost:3000", "http://127.0.0.1:3000"],
        credentials: true,
      },
      transports: ["websocket", "polling"],
      connectionStateRecovery: {
        // Shortened from 2min → 30s. Socket.io buffers ALL missed events
        // per disconnected socket in memory for this window with no
        // frame-count cap, so a broadcast firing 1k frames into a team
        // room with 25 offline-for-60s sockets = ~50 MB pinned heap on
        // the 4 GB pilot VPS. 30s covers the common case (laptop sleep,
        // WiFi flap, Caddy restart) without becoming a memory cliff.
        // Sockets that miss the window pay one extra handshake + backfill
        // GET on reconnect — same correctness, lower memory ceiling.
        maxDisconnectionDuration: 30 * 1000,
        // skipMiddlewares stays at the Socket.io default (false). See the
        // class-level comment for rationale — re-auth on recovery closes
        // the deactivation-survival window and the presence-flicker bug.
      },
      maxHttpBufferSize: 64 * 1024,
      pingTimeout: 20_000,
      pingInterval: 25_000,
      perMessageDeflate: false,
    };
    return super.createIOServer(port, merged as ServerOptions);
  }
}
