import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Response } from "express";

import { streamBlob } from "../media/stream-blob";
import type { UploadedFile } from "./tickets.service";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { RequireRole } from "../auth/role.guard";
import { RoleGuard } from "../auth/role.guard";
import {
  PostThreadMessageSchema,
  CreateTicketViewSchema,
  UpdateTicketViewSchema,
  MAX_FILES_PER_REQUEST,
  TICKET_ATTACHMENT_MAX_BYTES,
  CreateTicketFieldSchema,
  CreateTicketSchema,
  EscalateTicketSchema,
  ListTicketsQuerySchema,
  TicketSettingsSchema,
  UpdateTicketFieldSchema,
  AddTicketNoteSchema,
  UpdateTicketSchema,
  UpsertSlaPolicySchema,
  type PostThreadMessageInput,
  type CreateTicketViewInput,
  type UpdateTicketViewInput,
  type CreateTicketFieldInput,
  type CreateTicketInput,
  type EscalateTicketInput,
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
 * promises, which custom fields exist, behaviour toggles), and those
 * routes carry the role guard.
 *
 *   GET    /api/tickets              — board/list, keyset-paginated
 *   GET    /api/tickets/counts       — header badges
 *   GET    /api/tickets/:id          — one ticket + its timeline
 *   POST   /api/tickets              — open one manually
 *   POST   /api/tickets/:id/notes    — internal note (this workspace only)
 *   POST   /api/tickets/:id/escalate — grant a sibling workspace access
 *   DELETE /api/tickets/:id/shares/:wsId — revoke that access
 *   POST   /api/tickets/:id/thread — reply in the cross-department thread (+files)
 *   POST   /api/tickets/:id/thread/read — clear my unread marker
 *   POST   /api/tickets/:id/attachments — attach files to the ticket
 *   GET    /api/tickets/:id/attachments/:aid — stream one file (same-origin)
 *   DELETE /api/tickets/:id/attachments/:aid — remove one
 *   POST   /api/tickets/:id/escalation/message-customer — a guest starts its own chat
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

  /**
   * Saved views — the named, reusable filters a department lives in. Static
   * segment, so declared before any `:id` route.
   */
  @Get("views")
  async listViews(@CurrentSession() session: ApiSession) {
    return this.tickets.listViews(session.workspaceId, session.userId, session.role);
  }

  @Post("views")
  async createView(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateTicketViewSchema)) body: CreateTicketViewInput,
  ) {
    return this.tickets.createView(session.workspaceId, session.userId, session.role, body);
  }

  @Patch("views/:viewId")
  async updateView(
    @CurrentSession() session: ApiSession,
    @Param("viewId") viewId: string,
    @Body(zBody(UpdateTicketViewSchema)) body: UpdateTicketViewInput,
  ) {
    return this.tickets.updateView(
      session.workspaceId,
      session.userId,
      session.role,
      viewId,
      body,
    );
  }

  @Delete("views/:viewId")
  async deleteView(@CurrentSession() session: ApiSession, @Param("viewId") viewId: string) {
    return this.tickets.deleteView(session.workspaceId, session.userId, session.role, viewId);
  }

  /** Sibling workspaces a ticket can be escalated to. Static — before `:id`. */
  @Get("escalation-targets")
  async escalationTargets(@CurrentSession() session: ApiSession) {
    return { workspaces: await this.tickets.listEscalationTargets(session.workspaceId) };
  }

  @Get(":id")
  async get(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.tickets.get(session.workspaceId, id, session, session.userId);
  }

  /**
   * Which workspace holds this ticket id — the recovery for a ticket URL
   * opened under the wrong active workspace (following an escalation pair
   * across a switch, a shared link, the back button). Org-scoped +
   * access-gated in the service.
   */
  @Get(":id/locate")
  async locate(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.tickets.locate(session, id);
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

  /**
   * Escalate: grant a sibling workspace in the organization access to THIS
   * ticket (one ticket, two departments — nothing is copied). Session tier —
   * escalating is everyday work, same as raising a ticket.
   */
  @Post(":id/escalate")
  async escalate(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(EscalateTicketSchema)) body: EscalateTicketInput,
  ) {
    return this.tickets.escalate(session.workspaceId, { userId: session.userId }, id, body, session);
  }

  /**
   * Post to the ticket's THREAD — the conversation between the departments.
   * Everyone with access sees it; an internal `/notes` entry stays in this
   * workspace. Like a note it is not a ticket update: no `version` bump, no
   * SLA movement.
   *
   * Multipart so a reply can carry its evidence; the files are filed against
   * the message and render with it. `clientTempId` makes a retry idempotent.
   */
  @Post(":id/thread")
  @UseInterceptors(
    FilesInterceptor("files", MAX_FILES_PER_REQUEST, {
      storage: memoryStorage(),
      limits: { fileSize: TICKET_ATTACHMENT_MAX_BYTES },
    }),
  )
  async postThreadMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PostThreadMessageSchema)) body: PostThreadMessageInput,
    @UploadedFiles() files?: UploadedFile[],
  ) {
    return this.tickets.postThreadMessage(
      session.workspaceId,
      { userId: session.userId },
      id,
      body.body,
      files ?? [],
      body.clientTempId,
      session,
    );
  }

  /**
   * Clear this reader's "unread reply" marker. Called from the detail page
   * only, and only while the tab is actually visible — §10's rule that a
   * hidden tab must never clear something nobody saw.
   */
  @Post(":id/thread/read")
  async markThreadRead(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.tickets.markThreadRead(session.workspaceId, session.userId, id, session);
  }

  /**
   * Attach files to a ticket directly (the raise dialog posts here right after
   * creating the ticket, so a picked file survives even if the ticket's own
   * create is what fails).
   */
  @Post(":id/attachments")
  @UseInterceptors(
    FilesInterceptor("files", MAX_FILES_PER_REQUEST, {
      storage: memoryStorage(),
      limits: { fileSize: TICKET_ATTACHMENT_MAX_BYTES },
    }),
  )
  async addAttachments(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @UploadedFiles() files?: UploadedFile[],
  ) {
    const attachments = await this.tickets.attachFiles(
      session.workspaceId,
      { userId: session.userId },
      id,
      files ?? [],
      null,
      session,
    );
    return { attachments };
  }

  /**
   * Stream one attachment. Same-origin (never a presigned storage URL handed to
   * the browser) so the ticket's access gate applies to every byte — which is
   * also what lets a GUEST department read the owner's files and vice versa.
   */
  @Get(":id/attachments/:attachmentId")
  async getAttachment(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Query("download") download: string | undefined,
    @Res() res: Response,
  ) {
    const { blobKey, filename } = await this.tickets.attachmentBlobKey(
      session.workspaceId,
      id,
      attachmentId,
      session,
    );
    await streamBlob(res, blobKey, undefined, {
      ...(download === "1" ? { downloadFilename: filename } : {}),
    });
  }

  @Delete(":id/attachments/:attachmentId")
  async removeAttachment(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
  ) {
    return this.tickets.removeAttachment(
      session.workspaceId,
      { userId: session.userId },
      id,
      attachmentId,
      session,
    );
  }

  /** Revoke a workspace's access to this ticket. */
  @Delete(":id/shares/:guestWorkspaceId")
  async revokeShare(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("guestWorkspaceId") guestWorkspaceId: string,
  ) {
    return this.tickets.revokeShare(
      session.workspaceId,
      { userId: session.userId },
      id,
      guestWorkspaceId,
      session,
    );
  }

  /**
   * Start THIS workspace's own chat with the escalated customer from the
   * snapshot's phone and bind the conversation to the ticket.
   */
  @Post(":id/escalation/message-customer")
  async messageEscalatedCustomer(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body() body: { channelConnectionId?: unknown } | undefined,
  ) {
    const channelConnectionId =
      body && typeof body.channelConnectionId === "string" ? body.channelConnectionId : undefined;
    return this.tickets.messageEscalatedCustomer(
      session.workspaceId,
      { userId: session.userId },
      id,
      { ...(channelConnectionId ? { channelConnectionId } : {}) },
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
