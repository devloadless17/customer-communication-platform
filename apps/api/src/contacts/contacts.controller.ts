import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
    return this.contacts.importCsv(session.teamId, file.buffer);
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
  async exportCsv(
    @CurrentSession() session: ApiSession,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, filename } = await this.contacts.exportCsv(session.teamId);
    res
      .status(200)
      .set("content-type", "text/csv; charset=utf-8")
      .set("content-disposition", `attachment; filename="${filename}"`)
      .send(csv);
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
