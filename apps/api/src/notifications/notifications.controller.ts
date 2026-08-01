import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";

import {
  countUnreadNotifications,
  listNotifications,
  markNotificationsRead,
} from "@/lib/notifications/notifications";
import { zBody, zQuery } from "@/common/zod-validation.pipe";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard, type ApiSession } from "../auth/session.guard";
import { DbService } from "../db/db.service";

const ListQuerySchema = z.object({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const MarkReadSchema = z.object({
  /** Omit to clear everything. Ids are scoped to the caller server-side. */
  ids: z.array(z.string().min(1)).max(200).optional(),
});

/**
 * The notification centre — the bell.
 *
 * Per-USER, so every route reads the reader from the session and never from
 * client input; an id belonging to someone else simply matches nothing.
 *
 * Deliberately NO `/v1` counterpart: a notification belongs to a person, and an
 * API key has no person. Same reasoning as the ticket thread's read route.
 */
@Controller("api/notifications")
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListQuerySchema)) query: z.infer<typeof ListQuerySchema>,
  ) {
    const [notifications, unread] = await Promise.all([
      listNotifications(this.db, session.workspaceId, session.userId, {
        ...(query.unread ? { unreadOnly: true } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
      countUnreadNotifications(this.db, session.workspaceId, session.userId),
    ]);
    return { notifications, unread };
  }

  /** Just the badge — the rail polls this, so it stays a COUNT, not a list. */
  @Get("unread-count")
  async unreadCount(@CurrentSession() session: ApiSession) {
    const unread = await countUnreadNotifications(this.db, session.workspaceId, session.userId);
    return { unread };
  }

  @Post("read")
  async markRead(
    @CurrentSession() session: ApiSession,
    @Body(zBody(MarkReadSchema)) body: z.infer<typeof MarkReadSchema>,
  ) {
    const cleared = await markNotificationsRead(
      this.db,
      session.workspaceId,
      session.userId,
      body.ids,
    );
    return { ok: true, cleared };
  }
}
