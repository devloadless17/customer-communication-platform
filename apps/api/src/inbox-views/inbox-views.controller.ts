import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { RateLimit } from "../common/rate-limit.interceptor";
import { zBody } from "../common/zod-validation.pipe";
import {
  CreateInboxViewSchema,
  ReorderInboxViewsSchema,
  UpdateInboxViewSchema,
  type CreateInboxViewInput,
  type ReorderInboxViewsInput,
  type UpdateInboxViewInput,
} from "./inbox-views.schemas";
import { InboxViewCountsService } from "./inbox-view-counts.service";
import { actorFromSession, InboxViewsService } from "./inbox-views.service";

/**
 * Saved inbox views.
 *
 *   GET    /api/inbox-views          — shared + my personal, ordered
 *   GET    /api/inbox-views/counts   — badge counts for those same views
 *   POST   /api/inbox-views          — create (shared needs the capability)
 *   PATCH  /api/inbox-views/:id      — edit / promote to shared
 *   DELETE /api/inbox-views/:id      — delete
 *   POST   /api/inbox-views/reorder  — manual drag order
 *
 * No capability guard at the class level: saving a PERSONAL view is something
 * every agent may do, and only the shared kind is gated. The check therefore
 * lives in the service, where it can see the visibility being written — a
 * route-level `@RequireCapability` would have to block agents from saving
 * their own views to protect the shared ones.
 */
@Controller("api/inbox-views")
@UseGuards(SessionGuard)
export class InboxViewsController {
  constructor(
    private readonly views: InboxViewsService,
    private readonly counts: InboxViewCountsService,
  ) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const views = await this.views.list(actorFromSession(session));
    return { views };
  }

  /**
   * Badge counts. Declared BEFORE the `:id` routes so a bare GET can't swallow
   * `counts` as an id — same ordering discipline as `/conversations/counts`.
   *
   * Read-tier limit: the client refetches this on the same socket events as
   * the preset counts (coalesced onto a much longer window), and a
   * power-navigating agent must not drain the 300/min default with it.
   */
  @Get("counts")
  @RateLimit({ perMinute: 600 })
  async viewCounts(@CurrentSession() session: ApiSession) {
    const views = await this.views.list(actorFromSession(session));
    // Resolve dangling ids first so a badge can never disagree with the list
    // it labels — both paths run the same stored document through the same
    // resolver.
    const resolved = await Promise.all(
      views.map(async (v) => ({
        id: v.id,
        filters: await this.views.resolveFilters(session.workspaceId, v.filters),
      })),
    );
    const counts = await this.counts.countAll(session.workspaceId, resolved, session);
    return { counts };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateInboxViewSchema)) body: CreateInboxViewInput,
  ) {
    const view = await this.views.create(actorFromSession(session), body);
    return { view };
  }

  /** Static segment, so it must precede `:id`. */
  @Post("reorder")
  async reorder(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ReorderInboxViewsSchema)) body: ReorderInboxViewsInput,
  ) {
    const views = await this.views.reorder(actorFromSession(session), body);
    return { views };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateInboxViewSchema)) body: UpdateInboxViewInput,
  ) {
    const view = await this.views.update(actorFromSession(session), id, body);
    return { view };
  }

  @Delete(":id")
  async remove(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    await this.views.remove(actorFromSession(session), id);
    return { ok: true };
  }
}
