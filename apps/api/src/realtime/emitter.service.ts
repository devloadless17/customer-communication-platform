import { Injectable, Logger } from "@nestjs/common";
import type { Server } from "socket.io";

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@ccp/shared/socket/events";

import { channelRoom, conversationRoom, teamRoom } from "./rooms";

export type TypedIO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Typed emit helpers — the only place app code reaches when fanning out a
 * server-originated event. The gateway sets `server` on init; until then,
 * emits warn-and-drop so a webhook arriving during boot doesn't 500 and
 * trigger a Meta retry.
 */
@Injectable()
export class RealtimeEmitter {
  private readonly logger = new Logger(RealtimeEmitter.name);
  private server: TypedIO | null = null;

  /** Called by RealtimeGateway in afterInit to publish the live IO server. */
  bind(server: TypedIO): void {
    this.server = server;
  }

  emitToTeam<E extends keyof ServerToClientEvents>(
    teamId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(`emitToTeam("${String(event)}") dropped — IO not ready yet`);
      return;
    }
    io.to(teamRoom(teamId)).emit(event, ...args);
  }

  emitToConversation<E extends keyof ServerToClientEvents>(
    conversationId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(
        `emitToConversation("${String(event)}") dropped — IO not ready yet`,
      );
      return;
    }
    io.to(conversationRoom(conversationId)).emit(event, ...args);
  }

  emitToChannel<E extends keyof ServerToClientEvents>(
    channelId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(
        `emitToChannel("${String(event)}") dropped — IO not ready yet`,
      );
      return;
    }
    io.to(channelRoom(channelId)).emit(event, ...args);
  }

  /**
   * Bound by the gateway at startup. Builds a fresh online-userIds snapshot
   * for a team, filtered for visible-online (users who picked "Appear
   * offline" are excluded even if their socket is connected). Lives on the
   * emitter so fanout rules can re-emit presence after a status change
   * without taking a circular dep on PresenceService / UsersService.
   */
  private presenceSnapshotter: ((teamId: string) => Promise<string[]>) | null = null;
  bindPresenceSnapshotter(fn: (teamId: string) => Promise<string[]>): void {
    this.presenceSnapshotter = fn;
  }

  /** Re-emit `presence:update` to the team room with a fresh visibly-online
   *  set. Used by `user.availability_changed` fanout so toggling "appear
   *  offline" updates teammates' green dots in the same frame as the badge. */
  async emitPresenceSnapshot(teamId: string): Promise<void> {
    const io = this.server;
    const snapshot = this.presenceSnapshotter;
    if (!io || !snapshot) {
      this.logger.warn(
        "emitPresenceSnapshot dropped — IO or snapshotter not ready yet",
      );
      return;
    }
    const onlineUserIds = await snapshot(teamId);
    io.to(teamRoom(teamId)).emit("presence:update", { teamId, onlineUserIds });
  }

  // Snapshotters wired by the gateway so the "also viewing" pill can be
  // refreshed when a user's availability flips (busy/away/offline drop them
  // out, going back to available re-adds them). Kept here so fanout-rules
  // doesn't need a direct ref to PresenceService or the gateway.
  private conversationViewersSnapshotter:
    | ((conversationId: string) => Promise<string[]>)
    | null = null;
  bindConversationViewersSnapshotter(
    fn: (conversationId: string) => Promise<string[]>,
  ): void {
    this.conversationViewersSnapshotter = fn;
  }
  private conversationsViewedByUser: ((userId: string) => string[]) | null = null;
  bindConversationsViewedByUser(fn: (userId: string) => string[]): void {
    this.conversationsViewedByUser = fn;
  }

  /**
   * Re-emit `conversation:viewers` for every conversation room the user is
   * currently a viewer in. Used by `user.availability_changed` fanout so
   * teammates' "also viewing" pills update in the same frame as the badge
   * — going busy/away/offline removes the user from the pill, going
   * available adds them back. No-op when the user isn't viewing anything.
   */
  async emitConversationViewersForUser(userId: string): Promise<void> {
    const io = this.server;
    const conversationsFor = this.conversationsViewedByUser;
    const viewersFor = this.conversationViewersSnapshotter;
    if (!io || !conversationsFor || !viewersFor) {
      this.logger.warn(
        "emitConversationViewersForUser dropped — IO or snapshotter not ready yet",
      );
      return;
    }
    const conversationIds = conversationsFor(userId);
    if (conversationIds.length === 0) return;
    await Promise.all(
      conversationIds.map(async (conversationId) => {
        const viewerUserIds = await viewersFor(conversationId);
        io.to(conversationRoom(conversationId)).emit("conversation:viewers", {
          conversationId,
          viewerUserIds,
        });
      }),
    );
  }
}
