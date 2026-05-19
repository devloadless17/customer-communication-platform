import { Injectable, Logger } from "@nestjs/common";

import { RealtimeGateway } from "../realtime/realtime.gateway";
import { invalidateSessionCache } from "./session.guard";

/**
 * Single owner of "this user's session state changed." Two methods so
 * callers spell out intent at the call site:
 *
 *   - `bustCache(userId)`: drop the per-process 15s ApiSession snapshot.
 *     Use for profile-only edits (rename, avatar) — sockets stay alive.
 *
 *   - `revoke(userId, reason)`: drop the cache AND disconnect every socket
 *     for this user. Pair with a `Session` row delete so reconnects can't
 *     re-handshake. Use for sign-out, password change, role change,
 *     deactivation, deletion, team-deletion.
 *
 * Idempotent. Synchronous on the caller. Socket disconnect fans out in
 * the background.
 */
@Injectable()
export class SessionInvalidationService {
  private readonly logger = new Logger(SessionInvalidationService.name);

  constructor(private readonly realtime: RealtimeGateway) {}

  bustCache(userId: string): void {
    if (!userId) return;
    invalidateSessionCache(userId);
  }

  revoke(userId: string, reason: string): void {
    if (!userId) return;
    const dropped = this.realtime.disconnectUserSockets(userId);
    invalidateSessionCache(userId);
    this.logger.log(`revoked ${userId} (${reason}, dropped ${dropped} socket(s))`);
  }
}
