import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";
import { randomUUID } from "node:crypto";

import { blobStorage } from "@/lib/blob-storage";
import { r2Internal } from "@/lib/blob-storage/r2";

import { streamBlob } from "../media/stream-blob";
import { ScopedByConversation } from "../auth/conversation-visibility.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { RateLimit } from "../common/rate-limit.interceptor";
import { zBody } from "../common/zod-validation.pipe";
import { MessagesService } from "./messages.service";
import {
  ForwardMessagesSchema,
  RefineSchema,
  SendContactsSchema,
  SendInteractiveSchema,
  SendLocationSchema,
  SendMediaFormSchema,
  SendReactionSchema,
  DismissReactionSchema,
  SendTemplateSchema,
  SendTextSchema,
  TranslateSchema,
  type ForwardMessagesInput,
  type RefineInput,
  type SendContactsInput,
  type SendInteractiveInput,
  type SendLocationInput,
  type SendReactionInput,
  type DismissReactionInput,
  type SendMediaFormInput,
  type SendTemplateInput,
  type SendTextInput,
  type TranslateInput,
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
// Agent conversation-visibility boundary. These routes carry `conversationId`
// in the BODY, and they WRITE — sending, reacting or forwarding inside a thread
// the agent isn't allowed to see is a worse failure than reading it, so the
// same guard that protects the read side protects these too. Routes without a
// `conversationId` (media upload, template-header fetch) are unaffected.
@ScopedByConversation("conversationId")
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
    // `?retry=1` is a transport hint (not persisted message content, so it
    // stays a query param rather than a body/schema field): set only when the
    // client re-sends a failed bubble under its original clientTempId, letting
    // the queue skip its failed-job cleanup probe on the common first-send path.
    @Query("retry") retry?: string,
  ) {
    // Post-S1: returns `{ ok, queued, clientTempId? }` after preflight +
    // enqueue (~5 ms typical). The actual Meta send happens in the
    // `message-sends` BullMQ worker, with success surfaced via the
    // `message:new` socket event (reconciles the optimistic bubble) and
    // failure surfaced via `message:failed`. The frontend reply-box does
    // NOT read `messageId` from this response anymore; the legacy shape
    // returned a real messageId because the send was synchronous.
    const out = await this.messages.sendText(session.workspaceId, session.userId, body, retry === "1");
    return { ok: out.ok, queued: true, ...("clientTempId" in out ? { clientTempId: out.clientTempId } : {}) };
  }

  /**
   * Translate composer text to a target language (DeepL). Session-authed only;
   * doesn't touch a conversation, just transforms the draft text the agent
   * passes in. Shares the controller's rate-limit bucket — fine, it's only hit
   * on an explicit language pick.
   */
  @Post("translate")
  async translate(
    @CurrentSession() _session: ApiSession,
    @Body(zBody(TranslateSchema)) body: TranslateInput,
  ) {
    return this.messages.translate(body);
  }

  /**
   * AI-refine composer text (Formalise / Friendly / Shorten / Fix grammar —
   * Gmail-"Polish"-style). Session-authed only; stateless draft transform,
   * same shape as `translate` above. Shares the controller's rate-limit
   * bucket — fine, it's only hit on an explicit menu pick.
   */
  @Post("refine")
  async refine(
    @CurrentSession() _session: ApiSession,
    @Body(zBody(RefineSchema)) body: RefineInput,
  ) {
    return this.messages.refine(body);
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
        session.workspaceId,
        session.userId,
        form,
        file,
        session,
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
   * Preview for staged template-header media. The upload below returns a STABLE
   * (private, non-fetchable) R2 object URL as `link`; the composer renders its
   * thumbnail through this authenticated route, which validates the URL is ours
   * and STREAMS the object same-origin. Keeps the persisted / sent `link`
   * signature-free while still previewing.
   */
  @Get("template-header-media")
  async previewTemplateHeaderMedia(
    @CurrentSession() session: ApiSession,
    @Query("url") rawUrl: string | undefined,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // `isOwnUrl` only proves the URL is on OUR bucket host — it does NOT scope
    // by team, so on its own it lets any session stream any team's media (keys
    // are reconstructable from any presigned URL a team ever emitted, e.g. via
    // toExternalMediaUrl in webhook/v1 payloads). Every other media surface
    // checks team ownership before serving bytes; do the same here by requiring
    // the recovered key to live under the caller's `media/{workspaceId}/` prefix.
    if (!rawUrl || !blobStorage.isOwnUrl(rawUrl) || !isOwnTeamMediaUrl(rawUrl, session.workspaceId)) {
      throw new NotFoundException({ error: "not_found" });
    }
    await streamBlob(res, rawUrl, range);
  }

  /**
   * Upload a media file for an IMAGE/VIDEO/DOCUMENT template header. Returns a
   * STABLE R2 object URL the caller passes back as `variables.headerMedia.link`
   * on the subsequent template send (presigned fresh at send time so Meta can
   * fetch it). Separate from `media` (which sends a message) — this only stages
   * the header media. Preview it via GET /api/messages/template-header-media.
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
      const out = await this.messages.uploadTemplateHeaderMedia(session.workspaceId, file);
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
    const out = await this.messages.sendTemplate(session.workspaceId, session.userId, body);
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
    const out = await this.messages.sendInteractive(session.workspaceId, session.userId, body);
    return { ok: true, messageId: out.messageId };
  }

  @Post("location")
  async sendLocation(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendLocationSchema)) body: SendLocationInput,
  ) {
    const out = await this.messages.sendLocation(session.workspaceId, session.userId, body);
    return { ok: true, messageId: out.messageId };
  }

  @Post("contact")
  async sendContacts(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendContactsSchema)) body: SendContactsInput,
  ) {
    const out = await this.messages.sendContacts(session.workspaceId, session.userId, body);
    return { ok: true, messageId: out.messageId };
  }

  @Post("reaction")
  async react(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SendReactionSchema)) body: SendReactionInput,
  ) {
    await this.messages.reactToMessage(session.workspaceId, session.userId, body);
    return { ok: true };
  }

  // Locally clear a stuck CUSTOMER reaction (Instagram never delivers a removal
  // webhook, so the agent dismisses it manually). No Meta call — see
  // MessagesService.dismissReaction.
  @Post("reaction/dismiss")
  async dismissReaction(
    @CurrentSession() session: ApiSession,
    @Body(zBody(DismissReactionSchema)) body: DismissReactionInput,
  ) {
    return this.messages.dismissReaction(session.workspaceId, body.messageId, session);
  }

  @Post("forward")
  async forward(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ForwardMessagesSchema)) body: ForwardMessagesInput,
  ) {
    return this.messages.forward(session.workspaceId, session.userId, body, session);
  }
}

/**
 * Team-scope gate for the header-media preview. Staged header-media objects are
 * keyed `media/{workspaceId}/…` (see r2 `buildKey`), so recover the key from our own
 * stable object URL — path-style `https://…/{bucket}/{key}` — and require it to
 * sit under the caller's team prefix. Assumes `blobStorage.isOwnUrl` already
 * vetted the host. teamIds are URL-safe (cuid) so no re-sanitization needed.
 */
function isOwnTeamMediaUrl(rawUrl: string, workspaceId: string): boolean {
  // Recover the object key via r2's canonical parser (host + `/{bucket}/` prefix
  // check) instead of re-deriving it here — one source of truth for what "our
  // key" means, and it returns null (→ false) for foreign/malformed URLs or an
  // env/config miss rather than throwing. Only the team-scope gate stays local.
  const key = r2Internal.keyFromOwnUrl(rawUrl);
  if (!key) return false;
  return key.startsWith(`media/${workspaceId}/`);
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
