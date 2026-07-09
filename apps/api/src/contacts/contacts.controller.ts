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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
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
    return this.contacts.list(session.teamId, query);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateContactSchema)) body: CreateContactInput,
  ) {
    const contact = await this.contacts.create(session.teamId, session.userId, body);
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
    return this.contacts.bulk(session.teamId, session.userId, body);
  }

  /**
   * CSV import. multipart/form-data with a single `file` part. The 5MB cap
   * is enforced both at the multer layer (hard cap on memory ingest) AND in
   * the service (friendlier 400 message). Multer uses memoryStorage by
   * default, so `file.buffer` is populated.
   */
  @Post("import")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  async import(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({ error: "missing 'file' field" });
    }
    // CSV import auto-creates unknown tag names — gate that on the same
    // `tags:manage` capability the tag CRUD endpoints require, so a user who
    // can import but not manage tags can't create tags via the back door.
    // Without it, import links only to EXISTING tags (unknown names skipped).
    const canManageTags = !!resolvePermissions(
      session.role,
      session.rolePermissions,
    )["tags:manage"];
    return this.contacts.importCsv(
      session.teamId,
      session.userId,
      file.buffer,
      canManageTags,
    );
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
    const contacts = await this.contacts.lookup(session.teamId, ids);
    return { contacts };
  }

  @Get("export")
  @RequireCapability("contacts:export")
  async exportCsv(
    @CurrentSession() session: ApiSession,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, filename, truncated, total } = await this.contacts.exportCsv(
      session.teamId,
    );
    res
      .status(200)
      .set("content-type", "text/csv; charset=utf-8")
      .set("content-disposition", `attachment; filename="${filename}"`)
      // Truncation signal for API/fetch consumers (the in-app export is an
      // <a download> that can't read headers — its filename carries the cap).
      .set("x-export-truncated", truncated ? "true" : "false")
      .set("x-export-total", String(total))
      .send(csv);
  }

  /**
   * Blank import template. Header-only CSV listing every column the importer
   * recognizes (built-in fields + the team's active custom fields). Drives
   * the "Download template" button in the contact import dialog.
   */
  @Get("template")
  async importTemplate(
    @CurrentSession() session: ApiSession,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, filename } = await this.contacts.importTemplateCsv(session.teamId);
    res
      .status(200)
      .set("content-type", "text/csv; charset=utf-8")
      .set("content-disposition", `attachment; filename="${filename}"`)
      .send(csv);
  }

  /**
   * Total contact count for the team. Used by the broadcast wizard's "All
   * contacts" card. Separate from /count (audience union) on purpose: that
   * endpoint returns 0 when both tag/contact arrays are empty, which is the
   * correct contract for "user picked nothing." This route answers "how many
   * contacts are in this team" with no audience semantics.
   */
  @Get("count-all")
  async countAll(@CurrentSession() session: ApiSession) {
    const count = await this.contacts.countAll(session.teamId);
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
    const ok = await this.contacts.hasCapturedAvatar(session.teamId, contactId);
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
    const contact = await this.contacts.syncSocialProfile(session.teamId, contactId);
    return { contact };
  }

  @Post("count")
  async count(
    @CurrentSession() session: ApiSession,
    @Body(zBody(AudienceCountSchema)) body: AudienceCountInput,
  ) {
    const count = await this.contacts.countAudience(session.teamId, body);
    return { count };
  }

  @Post("preview")
  async preview(
    @CurrentSession() session: ApiSession,
    @Body(zBody(AudiencePreviewSchema)) body: AudiencePreviewInput,
  ) {
    return this.contacts.previewAudience(session.teamId, body);
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
      session.teamId,
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
    await this.contacts.remove(session.teamId, session.userId, id);
    return { ok: true };
  }

  @Put(":id/tags")
  async setTags(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetContactTagsSchema)) body: SetContactTagsInput,
  ) {
    const out = await this.contacts.setTags(
      session.teamId,
      session.userId,
      id,
      body,
    );
    return { ok: true, tagIds: out.tagIds };
  }
}
