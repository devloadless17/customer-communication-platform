import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { contactAvatarObjectKey } from "../lib/blob-storage/avatar";
import { streamBlob } from "../media/stream-blob";
import { RequireCapability } from "../auth/capability.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import {
  AudienceCountSchema,
  AudiencePreviewSchema,
  BulkContactsSchema,
  CreateContactSchema,
  ListContactsQuerySchema,
  SetContactTagsSchema,
  UpdateContactSchema,
  type AudienceCountInput,
  type AudiencePreviewInput,
  type BulkContactsInput,
  type CreateContactInput,
  type ListContactsQueryInput,
  type SetContactTagsInput,
} from "./contacts.schemas";
import { ContactsService } from "./contacts.service";

/**
 * Contacts REST surface.
 *
 *   GET    /api/contacts                — paginated list (search, filters)
 *   POST   /api/contacts                — manual create
 *   POST   /api/contacts/bulk           — delete | tag-add | tag-remove
 *   POST   /api/contacts/import         — CSV import (multipart/form-data)
 *   GET    /api/contacts/lookup         — id → display lookup for chips
 *   GET    /api/contacts/export         — full CSV export
 *   POST   /api/contacts/count          — live audience recipient count
 *   POST   /api/contacts/preview        — first N matches preview
 *   PATCH  /api/contacts/:id            — partial update (publishes contact.updated)
 *   DELETE /api/contacts/:id            — hard delete + blob cleanup
 *   PUT    /api/contacts/:id/tags       — replace tag set
 *
 * Route order in this file is by URL specificity (static paths above :id
 * paths). Express matches in registration order; even though no HTTP-verb
 * collision exists today, the explicit ordering protects against a future
 * `GET /:id` accidentally swallowing `/lookup` / `/export`.
 */
@Controller("api/contacts")
@UseGuards(SessionGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  // ---- Collection ---------------------------------------------------------

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListContactsQuerySchema)) query: ListContactsQueryInput,
  ) {
    return this.contacts.list(session.workspaceId, query);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateContactSchema)) body: CreateContactInput,
  ) {
    const contact = await this.contacts.create(session.workspaceId, session.userId, body);
    return { contact };
  }

  // ---- Static sub-paths (must precede :id routes) -------------------------

  @Post("bulk")
  async bulk(
    @CurrentSession() session: ApiSession,
    @Body(zBody(BulkContactsSchema)) body: BulkContactsInput,
  ) {
    // Only the destructive `delete` action is gated by `contacts:delete`;
    // tag-add / tag-remove stay open to any team member. A decorator can't see
    // the body, so this lives here rather than on @RequireCapability.
    if (body.action === "delete") {
      const perms = resolvePermissions(session.role, session.rolePermissions);
      if (!perms["contacts:delete"]) throw new ForbiddenException({ error: "forbidden" });
    }
    return this.contacts.bulk(session.workspaceId, session.userId, body);
  }

  @Get("lookup")
  async lookup(
    @CurrentSession() session: ApiSession,
    @Query("ids") idsRaw?: string,
  ) {
    const ids = (idsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const contacts = await this.contacts.lookup(session.workspaceId, ids);
    return { contacts };
  }

  @Get("count-all")
  async countAll(@CurrentSession() session: ApiSession) {
    const count = await this.contacts.countAll(session.workspaceId);
    return { count };
  }

  /**
   * Contact avatar — authenticated SAME-ORIGIN stream of the captured social
   * profile picture (Messenger/Instagram). The UI renders
   * `<img src="/api/contacts/:id/avatar?v=…">` (the value stored in
   * `avatarUrl`); WhatsApp contacts have none and never reach here. Same-team
   * check first so one team can't stream another's avatar object; 404 when the
   * contact has no captured avatar. `?v` (content hash) makes the bytes safely
   * cacheable. Two-segment path can't shadow the single-segment static routes.
   */
  @Get(":contactId/avatar")
  async avatar(
    @CurrentSession() session: ApiSession,
    @Param("contactId") contactId: string,
    @Res() res: Response,
  ): Promise<void> {
    const ok = await this.contacts.hasCapturedAvatar(session.workspaceId, contactId);
    if (!ok) throw new NotFoundException({ error: "not_found" });
    await streamBlob(res, contactAvatarObjectKey(contactId), undefined);
  }

  /**
   * Refresh a social contact's profile from Meta on demand (name / @username /
   * avatar / follower + verified signals). Backfills contacts created before
   * enrichment captured them and re-pulls signals that drift over time. No-op
   * for phone channels. Publishes `contact.updated`, so every open panel
   * updates live; the response carries the fresh contact for the caller.
   */
  @Post(":contactId/sync-profile")
  @HttpCode(200)
  async syncProfile(
    @CurrentSession() session: ApiSession,
    @Param("contactId") contactId: string,
  ) {
    const contact = await this.contacts.syncSocialProfile(session.workspaceId, contactId);
    return { contact };
  }

  @Post("count")
  async count(
    @CurrentSession() session: ApiSession,
    @Body(zBody(AudienceCountSchema)) body: AudienceCountInput,
  ) {
    const count = await this.contacts.countAudience(session.workspaceId, body);
    return { count };
  }

  @Post("preview")
  async preview(
    @CurrentSession() session: ApiSession,
    @Body(zBody(AudiencePreviewSchema)) body: AudiencePreviewInput,
  ) {
    return this.contacts.previewAudience(session.workspaceId, body);
  }

  // ---- :id routes ---------------------------------------------------------

  /**
   * Partial update. Phone-number rejection happens HERE (not in the schema)
   * so the error message can be specific — see CLAUDE.md memory
   * "Contact phone immutable". We accept raw body, peek for `phoneNumber`
   * ownProperty, then defer to Zod for the rest.
   */
  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown>,
  ) {
    if (
      rawBody &&
      Object.prototype.hasOwnProperty.call(rawBody, "phoneNumber")
    ) {
      throw new BadRequestException({
        error:
          "phoneNumber is not editable — it's the WhatsApp identity for this contact",
      });
    }
    const parsed = UpdateContactSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: "invalid_body",
        issues: parsed.error.issues,
      });
    }
    const contact = await this.contacts.update(
      session.workspaceId,
      session.userId,
      id,
      parsed.data,
    );
    return { contact };
  }

  @Delete(":id")
  @RequireCapability("contacts:delete")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.contacts.remove(session.workspaceId, session.userId, id);
    return { ok: true };
  }

  @Put(":id/tags")
  async setTags(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetContactTagsSchema)) body: SetContactTagsInput,
  ) {
    const out = await this.contacts.setTags(
      session.workspaceId,
      session.userId,
      id,
      body,
    );
    return { ok: true, tagIds: out.tagIds };
  }
}
