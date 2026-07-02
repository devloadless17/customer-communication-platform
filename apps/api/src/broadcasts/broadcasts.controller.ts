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

import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import {
  BroadcastListQuerySchema,
  BroadcastRecipientsQuerySchema,
  CreateBroadcastSchema,
  PreviewMissingFieldsSchema,
  type BroadcastListQuery,
  type BroadcastRecipientsQuery,
  type CreateBroadcastInput,
  type PreviewMissingFieldsInput,
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
  @RequireCapability("broadcasts:manage")
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateBroadcastSchema)) body: CreateBroadcastInput,
  ) {
    const { broadcastId, totalCount, scheduled } = await this.broadcasts.create(
      session.teamId,
      session.userId,
      body,
    );
    return { ok: true, broadcastId, totalCount, scheduled };
  }

  // Pre-send preflight: how many recipients would resolve a template variable
  // to empty (missing field, no default) and get rejected by WhatsApp. Read
  // -only; lets the composer warn before sending. Same capability as create.
  @Post("preview-missing")
  @RequireCapability("broadcasts:manage")
  async previewMissing(
    @CurrentSession() session: ApiSession,
    @Body(zBody(PreviewMissingFieldsSchema)) body: PreviewMissingFieldsInput,
  ) {
    return this.broadcasts.previewMissingFields(session.teamId, body);
  }

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(BroadcastListQuerySchema)) query: BroadcastListQuery,
  ) {
    // Service returns { broadcasts, nextCursor }. Spread so the existing client
    // reads `body.broadcasts` unchanged and a paging client can read nextCursor.
    return this.broadcasts.list(session.teamId, query);
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
    @Query(zQuery(BroadcastRecipientsQuerySchema)) query: BroadcastRecipientsQuery,
  ) {
    return this.broadcasts.listRecipients(session.teamId, id, {
      cursor: query.cursor,
      status: query.status,
      take: query.take,
    });
  }

  /**
   * All recipient contact ids for a broadcast — used by the "Duplicate" flow to
   * reconstruct a hand-picked audience (which only exists on recipient rows).
   */
  @Get(":id/recipient-ids")
  async listRecipientContactIds(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    return this.broadcasts.listRecipientContactIds(session.teamId, id);
  }

  @Post(":id/cancel")
  @RequireCapability("broadcasts:manage")
  async cancel(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.broadcasts.cancel(session.teamId, id);
    return { ok: true };
  }

  /** Re-queue + re-run only the FAILED recipients of a finished broadcast. */
  @Post(":id/retry")
  @RequireCapability("broadcasts:manage")
  async retry(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const { requeued } = await this.broadcasts.retryFailed(session.teamId, id);
    return { ok: true, requeued };
  }

  @Delete(":id")
  @RequireCapability("broadcasts:manage")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.broadcasts.remove(session.teamId, id);
    return { ok: true };
  }
}
