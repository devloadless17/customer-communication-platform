import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import {
  ListFlagsQuerySchema,
  RaiseFlagSchema,
  UpdateFlagSchema,
  type ListFlagsQuery,
  type RaiseFlagInput,
  type UpdateFlagInput,
} from "./message-flags.schemas";
import { MessageFlagsService } from "./message-flags.service";

/**
 * Raising, resolving and listing message triage flags.
 *
 * Deliberately UNGATED beyond the session: flagging a complaint and closing it
 * out is everyday triage, in the same tier as sending a message or leaving a
 * note. The `messageFlags:manage` capability guards the CATALOG (which flags
 * exist), not the act of using it — see team/message-flags/.
 *
 *   POST   /api/message-flags          — raise a flag on a message
 *   PATCH  /api/message-flags/:id      — resolve / dismiss / reopen / reassign
 *   DELETE /api/message-flags/:id      — remove ("flagged by mistake")
 *   GET    /api/message-flags          — the triage queue (keyset-paginated)
 *   GET    /api/message-flags/counts   — rail badges
 */
@Controller("api/message-flags")
@UseGuards(SessionGuard)
export class MessageFlagsController {
  constructor(private readonly flags: MessageFlagsService) {}

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListFlagsQuerySchema)) query: ListFlagsQuery,
  ) {
    return this.flags.list(session.teamId, session.userId, query, session);
  }

  /** Static segment — must be declared before any `:id` route. */
  @Get("counts")
  async counts(@CurrentSession() session: ApiSession) {
    const counts = await this.flags.counts(session.teamId, session.userId, session);
    return { counts };
  }

  @Post()
  async raise(
    @CurrentSession() session: ApiSession,
    @Body(zBody(RaiseFlagSchema)) body: RaiseFlagInput,
  ) {
    return this.flags.raise(session.teamId, session.userId, body, session);
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateFlagSchema)) body: UpdateFlagInput,
  ) {
    return this.flags.update(session.teamId, session.userId, id, body, session);
  }

  @Delete(":id")
  async remove(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.flags.remove(session.teamId, session.userId, id, session);
  }
}
