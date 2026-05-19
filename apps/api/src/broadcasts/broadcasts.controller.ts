import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import {
  CreateBroadcastSchema,
  type CreateBroadcastInput,
} from "./broadcasts.schemas";
import { BroadcastsService } from "./broadcasts.service";

/**
 * Broadcasts: create, list, detail, delete.
 *
 *   POST   /api/broadcasts        — create + fire-and-forget the runner
 *   GET    /api/broadcasts        — newest 100
 *   GET    /api/broadcasts/:id    — full detail with recipient rows
 *   DELETE /api/broadcasts/:id    — refuses while running
 *
 * The runner (lib/broadcast-runner.ts) emits via the bus, not direct socket
 * calls, so it runs correctly from either process — see CLAUDE.md's
 * `broadcast.recipient_message_sent` / `broadcast.conversation_reopened`
 * event types for the suppression model.
 */
@Controller("api/broadcasts")
@UseGuards(SessionGuard)
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateBroadcastSchema)) body: CreateBroadcastInput,
  ) {
    const { broadcastId, totalCount } = await this.broadcasts.create(
      session.teamId,
      session.userId,
      body,
    );
    return { ok: true, broadcastId, totalCount };
  }

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const broadcasts = await this.broadcasts.list(session.teamId);
    return { broadcasts };
  }

  @Get(":id")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const broadcast = await this.broadcasts.get(session.teamId, id);
    return { broadcast };
  }

  /**
   * Paginated recipient page. `GET :id/recipients?cursor=&status=&take=`.
   * Used by the broadcast detail UI when `recipientsTruncated` is true on
   * the parent get() response. Without this, a 10k-recipient broadcast
   * caused a multi-MB JSON return + 10k DOM rows on detail-open, freezing
   * the browser tab for tens of seconds.
   */
  @Get(":id/recipients")
  async listRecipients(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("status") status?: string,
    @Query("take") take?: string,
  ) {
    return this.broadcasts.listRecipients(session.teamId, id, {
      cursor,
      status,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  @Post(":id/cancel")
  async cancel(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.broadcasts.cancel(session.teamId, id);
    return { ok: true };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.broadcasts.remove(session.teamId, id);
    return { ok: true };
  }
}
