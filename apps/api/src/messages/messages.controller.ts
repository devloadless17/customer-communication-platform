import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { randomUUID } from "node:crypto";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { RateLimit } from "../common/rate-limit.interceptor";
import { zBody } from "../common/zod-validation.pipe";
import { MessagesService } from "./messages.service";
import {
  ForwardMessagesSchema,
  SendInteractiveSchema,
  SendMediaFormSchema,
  SendTemplateSchema,
  SendTextSchema,
  type ForwardMessagesInput,
  type SendInteractiveInput,
  type SendMediaFormInput,
  type SendTemplateInput,
  type SendTextInput,
} from "./messages.schemas";

/**
 * Outbound message sends.
 *
 *   POST /api/messages           — free-form text (inside 24h window)
 *   POST /api/messages/media     — text + binary (multipart/form-data)
 *   POST /api/messages/template  — approved template (legal anytime)
 *   POST /api/messages/forward   — replay N messages to M contacts
 */
@Controller("api/messages")
@UseGuards(SessionGuard)
// Meta's Cloud API hard cap is 80 msg/min per number; 60/min keeps headroom
// AND bounds the cost of a runaway browser script firing the send endpoint.
// Counts text+media+template+forward against one bucket (a user shouldn't be
// able to multiply quota by hitting different routes).
@RateLimit({ perMinute: 60 })
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  async sendText(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendTextSchema)) body: SendTextInput,
  ) {
    // Post-S1: returns `{ ok, queued, clientTempId? }` after preflight +
    // enqueue (~5 ms typical). The actual Meta send happens in the
    // `message-sends` BullMQ worker, with success surfaced via the
    // `message:new` socket event (reconciles the optimistic bubble) and
    // failure surfaced via `message:failed`. The frontend reply-box does
    // NOT read `messageId` from this response anymore; the legacy shape
    // returned a real messageId because the send was synchronous.
    const out = await this.messages.sendText(session.teamId, session.userId, body);
    return { ok: out.ok, queued: true, ...("clientTempId" in out ? { clientTempId: out.clientTempId } : {}) };
  }

  /**
   * Multipart `file` + form fields. Multer's per-kind size cap can't be
   * applied at the interceptor level (we classify the kind from mime type
   * AFTER multer accepts), so the hard ceiling here is 100 MiB (the largest
   * cap — documents). The service does the per-kind check post-upload.
   *
   * `diskStorage` (NOT the default memoryStorage) — multer streams the
   * incoming multipart body to a temp file during the parse, so peak RAM
   * during 5+ concurrent 20 MB uploads is ~5×64 KB chunks instead of
   * ~5×20 MB pinned V8 heap. The service reads the file ONCE post-parse
   * and shares a single Buffer with both providers (Meta + blob storage);
   * the temp file is unlinked in a `finally` block regardless of outcome.
   */
  @Post("media")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 100 * 1024 * 1024 },
      storage: diskStorage({
        destination: tmpdir(),
        // Name includes a uuid prefix so two concurrent sends from the same
        // user never collide on the temp filename.
        filename: (_req, file, cb) =>
          cb(null, `ccp-upload-${randomUUID()}-${sanitizeOriginalName(file.originalname)}`),
      }),
    }),
  )
  async sendMedia(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendMediaFormSchema)) form: SendMediaFormInput,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({
        error: "conversationId and file are required",
      });
    }
    try {
      const out = await this.messages.sendMedia(
        session.teamId,
        session.userId,
        form,
        file,
      );
      return {
        ok: true,
        messageId: out.messageId,
        ...(out.warning ? { warning: out.warning } : {}),
      };
    } finally {
      // Always remove the multipart temp file. sendMediaInner's own `finally`
      // only runs when the work executes; on an idempotency-replay
      // short-circuit (same clientTempId within the TTL) it never runs, which
      // orphaned this request's freshly-parsed temp file in /tmp. ENOENT-
      // tolerant because the service already unlinks on the work path.
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * Upload a media file for an IMAGE/VIDEO/DOCUMENT template header. Returns a
   * public link (UploadThing) the caller passes back as
   * `variables.headerMedia.link` on the subsequent template send. Separate
   * from `media` (which sends a message) — this only stages the header media.
   */
  @Post("template-header-media")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 100 * 1024 * 1024 },
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) =>
          cb(null, `ccp-tplhdr-${randomUUID()}-${sanitizeOriginalName(file.originalname)}`),
      }),
    }),
  )
  async uploadTemplateHeaderMedia(
    @CurrentSession() session: ApiSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({ error: "file is required" });
    }
    try {
      const out = await this.messages.uploadTemplateHeaderMedia(session.teamId, file);
      return { ok: true, ...out };
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  @Post("template")
  async sendTemplate(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendTemplateSchema)) body: SendTemplateInput,
  ) {
    const out = await this.messages.sendTemplate(session.teamId, session.userId, body);
    return { ok: true, messageId: out.messageId };
  }

  /**
   * Agent-side interactive send (buttons / list). Synchronous — no queue
   * scaffolding, since interactive sends are rare admin moves vs. high-
   * volume text replies and the ~300ms inline Meta hop is acceptable for
   * the agent's clicked-Send-button latency.
   */
  @Post("interactive")
  async sendInteractive(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendInteractiveSchema)) body: SendInteractiveInput,
  ) {
    const out = await this.messages.sendInteractive(session.teamId, session.userId, body);
    return { ok: true, messageId: out.messageId };
  }

  @Post("forward")
  async forward(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ForwardMessagesSchema)) body: ForwardMessagesInput,
  ) {
    return this.messages.forward(session.teamId, session.userId, body);
  }
}

/**
 * Strip path separators + truncate so the original filename doesn't smuggle
 * a relative path into the temp directory. Keeps the suffix readable enough
 * to identify in ops without trusting client-controlled bytes for layout.
 */
function sanitizeOriginalName(name: string | undefined): string {
  if (!name) return "file";
  const base = name.replace(/[/\\]/g, "_").replace(/\.+$/g, "");
  return base.slice(-64) || "file";
}
