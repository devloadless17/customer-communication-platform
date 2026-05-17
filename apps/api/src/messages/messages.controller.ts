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

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { MessagesService } from "./messages.service";
import {
  ForwardMessagesSchema,
  SendMediaFormSchema,
  SendTemplateSchema,
  SendTextSchema,
  type ForwardMessagesInput,
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
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  async sendText(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendTextSchema)) body: SendTextInput,
  ) {
    const out = await this.messages.sendText(session.teamId, session.userId, body);
    return { ok: true, messageId: out.messageId };
  }

  /**
   * Multipart `file` + form fields. Multer's per-kind size cap can't be
   * applied at the interceptor level (we classify the kind from mime type
   * AFTER multer accepts), so the hard ceiling here is 100 MiB (the largest
   * cap — documents). The service does the per-kind check post-upload.
   */
  @Post("media")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 100 * 1024 * 1024 } }),
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
  }

  @Post("template")
  async sendTemplate(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendTemplateSchema)) body: SendTemplateInput,
  ) {
    const out = await this.messages.sendTemplate(session.teamId, session.userId, body);
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
