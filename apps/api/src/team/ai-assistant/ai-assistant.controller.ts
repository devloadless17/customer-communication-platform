import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { randomUUID } from "node:crypto";

import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { CurrentSession } from "../../auth/current-session.decorator";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { zBody } from "../../common/zod-validation.pipe";
import { AiAssistantService } from "./ai-assistant.service";
import { AiKnowledgeService } from "./ai-knowledge.service";
import {
  PatchDocumentSchema,
  UpdateAiConfigSchema,
  type PatchDocumentInput,
  type UpdateAiConfigInput,
} from "./ai-assistant.schemas";

/**
 * AI Assistant settings surface.
 *
 *   GET /api/team/ai-assistant                       — read config (+ defaults)
 *   PUT /api/team/ai-assistant                       — save config (CAS)
 *   GET /api/team/ai-assistant/documents             — list knowledge files
 *   POST /api/team/ai-assistant/documents            — upload a knowledge file
 *   POST /api/team/ai-assistant/documents/:id/reprocess
 *   PATCH /api/team/ai-assistant/documents/:id       — enable/disable
 *   DELETE /api/team/ai-assistant/documents/:id      — delete (+ R2 + chunks)
 *
 * Everything is gated by the admin-configurable `aiAssistant:manage` capability
 * (agents OPERATE the assistant from the inbox via separate endpoints; they
 * don't configure it). 8 MB upload buffer; the service enforces the real caps.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Controller("api/team/ai-assistant")
@UseGuards(SessionGuard)
export class AiAssistantController {
  constructor(
    private readonly config: AiAssistantService,
    private readonly knowledge: AiKnowledgeService,
  ) {}

  private assertManage(session: ApiSession): void {
    const ok = resolvePermissions(session.role, session.rolePermissions)["aiAssistant:manage"];
    if (!ok) throw new ForbiddenException({ error: "forbidden" });
  }

  @Get()
  async getConfig(@CurrentSession() session: ApiSession) {
    this.assertManage(session);
    const config = await this.config.getConfig(session.teamId);
    return { config };
  }

  @Put()
  async updateConfig(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateAiConfigSchema)) body: UpdateAiConfigInput,
  ) {
    this.assertManage(session);
    const config = await this.config.updateConfig(session.teamId, true, body);
    return { config };
  }

  @Get("documents")
  async listDocuments(@CurrentSession() session: ApiSession) {
    this.assertManage(session);
    const documents = await this.knowledge.list(session.teamId);
    return { documents };
  }

  @Post("documents")
  @RateLimit({ perMinute: 20 })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) =>
          cb(null, `ccp-ai-doc-${randomUUID()}-${(file.originalname ?? "file").replace(/[^\w.-]/g, "_").slice(0, 80)}`),
      }),
    }),
  )
  async uploadDocument(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    this.assertManage(session);
    if (!file) throw new BadRequestException({ error: "file required" });
    try {
      const bytes = await readFile(file.path);
      const document = await this.knowledge.upload(session.teamId, {
        bytes: new Uint8Array(bytes),
        mimeType: file.mimetype,
        filename: file.originalname ?? "document",
      });
      return { document };
    } finally {
      await unlink(file.path).catch(() => {});
    }
  }

  @Post("documents/:id/reprocess")
  async reprocessDocument(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    this.assertManage(session);
    return this.knowledge.reprocess(session.teamId, id);
  }

  @Patch("documents/:id")
  async patchDocument(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PatchDocumentSchema)) body: PatchDocumentInput,
  ) {
    this.assertManage(session);
    const document = await this.knowledge.setEnabled(session.teamId, id, body.enabled);
    return { document };
  }

  @Delete("documents/:id")
  async deleteDocument(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    this.assertManage(session);
    return this.knowledge.remove(session.teamId, id);
  }
}
