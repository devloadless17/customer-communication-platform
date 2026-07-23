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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";
import { randomUUID } from "node:crypto";

import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { azureTtsConfigured, isAzureVoice } from "@/lib/ai/azure-tts";
import { openaiConfigured } from "@/lib/ai/openai-client";
import { renderTts } from "@/lib/ai/voice";

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
  VoicePreviewSchema,
  type PatchDocumentInput,
  type UpdateAiConfigInput,
  type VoicePreviewInput,
} from "./ai-assistant.schemas";

// Short sample line per language so the voice preview says something natural in
// the language the admin picked (falls back to English).
function voiceSampleLine(lang: string | undefined): string {
  const l = (lang ?? "").toLowerCase();
  if (l.startsWith("ar")) return "مرحبا! أنا المساعد الآلي، بخدمتك بأي وقت. كيف فيني ساعدك اليوم؟";
  if (l.startsWith("fr")) return "Bonjour ! Je suis votre assistant. Comment puis-je vous aider aujourd'hui ?";
  if (l.startsWith("es")) return "¡Hola! Soy tu asistente. ¿En qué puedo ayudarte hoy?";
  if (l.startsWith("de")) return "Hallo! Ich bin dein Assistent. Wie kann ich dir heute helfen?";
  return "Hi! I'm your AI assistant. How can I help you today?";
}

/**
 * AI Assistant settings surface.
 *
 *   GET /api/workspace/ai-assistant                       — read config (+ defaults)
 *   PUT /api/workspace/ai-assistant                       — save config (CAS)
 *   GET /api/workspace/ai-assistant/documents             — list knowledge files
 *   POST /api/workspace/ai-assistant/documents            — upload a knowledge file
 *   POST /api/workspace/ai-assistant/documents/:id/reprocess
 *   PATCH /api/workspace/ai-assistant/documents/:id       — enable/disable
 *   DELETE /api/workspace/ai-assistant/documents/:id      — delete (+ R2 + chunks)
 *
 * Everything is gated by the admin-configurable `aiAssistant:manage` capability
 * (agents OPERATE the assistant from the inbox via separate endpoints; they
 * don't configure it). 8 MB upload buffer; the service enforces the real caps.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Controller("api/workspace/ai-assistant")
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
    const config = await this.config.getConfig(session.workspaceId);
    return { config };
  }

  @Put()
  async updateConfig(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateAiConfigSchema)) body: UpdateAiConfigInput,
  ) {
    this.assertManage(session);
    const config = await this.config.updateConfig(session.workspaceId, true, body);
    return { config };
  }

  @Post("voice-preview")
  @RateLimit({ perMinute: 30 })
  async voicePreview(
    @CurrentSession() session: ApiSession,
    @Body(zBody(VoicePreviewSchema)) body: VoicePreviewInput,
    @Res() res: Response,
  ): Promise<void> {
    this.assertManage(session);
    const azure = isAzureVoice(body.voiceId);
    if (azure ? !azureTtsConfigured() : !openaiConfigured()) {
      throw new BadRequestException({
        error: azure ? "azure_tts_not_configured" : "openai_not_configured",
      });
    }
    let audio: { bytes: Uint8Array; contentType: string };
    try {
      audio = await renderTts({
        text: voiceSampleLine(body.voiceLanguage),
        voiceId: body.voiceId,
        speed: body.voiceSpeed,
      });
    } catch (err) {
      throw new BadRequestException({
        error: "voice_preview_failed",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    res.setHeader("content-type", audio.contentType);
    res.setHeader("cache-control", "no-store");
    res.end(Buffer.from(audio.bytes));
  }

  @Get("documents")
  async listDocuments(@CurrentSession() session: ApiSession) {
    this.assertManage(session);
    const documents = await this.knowledge.list(session.workspaceId);
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
      const document = await this.knowledge.upload(session.workspaceId, {
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
    return this.knowledge.reprocess(session.workspaceId, id);
  }

  @Patch("documents/:id")
  async patchDocument(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PatchDocumentSchema)) body: PatchDocumentInput,
  ) {
    this.assertManage(session);
    const document = await this.knowledge.setEnabled(session.workspaceId, id, body.enabled);
    return { document };
  }

  @Delete("documents/:id")
  async deleteDocument(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    this.assertManage(session);
    return this.knowledge.remove(session.workspaceId, id);
  }
}
