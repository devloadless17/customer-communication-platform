import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { RequireRole } from "../auth/role.guard";
import { RoleGuard } from "../auth/role.guard";
import {
  CreateTicketFieldSchema,
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TicketSettingsSchema,
  UpdateTicketFieldSchema,
  AddTicketNoteSchema,
  UpdateTicketSchema,
  UpsertSlaPolicySchema,
  type CreateTicketFieldInput,
  type CreateTicketInput,
  type ListTicketsQuery,
  type TicketSettingsInput,
  type UpdateTicketFieldInput,
  type AddTicketNoteInput,
  type UpdateTicketInput,
  type UpsertSlaPolicyInput,
} from "./tickets.schemas";
import { TicketsService } from "./tickets.service";

/**
 * The ticket board, list and detail.
 *
 * Session-gated only, like the inbox itself: working a ticket — claiming it,
 * changing its priority, solving it — is everyday work in the same tier as
 * replying to a message. What an ADMIN controls is the configuration (SLA
 * promises, which custom fields exist, whether tickets auto-open), and those
 * routes carry the role guard.
 *
 *   GET    /api/tickets              — board/list, keyset-paginated
 *   GET    /api/tickets/counts       — header badges
 *   GET    /api/tickets/:id          — one ticket + its timeline
 *   POST   /api/tickets              — open one manually
 *   PATCH  /api/tickets/:id          — status / priority / assignee / tags / fields
 */
@Controller("api/tickets")
@UseGuards(SessionGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListTicketsQuerySchema)) query: ListTicketsQuery,
  ) {
    return this.tickets.list(session.workspaceId, session.userId, query, session);
  }

  /** Static segment — must be declared before any `:id` route. */
  @Get("counts")
  async counts(@CurrentSession() session: ApiSession) {
    const counts = await this.tickets.counts(session.workspaceId, session.userId, session);
    return { counts };
  }

  @Get(":id")
  async get(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.tickets.get(session.workspaceId, id, session);
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateTicketSchema)) body: CreateTicketInput,
  ) {
    return this.tickets.create(session.workspaceId, { userId: session.userId }, body, session);
  }

  /**
   * Add an internal note. Deliberately its own route rather than a field on
   * PATCH: a note changes nothing about the ticket, so it must not bump
   * `version` (which would 409 a colleague's open editor) or touch the SLA
   * clock. It appends to the timeline and nothing else.
   */
  @Post(":id/notes")
  async addNote(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(AddTicketNoteSchema)) body: AddTicketNoteInput,
  ) {
    return this.tickets.addNote(
      session.workspaceId,
      { userId: session.userId },
      id,
      body.body,
      session,
    );
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateTicketSchema)) body: UpdateTicketInput,
  ) {
    return this.tickets.update(session.workspaceId, { userId: session.userId }, id, body, session);
  }

  /**
   * Permanently delete a ticket. Admin/manager only (the service enforces it) —
   * agents solve or close instead. The customer's messages survive; the work
   * item and its timeline go.
   */
  @Delete(":id")
  async remove(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.tickets.remove(session.workspaceId, { userId: session.userId }, id, session.role);
  }
}

/**
 * Ticketing CONFIGURATION — admin only.
 *
 * Split into its own controller rather than role-guarding half of the one
 * above: a reader can then tell at a glance which routes an agent can reach.
 * These change what every future ticket promises, so they sit with the rest of
 * the workspace settings surface.
 */
@Controller("api/workspace/tickets")
@UseGuards(SessionGuard, RoleGuard)
@RequireRole("admin")
export class TicketSettingsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get("settings")
  async settings(@CurrentSession() session: ApiSession) {
    return this.tickets.getSettings(session.workspaceId);
  }

  @Patch("settings")
  async updateSettings(
    @CurrentSession() session: ApiSession,
    @Body(zBody(TicketSettingsSchema)) body: TicketSettingsInput,
  ) {
    return this.tickets.updateSettings(session.workspaceId, body);
  }

  @Get("sla")
  async listSla(@CurrentSession() session: ApiSession) {
    const policies = await this.tickets.listSlaPolicies(session.workspaceId);
    return { policies };
  }

  /** Upsert on (workspace, priority) — see the service comment for why. */
  @Post("sla")
  async upsertSla(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpsertSlaPolicySchema)) body: UpsertSlaPolicyInput,
  ) {
    const policy = await this.tickets.upsertSlaPolicy(session.workspaceId, body);
    return { policy };
  }

  @Get("fields")
  async listFields(@CurrentSession() session: ApiSession) {
    const fields = await this.tickets.listFields(session.workspaceId);
    return { fields };
  }

  @Post("fields")
  async createField(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateTicketFieldSchema)) body: CreateTicketFieldInput,
  ) {
    const field = await this.tickets.createField(session.workspaceId, body);
    return { field };
  }

  @Patch("fields/:id")
  async updateField(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateTicketFieldSchema)) body: UpdateTicketFieldInput,
  ) {
    const field = await this.tickets.updateField(session.workspaceId, id, body);
    return { field };
  }

  @Delete("fields/:id")
  async deleteField(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    await this.tickets.deleteField(session.workspaceId, id);
    return { ok: true };
  }
}
