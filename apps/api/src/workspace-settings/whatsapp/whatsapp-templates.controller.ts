import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

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
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { diskStorage } from "multer";

import { RequireCapability } from "../../auth/capability.guard";
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
 *   GET    /api/workspace/whatsapp/templates                — list cached
 *   POST   /api/workspace/whatsapp/templates                — re-sync from Meta
 *   POST   /api/workspace/whatsapp/templates/create         — create new template
 *   POST   /api/workspace/whatsapp/templates/upload-media   — resumable header upload
 *   DELETE /api/workspace/whatsapp/templates/:id            — remove (Meta first, then local)
 *   PATCH  /api/workspace/whatsapp/templates/:id            — update variableBindings only
 *   GET    /api/workspace/whatsapp/templates/:id/analytics   — stored daily rollup
 *   POST   /api/workspace/whatsapp/templates/:id/analytics/refresh — pull from Meta
 *
 * Read routes (list / sync from Meta) are open to any team member. Mutations
 * (create / upload-media / update bindings / delete) require the
 * `templates:manage` capability — admin-configurable per role (defaults to on
 * for everyone, preserving prior open behavior until an admin restricts it).
 *
 * Route order: static paths (`create`, `upload-media`) MUST precede `:id`
 * — Express matches in registration order.
 */
@Controller("api/workspace/whatsapp/templates")
@UseGuards(SessionGuard)
export class WhatsappTemplatesController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    return this.whatsapp.listTemplates(session.workspaceId);
  }

  @Post()
  async sync(@CurrentSession() session: ApiSession) {
    return this.whatsapp.syncTemplates(session.workspaceId);
  }

  /**
   * Body validation is intentionally inline in the service — Meta's
   * component shape would need ~150 lines of Zod-per-language refinement
   * to mirror, and Meta's own errors are more informative than anything
   * we'd reimplement.
   */
  @Post("create")
  @RequireCapability("templates:manage")
  async create(
    @CurrentSession() session: ApiSession,
    @Body() body: unknown,
  ) {
    const out = await this.whatsapp.createTemplate(session.workspaceId, body);
    return { ok: true, ...out };
  }

  /**
   * Resumable upload for template header media. 16 MB cap enforced both
   * at multer (hard) and in the service (friendlier 413 message).
   *
   * `diskStorage` (NOT default memoryStorage). 10 concurrent 16 MB uploads
   * to memoryStorage = 160 MiB pinned heap; diskStorage streams to a temp
   * file. The service expects `file.buffer`, so we load + reassign before
   * calling, then unlink in finally.
   */
  @Post("upload-media")
  @RequireCapability("templates:manage")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 16 * 1024 * 1024 },
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) =>
          cb(
            null,
            `ccp-tmpl-${randomUUID()}-${sanitizeTemplateOriginalName(file.originalname)}`,
          ),
      }),
    }),
  )
  async uploadMedia(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({ error: "file part missing" });
    }
    try {
      const buffer = await readFile(file.path);
      const fileWithBuffer = { ...file, buffer } as Express.Multer.File;
      const out = await this.whatsapp.uploadHeaderMedia(session.workspaceId, fileWithBuffer);
      return { ok: true, ...out };
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * Meta's own daily analytics for one template.
   *
   * A READ of the stored rollup — no Graph call — so opening a template's
   * drawer costs one indexed range scan. `?days=` bounds the window; Meta's
   * lookback ceiling is 90, and asking beyond it returns an EMPTY set rather
   * than an error, which would read as "this template has no data".
   *
   * `POST :id/analytics/refresh` is what actually pulls from Meta.
   */
  @Get(":id/analytics")
  async analytics(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("days") daysRaw?: string,
  ) {
    return this.whatsapp.templateAnalytics(session.workspaceId, id, daysRaw);
  }

  @Post(":id/analytics/refresh")
  @HttpCode(200)
  @RateLimit({ perMinute: 10 })
  async refreshAnalytics(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("days") daysRaw?: string,
  ) {
    return this.whatsapp.refreshTemplateAnalytics(session.workspaceId, id, daysRaw);
  }

  @Delete(":id")
  @RequireCapability("templates:manage")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.whatsapp.deleteTemplate(session.workspaceId, id);
    return { ok: true };
  }

  @Patch(":id")
  @RequireCapability("templates:manage")
  async updateBindings(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateTemplateBindingsSchema)) body: UpdateTemplateBindingsInput,
  ) {
    await this.whatsapp.updateTemplateBindings(session.workspaceId, id, body);
    return { ok: true };
  }
}

function sanitizeTemplateOriginalName(name: string | undefined): string {
  if (!name) return "file";
  const base = name.replace(/[/\\]/g, "_").replace(/\.+$/g, "");
  return base.slice(-64) || "file";
}
