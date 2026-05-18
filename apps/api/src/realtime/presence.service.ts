import { Injectable } from "@nestjs/common";

/**
 * Per-(team, user) socket-id tracker. The same agent commonly has two tabs
 * open; closing one shouldn't flip them offline. The tracker returns a
 * `wentOffline` signal only when the last socket for that user closed —
 * callers use it to decide whether to broadcast a presence:update.
 *
 * Lives in the NestJS process. Migrated 1:1 from
 * [lib/socket/server.ts](../../../../../lib/socket/server.ts)'s in-file
 * presence map; same shape, same semantics.
 */
@Injectable()
export class PresenceService {
  private readonly byTeam = new Map<string, Map<string, Set<string>>>();

  /**
   * Returns true iff this add transitioned the user from 0 → 1 socket (i.e.
   * "came online"). Callers use it to skip a redundant team-wide presence
   * broadcast when the same user is just opening another tab — without this
   * gate, every reconnect / additional tab fans out N team-wide emits.
   */
  add(teamId: string, userId: string, socketId: string): boolean {
    const team = this.byTeam.get(teamId) ?? new Map<string, Set<string>>();
    const sockets = team.get(userId) ?? new Set<string>();
    const wasEmpty = sockets.size === 0;
    sockets.add(socketId);
    team.set(userId, sockets);
    this.byTeam.set(teamId, team);
    return wasEmpty;
  }

  /** Returns true iff this removal took the user offline (last socket closed). */
  remove(teamId: string, userId: string, socketId: string): boolean {
    const team = this.byTeam.get(teamId);
    if (!team) return false;
    const sockets = team.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      team.delete(userId);
      if (team.size === 0) this.byTeam.delete(teamId);
      return true;
    }
    return false;
  }

  snapshot(teamId: string): string[] {
    const team = this.byTeam.get(teamId);
    return team ? [...team.keys()] : [];
  }

  /**
   * Walk every team and return the socket ids belonging to a given user.
   * Used by the deactivation-disconnect flow — a user can in principle be
   * member of multiple teams (future), and we want to nuke every live
   * connection of theirs.
   */
  socketsFor(userId: string): string[] {
    const out: string[] = [];
    for (const team of this.byTeam.values()) {
      const sockets = team.get(userId);
      if (!sockets) continue;
      for (const id of sockets) out.push(id);
    }
    return out;
  }
}
