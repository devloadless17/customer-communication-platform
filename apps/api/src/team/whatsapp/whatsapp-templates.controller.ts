import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";

import { CurrentSession } from "../../auth/current-session.decorator";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateTemplateBindingsSchema,
  type UpdateTemplateBindingsInput,
} from "./whatsapp.schemas";
import { WhatsappService } from "./whatsapp.service";

/**
 * WhatsApp template catalog — any agent on the team.
 *
 *   GET    /api/team/whatsapp/templates                — list cached
 *   POST   /api/team/whatsapp/templates                — re-sync from Meta
 *   POST   /api/team/whatsapp/templates/create         — create new template
 *   POST   /api/team/whatsapp/templates/upload-media   — resumable header upload
 *   DELETE /api/team/whatsapp/templates/:id            — remove (Meta first, then local)
 *   PATCH  /api/team/whatsapp/templates/:id            — update variableBindings only
 *
 * Routes intentionally NOT admin-gated — pre-migration behavior matched
 * the team-scoped session lookup (a contact on team A can never see team
 * B's templates). Tighten to admin-only later if/when roles harden.
 *
 * Route order: static paths (`create`, `upload-media`) MUST precede `:id`
 * — Express matches in registration order.
 */
@Controller("api/team/whatsapp/templates")
@UseGuards(SessionGuard)
export class WhatsappTemplatesController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    return this.whatsapp.listTemplates(session.teamId);
  }

  @Post()
  async sync(@CurrentSession() session: ApiSession) {
    return this.whatsapp.syncTemplates(session.teamId);
  }

  /**
   * Body validation is intentionally inline in the service — Meta's
   * component shape would need ~150 lines of Zod-per-language refinement
   * to mirror, and Meta's own errors are more informative than anything
   * we'd reimplement.
   */
  @Post("create")
  async create(
    @CurrentSession() session: ApiSession,
    @Body() body: unknown,
  ) {
    const out = await this.whatsapp.createTemplate(session.teamId, body);
    return { ok: true, ...out };
  }

  /**
   * Resumable upload for template header media. 16 MB cap enforced both
   * at multer (hard) and in the service (friendlier 413 message). Multer
   * default storage is memory, so `file.buffer` is populated.
   */
  @Post("upload-media")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  async uploadMedia(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({ error: "file part missing" });
    }
    const out = await this.whatsapp.uploadHeaderMedia(session.teamId, file);
    return { ok: true, ...out };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.whatsapp.deleteTemplate(session.teamId, id);
    return { ok: true };
  }

  @Patch(":id")
  async updateBindings(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateTemplateBindingsSchema)) body: UpdateTemplateBindingsInput,
  ) {
    await this.whatsapp.updateTemplateBindings(session.teamId, id, body);
    return { ok: true };
  }
}
