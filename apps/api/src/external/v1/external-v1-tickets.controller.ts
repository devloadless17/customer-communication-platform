import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";
import { hasScope } from "@ccp/shared/api-keys/scopes";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { ScopeGuard } from "../../auth/scope.guard";
import { TicketsService } from "@/tickets/tickets.service";
import {
  AddTicketNoteSchema,
  CreateTicketFieldSchema,
  CreateTicketSchema,
  CreateTicketViewSchema,
  EscalateTicketSchema,
  ListTicketsQuerySchema,
  PostThreadMessageSchema,
  TicketSettingsSchema,
  UpdateTicketFieldSchema,
  UpdateTicketSchema,
  UpdateTicketViewSchema,
  UpsertSlaPolicySchema,
  type AddTicketNoteInput,
  type CreateTicketFieldInput,
  type CreateTicketInput,
  type CreateTicketViewInput,
  type EscalateTicketInput,
  type ListTicketsQuery,
  type PostThreadMessageInput,
  type TicketSettingsInput,
  type UpdateTicketFieldInput,
  type UpdateTicketInput,
  type UpdateTicketViewInput,
  type UpsertSlaPolicyInput,
} from "@/tickets/tickets.schemas";
import { guardChainDepth } from "./v1-request-guards";

/**
 * /v1 TICKETS + cross-workspace escalation — peeled from the 197-route
 * ExternalV1Controller (2026-07-31 split). Same base path + guard stack;
 * check:v1-docs discovers every *.controller.ts here.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1TicketsController {
  constructor(
    private readonly tickets: TicketsService,
  ) {}

  // ── Tickets ─────────────────────────────────────────────────────────────
  // Full parity with the in-app board: the same domain functions the UI calls,
  // with an API-key actor instead of a session. A partner helpdesk can read the
  // backlog, open work, reassign it and resolve it without polling messages.

  @Get("tickets")
  @RequireScope("read:tickets")
  async listTickets(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListTicketsQuerySchema)) query: ListTicketsQuery,
  ) {
    // No viewer → no conversation-visibility restriction. An API key is
    // workspace-scoped by construction and has no agent identity to narrow to
    // — which also means `assignee=me` is unanswerable: it used to resolve to
    // an empty viewer id and silently match nothing. Reject it instead.
    if (query.assignee === "me") {
      throw new BadRequestException({
        error: "assignee_me_requires_session",
        detail: "An API key has no agent identity — pass an explicit user id or 'none'.",
      });
    }
    // Same reasoning, same answer. `unread` is a per-USER marker row, and the
    // service applies it only `if (query.unread && viewerUserId)` — so with a
    // key it was accepted and silently dropped, and the caller got the whole
    // list back believing it was filtered. Accepted-and-ignored is the shape
    // this API has been burned by before; refuse instead.
    if (query.unread) {
      throw new BadRequestException({
        error: "unread_requires_session",
        detail:
          "Unread is per-agent and an API key has no agent identity, so this filter cannot be answered.",
      });
    }
    // Identity is gated on `read:contacts`, like every other external read: a
    // contact with no profile name carries `name = phoneNumber`, so an
    // unmasked board is a directory harvest for a `read:tickets`-only key.
    return this.tickets.list(
      auth.workspaceId,
      "",
      query,
      undefined,
      !hasScope(auth.scopes, "read:contacts"),
    );
  }

  @Get("tickets/counts")
  @RequireScope("read:tickets")
  async ticketCounts(@CurrentApiKey() auth: ApiKeyContext) {
    // `mineActive` is meaningless for a key (no agent identity) and comes back
    // as 0 — documented, rather than silently omitted from the shape.
    const counts = await this.tickets.counts(auth.workspaceId, "");
    return { counts };
  }

  /** Saved ticket views. Static segment — before `tickets/:id`. */
  @Get("tickets/views")
  @RequireScope("read:tickets")
  async listTicketViewsV1(@CurrentApiKey() auth: ApiKeyContext) {
    // An API key has no agent identity, so it sees the SHARED views only (a
    // personal view belongs to one person, and "" matches nobody). Role
    // "admin": a scoped key is trusted like an integration, the same call the
    // delete route already makes.
    return this.tickets.listViews(auth.workspaceId, "", "admin");
  }

  @Post("tickets/views")
  @RequireScope("write:tickets")
  async createTicketViewV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateTicketViewSchema)) body: CreateTicketViewInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // Forced SHARED: a key has no person to own a personal view, and one
    // created with a null author would be visible to nobody.
    return this.tickets.createView(auth.workspaceId, "", "admin", {
      ...body,
      visibility: "shared",
    });
  }

  @Patch("tickets/views/:viewId")
  @RequireScope("write:tickets")
  async updateTicketViewV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("viewId") viewId: string,
    @Body(zBody(UpdateTicketViewSchema)) body: UpdateTicketViewInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.updateView(auth.workspaceId, "", "admin", viewId, body);
  }

  @Delete("tickets/views/:viewId")
  @RequireScope("write:tickets")
  async deleteTicketViewV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("viewId") viewId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.deleteView(auth.workspaceId, "", "admin", viewId);
  }

  /** Sibling workspaces a ticket can be escalated to (id + name only).
   *  Static segment — declared before `tickets/:id` so it isn't captured. */
  @Get("tickets/escalation-targets")
  @RequireScope("read:tickets")
  async ticketEscalationTargets(@CurrentApiKey() auth: ApiKeyContext) {
    return { workspaces: await this.tickets.listEscalationTargets(auth.workspaceId) };
  }

  @Get("tickets/:id")
  @RequireScope("read:tickets")
  async getTicket(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    // Same `read:contacts` gate as the board above.
    return this.tickets.get(
      auth.workspaceId,
      id,
      undefined,
      undefined,
      !hasScope(auth.scopes, "read:contacts"),
    );
  }

  @Post("tickets")
  @RequireScope("write:tickets")
  async createTicketV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateTicketSchema)) body: CreateTicketInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.create(auth.workspaceId, { apiKeyId: auth.apiKeyId }, body);
  }

  @Patch("tickets/:id")
  @RequireScope("write:tickets")
  async updateTicketV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateTicketSchema)) body: UpdateTicketInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.update(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id, body);
  }

  /**
   * Permanently delete a ticket. A scoped key is trusted like an integration,
   * so `write:tickets` authorizes it (no role gate — the in-app route reserves
   * this for admins/managers, but a key is not an agent). The customer's
   * messages survive; the work item and its timeline go.
   */
  @Delete("tickets/:id")
  @RequireScope("write:tickets")
  async deleteTicketV1(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.remove(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id);
  }

  /**
   * Add an internal note to a ticket. Never reaches the customer.
   *
   * Parity with the in-app composer, which is a locked rule — and the one /v1
   * route a handoff integration genuinely needs: a partner system that receives
   * a `ticket.changed` webhook with `action: "team_changed"` answers by writing
   * a note back, not by messaging the customer.
   *
   * Its own route rather than a PATCH field for the same reason as internally:
   * a note changes nothing about the ticket, so it must not bump `version` (and
   * 409 a colleague's open editor) or move the SLA clock.
   */
  @Post("tickets/:id/notes")
  @RequireScope("write:tickets")
  async addTicketNoteV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(AddTicketNoteSchema)) body: AddTicketNoteInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.addNote(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id, body.body);
  }

  // ── Cross-workspace escalation ──────────────────────────────────────────
  // Parity with the in-app escalation flow (locked rule). The API key is
  // scoped to the acting workspace; escalation writes a TicketShare granting
  // the sibling workspace access to the SAME ticket row — one number, one
  // history. (No "twin ticket" exists: the twin-pair design was replaced by
  // shares on 2026-07-28.)

  /** Refer a ticket to a sibling workspace in the organization. */
  @Post("tickets/:id/escalate")
  @RequireScope("write:tickets")
  async escalateTicketV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(EscalateTicketSchema)) body: EscalateTicketInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.escalate(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id, body);
  }

  /**
   * Post to a ticket's THREAD — the conversation every workspace with access to
   * the ticket sees (unlike /notes, which stays in one workspace).
   */
  @Post("tickets/:id/thread")
  @RequireScope("write:tickets")
  async postTicketThreadMessageV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(PostThreadMessageSchema)) body: PostThreadMessageInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // JSON only: a partner posts text, and a multipart API surface nobody asked
    // for is scope we would have to keep working. The in-app composer covers
    // files. No read route either — read state is per-USER, and an API key has
    // no user to mark read for.
    return this.tickets.postThreadMessage(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      body.body,
      [],
      body.clientTempId,
    );
  }

  /** Revoke a workspace's access to a shared ticket. */
  @Delete("tickets/:id/shares/:guestWorkspaceId")
  @RequireScope("write:tickets")
  async revokeTicketShareV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("guestWorkspaceId") guestWorkspaceId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.revokeShare(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      guestWorkspaceId,
    );
  }

  /** Remove one attachment from a ticket. (Uploads stay in-app — see the
   *  comment on the /v1 thread route.) */
  @Delete("tickets/:id/attachments/:attachmentId")
  @RequireScope("write:tickets")
  async removeTicketAttachmentV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.removeAttachment(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      attachmentId,
    );
  }

  /**
   * Start this workspace's own chat with the escalated customer (from the
   * snapshot's phone) and bind the conversation to the ticket.
   */
  @Post("tickets/:id/escalation/message-customer")
  @RequireScope("write:tickets")
  async messageEscalatedCustomerV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body() body: { channelConnectionId?: unknown } | undefined,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const channelConnectionId =
      body && typeof body.channelConnectionId === "string" ? body.channelConnectionId : undefined;
    return this.tickets.messageEscalatedCustomer(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      { ...(channelConnectionId ? { channelConnectionId } : {}) },
    );
  }

  // Ticketing configuration. Read is deliberately under `read:tickets` (a BI
  // system needs the SLA promise to report against it); every write changes
  // what FUTURE tickets promise, so config writes carry `admin:settings`.

  @Get("tickets-settings")
  @RequireScope("read:tickets")
  async ticketSettings(@CurrentApiKey() auth: ApiKeyContext) {
    return this.tickets.getSettings(auth.workspaceId);
  }

  @Patch("tickets-settings")
  @RequireScope("admin:settings")
  async updateTicketSettings(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(TicketSettingsSchema)) body: TicketSettingsInput,
  ) {
    return this.tickets.updateSettings(auth.workspaceId, body);
  }

  @Get("ticket-sla")
  @RequireScope("read:tickets")
  async listTicketSla(@CurrentApiKey() auth: ApiKeyContext) {
    const policies = await this.tickets.listSlaPolicies(auth.workspaceId);
    return { policies };
  }

  @Post("ticket-sla")
  @RequireScope("admin:settings")
  async upsertTicketSla(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpsertSlaPolicySchema)) body: UpsertSlaPolicyInput,
  ) {
    const policy = await this.tickets.upsertSlaPolicy(auth.workspaceId, body);
    return { policy };
  }

  @Get("ticket-fields")
  @RequireScope("read:tickets")
  async listTicketFields(@CurrentApiKey() auth: ApiKeyContext) {
    const fields = await this.tickets.listFields(auth.workspaceId);
    return { fields };
  }

  @Post("ticket-fields")
  @RequireScope("admin:settings")
  async createTicketField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateTicketFieldSchema)) body: CreateTicketFieldInput,
  ) {
    const field = await this.tickets.createField(auth.workspaceId, body);
    return { field };
  }

  @Patch("ticket-fields/:id")
  @RequireScope("admin:settings")
  async updateTicketField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateTicketFieldSchema)) body: UpdateTicketFieldInput,
  ) {
    const field = await this.tickets.updateField(auth.workspaceId, id, body);
    return { field };
  }

  @Delete("ticket-fields/:id")
  @RequireScope("admin:settings")
  async deleteTicketField(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    await this.tickets.deleteField(auth.workspaceId, id);
    return { ok: true };
  }

}
