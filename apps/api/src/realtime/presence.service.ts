import { Injectable } from "@nestjs/common";

import { setOnlinePresenceResolver } from "@/lib/conversations/presence-bridge";

/**
 * Per-(team, user) socket-id tracker. The same agent commonly has two tabs
 * open; closing one shouldn't flip them offline. The tracker returns a
 * `wentOffline` signal only when the last socket for that user closed —
 * callers use it to decide whether to broadcast a presence:update.
 *
 * Lives in the NestJS api process, alongside the Socket.io gateway.
 */
@Injectable()
export class PresenceService {
  private readonly byTeam = new Map<string, Map<string, Set<string>>>();

  constructor() {
    // Expose the live online set to framework-agnostic lib code (the
    // round-robin picker) so it can prefer truly-connected agents — not just
    // whoever's flagged "available" in the DB. See presence-bridge.ts.
    setOnlinePresenceResolver((workspaceId) => new Set(this.snapshot(workspaceId)));
  }

  // Per-conversation viewer set: conversationId → userId → socketIds.
  // Same shape as the team map; the extra layer lets us count tabs per
  // user so closing one tab doesn't flip "viewing" off while another is
  // still open. Same 0→1 / 1→0 transition gates as team presence.
  private readonly byConversation = new Map<
    string,
    Map<string, Set<string>>
  >();

  /**
   * Returns true iff this add transitioned the user from 0 → 1 socket (i.e.
   * "came online"). Callers use it to skip a redundant team-wide presence
   * broadcast when the same user is just opening another tab — without this
   * gate, every reconnect / additional tab fans out N team-wide emits.
   */
  add(workspaceId: string, userId: string, socketId: string): boolean {
    const team = this.byTeam.get(workspaceId) ?? new Map<string, Set<string>>();
    const sockets = team.get(userId) ?? new Set<string>();
    const wasEmpty = sockets.size === 0;
    sockets.add(socketId);
    team.set(userId, sockets);
    this.byTeam.set(workspaceId, team);
    return wasEmpty;
  }

  /** Returns true iff this removal took the user offline (last socket closed). */
  remove(workspaceId: string, userId: string, socketId: string): boolean {
    const team = this.byTeam.get(workspaceId);
    if (!team) return false;
    const sockets = team.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      team.delete(userId);
      if (team.size === 0) this.byTeam.delete(workspaceId);
      return true;
    }
    return false;
  }

  snapshot(workspaceId: string): string[] {
    const team = this.byTeam.get(workspaceId);
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

  // -------------------------------------------------------------------------
  // Conversation viewers
  // -------------------------------------------------------------------------

  /**
   * Returns true iff this add transitioned the user from 0 → 1 socket in
   * this conversation (i.e. "started viewing"). Multiple tabs from the
   * same agent count as one viewer.
   */
  addViewer(conversationId: string, userId: string, socketId: string): boolean {
    const conv = this.byConversation.get(conversationId) ?? new Map<string, Set<string>>();
    const sockets = conv.get(userId) ?? new Set<string>();
    const wasEmpty = sockets.size === 0;
    sockets.add(socketId);
    conv.set(userId, sockets);
    this.byConversation.set(conversationId, conv);
    return wasEmpty;
  }

  /** Returns true iff this removal took the user out of the viewer set. */
  removeViewer(conversationId: string, userId: string, socketId: string): boolean {
    const conv = this.byConversation.get(conversationId);
    if (!conv) return false;
    const sockets = conv.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      conv.delete(userId);
      if (conv.size === 0) this.byConversation.delete(conversationId);
      return true;
    }
    return false;
  }

  snapshotViewers(conversationId: string): string[] {
    const conv = this.byConversation.get(conversationId);
    return conv ? [...conv.keys()] : [];
  }

  /**
   * Every conversation the user is currently a viewer of (≥1 socket in the
   * conversation's viewer set). Used by the availability-changed fanout to
   * re-broadcast `conversation:viewers` for each affected room — without
   * walking every conversation in the map.
   */
  conversationsViewedBy(userId: string): string[] {
    const out: string[] = [];
    for (const [conversationId, byUser] of this.byConversation) {
      if (byUser.has(userId)) out.push(conversationId);
    }
    return out;
  }
}
