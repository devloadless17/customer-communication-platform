import { Injectable, Logger } from "@nestjs/common";
import type { Server } from "socket.io";

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@ccp/shared/socket/events";

import {
  channelRoom,
  channelThreadRoom,
  conversationRoom,
  teamRoom,
} from "./rooms";

export type TypedIO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Typed emit helpers — the only place app code reaches when fanning out a
 * server-originated event. The gateway sets `server` on init; until then,
 * emits warn-and-drop (same fail-soft posture as the pre-migration code so
 * a webhook arriving during boot doesn't 500 and trigger a Meta retry).
 *
 * Migrated from lib/socket/server.ts `emitTo*` helpers. Same names so a
 * grep for emit sites lands on this file post-cutover.
 */
@Injectable()
export class RealtimeEmitter {
  private readonly logger = new Logger(RealtimeEmitter.name);
  private server: TypedIO | null = null;

  /** Called by RealtimeGateway in afterInit to publish the live IO server. */
  bind(server: TypedIO): void {
    this.server = server;
  }

  getServerOrNull(): TypedIO | null {
    return this.server;
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

  emitToChannelThread<E extends keyof ServerToClientEvents>(
    rootMessageId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(
        `emitToChannelThread("${String(event)}") dropped — IO not ready yet`,
      );
      return;
    }
    io.to(channelThreadRoom(rootMessageId)).emit(event, ...args);
  }

  emitCatalogChange(
    teamId: string,
    scope: Parameters<ServerToClientEvents["team:catalog:changed"]>[0]["scope"],
  ): void {
    this.emitToTeam(teamId, "team:catalog:changed", { teamId, scope });
  }
}
