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
    // Cache bust FIRST, socket disconnect SECOND. The reverse order had a
    // race: a socket whose handshake middleware had just succeeded reading
    // the cookie-cache (before deactivation hit) but hadn't yet called
    // presence.add was INVISIBLE to disconnectUserSockets — it survived the
    // disconnect with cached identity and kept running until next reconnect.
    // Cache-bust first means any in-flight handshake that hasn't reached
    // presence yet will revalidate against the DB on its next request and
    // see deactivatedAt != null. Worst-case window collapses from "until
    // next reconnect" to "15s ApiSession cache TTL + next request".
    invalidateSessionCache(userId);
    const dropped = this.realtime.disconnectUserSockets(userId);
    this.logger.log(`revoked ${userId} (${reason}, dropped ${dropped} socket(s))`);
  }
}
