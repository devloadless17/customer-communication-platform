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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { ChannelsService } from "./channels.service";
import {
  AddChannelMembersSchema,
  CreateChannelSchema,
  EditChannelMessageSchema,
  PostChannelMessageSchema,
  ToggleReactionSchema,
  UpdateChannelSchema,
  type AddChannelMembersInput,
  type CreateChannelInput,
  type EditChannelMessageInput,
  type PostChannelMessageInput,
  type ToggleReactionInput,
  type UpdateChannelInput,
} from "./channels.schemas";

/**
 * Team-chat channels: channels CRUD + messages CRUD + pins + reactions.
 *
 *   GET    /api/team/channels                              — list
 *   POST   /api/team/channels                              — create (admin/manager)
 *   PATCH  /api/team/channels/:id                          — rename / edit
 *   DELETE /api/team/channels/:id                          — admin only
 *   GET    /api/team/channels/:id/messages                 — list (?before / ?after / ?take)
 *   POST   /api/team/channels/:id/messages                 — post top-level
 *   PATCH  /api/team/channels/:id/messages/:mid            — edit (author-only, time-limited)
 *   DELETE /api/team/channels/:id/messages/:mid            — author or admin
 *   POST   /api/team/channels/:id/messages/:mid/pin        — pin (admin/manager)
 *   DELETE /api/team/channels/:id/messages/:mid/pin        — unpin
 *   POST   /api/team/channels/:id/messages/:mid/reactions  — toggle reaction
 *   POST   /api/team/channels/:id/read                     — stamp read receipt
 *   GET    /api/team/channels/:id/messages/:mid/thread     — list thread replies (keyset asc, ?after / ?take)
 *   POST   /api/team/channels/:id/messages/:mid/thread     — post a thread reply
 *   GET    /api/team/channels/:id/messages/search          — ?q substring search (keyset desc, ?before / ?take)
 *   GET    /api/team/channels/:id/messages/around          — ?messageId context window (jump-to-message)
 *   GET    /api/team/channels/:id/messages/:mid/media      — auth-gated redirect to attachment CDN URL
 *   GET    /api/team/channels/search                       — ?q workspace-wide substring search
 *   POST   /api/team/channels/:id/media                    — upload file (multipart)
 */
@Controller("api/team/channels")
@UseGuards(SessionGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const items = await this.channels.list(session.teamId, session.userId);
    return { items };
  }

  // `default` and `search` are static segments — must come before any `:id`
  // route below so Express doesn't match them as a channel id. The
  // `RESERVED_NAMES` set in shared/team-chat/types.ts refuses channel
  // creation with these slugs as defense in depth.
  @Get("default")
  async getDefault(@CurrentSession() session: ApiSession) {
    const channel = await this.channels.getDefault(session.teamId);
    return { channel };
  }

  /**
   * Workspace-wide substring search across every channel in the team. Same
   * `pg_trgm` index as the per-channel search; each hit carries `channelName`
   * so the result row can render context. Cmd+K-style search modal hits this.
   */
  @Get("search")
  async searchAll(
    @CurrentSession() session: ApiSession,
    @Query("q") q?: string,
    @Query("before") before?: string,
    @Query("take") take?: string,
  ) {
    return this.channels.searchAllMessages(session.teamId, session.userId, q ?? "", {
      before,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  @Get(":id")
  async getById(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const channel = await this.channels.getById(session.teamId, session.userId, id);
    return { channel };
  }

  @Get(":id/pins")
  async listPins(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const pins = await this.channels.listPins(session.teamId, session.userId, id);
    return { pins };
  }

  @Get(":id/members")
  async listMembers(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const members = await this.channels.listMembers(session.teamId, session.userId, id);
    return { members };
  }

  @Post(":id/members")
  async addMembers(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(AddChannelMembersSchema)) body: AddChannelMembersInput,
  ) {
    const out = await this.channels.addMembers(
      session.teamId,
      session.userId,
      session.role,
      id,
      body.userIds,
    );
    return { ok: true, ...out };
  }

  @Delete(":id/members/:userId")
  async removeMember(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("userId") userId: string,
  ) {
    await this.channels.removeMember(
      session.teamId,
      session.userId,
      session.role,
      id,
      userId,
    );
    return { ok: true };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateChannelSchema)) body: CreateChannelInput,
  ) {
    const channel = await this.channels.create(session.teamId, session.userId, session.role, body);
    return { channel };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateChannelSchema)) body: UpdateChannelInput,
  ) {
    const channel = await this.channels.update(session.teamId, session.role, id, body);
    return { channel };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.channels.remove(session.teamId, session.role, id);
    return { ok: true };
  }

  @Get(":id/messages")
  async listMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("after") after?: string,
    @Query("before") before?: string,
    @Query("take") take?: string,
  ) {
    return this.channels.listMessages(session.teamId, session.userId, id, {
      after,
      before,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  @Post(":id/messages")
  async postMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PostChannelMessageSchema)) body: PostChannelMessageInput,
  ) {
    const out = await this.channels.postMessage(session, id, body);
    return { ok: true, ...out };
  }

  @Patch(":id/messages/:mid")
  async editMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Body(zBody(EditChannelMessageSchema)) body: EditChannelMessageInput,
  ) {
    const out = await this.channels.editMessage(session.teamId, session.userId, id, mid, body);
    return { ok: true, ...out };
  }

  @Delete(":id/messages/:mid")
  async deleteMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
  ) {
    await this.channels.deleteMessage(
      session.teamId,
      session.userId,
      session.role,
      id,
      mid,
    );
    return { ok: true };
  }

  @Post(":id/messages/:mid/pin")
  async pin(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
  ) {
    await this.channels.pinMessage(session.teamId, session.userId, session.role, id, mid);
    return { ok: true };
  }

  @Delete(":id/messages/:mid/pin")
  async unpin(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
  ) {
    await this.channels.unpinMessage(session.teamId, session.userId, session.role, id, mid);
    return { ok: true };
  }

  @Post(":id/messages/:mid/reactions")
  async react(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Body(zBody(ToggleReactionSchema)) body: ToggleReactionInput,
  ) {
    const out = await this.channels.toggleReaction(session.teamId, session.userId, id, mid, body);
    return { ok: true, ...out };
  }

  @Post(":id/read")
  async markRead(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const out = await this.channels.markRead(session.teamId, session.userId, id);
    return { ok: true, ...out };
  }

  @Get(":id/messages/:mid/thread")
  async listThread(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Query("after") after?: string,
    @Query("take") take?: string,
  ) {
    return this.channels.listThreadReplies(session.teamId, session.userId, id, mid, {
      after,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  /**
   * Channel-scoped substring search. Returns the same `ChannelMessagesPage`
   * shape as the feed list so the frontend reuses the message DTO + cursor.
   * Backed by the pg_trgm GIN index on body; the service refuses 1-char
   * queries upstream so we don't degenerate into a sequential scan.
   */
  @Get(":id/messages/search")
  async searchMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("q") q?: string,
    @Query("before") before?: string,
    @Query("take") take?: string,
  ) {
    return this.channels.searchMessages(session.teamId, session.userId, id, q ?? "", {
      before,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  /**
   * Context window around an anchor message. Used by search jump-to when the
   * target message isn't in the user's currently-loaded slice. Returns
   * `~take/2` messages on each side of the anchor plus the anchor itself,
   * with hasMore flags + cursors for paginating outward.
   */
  @Get(":id/messages/around")
  async getMessagesAround(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("messageId") messageId?: string,
    @Query("take") take?: string,
  ) {
    if (!messageId) {
      throw new BadRequestException({ error: "messageId required" });
    }
    return this.channels.getMessagesAround(session.teamId, session.userId, id, messageId, {
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  /**
   * Auth-gated, team-scoped, membership-gated proxy for a channel message's
   * attachment. Mirrors MediaController.get for WhatsApp media: the service
   * verifies channel membership + team scope + `isOwnUrl` before we 302 to the
   * CDN URL. mapMessage emits this RELATIVE path (not the raw CDN URL) so
   * internal attachments are protected by auth + membership, not just key
   * unguessability (M4). Same 1-year immutable cache as MediaController — the
   * underlying blob URL is content-addressed.
   */
  @Get(":id/messages/:mid/media")
  async getMessageMedia(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.channels.getMessageMediaUrl(
      session.teamId,
      session.userId,
      id,
      mid,
    );
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.set("Vary", "Cookie");
    res.redirect(302, url);
  }

  @Post(":id/messages/:mid/thread")
  async postThread(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Body(zBody(PostChannelMessageSchema)) body: PostChannelMessageInput,
  ) {
    const out = await this.channels.postThreadReply(session, id, mid, body);
    return { ok: true, ...out };
  }

  /**
   * Multipart `file` + optional `body` (caption) + `clientTempId` + `threadRootId`.
   * Cap mirrors apps/api/src/messages/messages.controller.ts:sendMedia — multer
   * enforces a hard 100 MiB ceiling (the largest per-kind cap); the service
   * tightens per-kind once it classifies from the mime type.
   *
   * Uses `diskStorage` (NOT the default memoryStorage). Without this, four
   * concurrent 100 MiB uploads = 400 MiB of pinned V8 heap; on the 4 GB
   * pilot VPS that's one OOM crash away from taking every connected agent
   * across every team offline. Streams to a temp file; service reads + we
   * unlink in a finally block.
   */
  @Post(":id/media")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 100 * 1024 * 1024 },
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) =>
          cb(
            null,
            `ccp-channel-${randomUUID()}-${sanitizeChannelOriginalName(file.originalname)}`,
          ),
      }),
    }),
  )
  async uploadMedia(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() form: Record<string, string>,
  ) {
    if (!file) throw new BadRequestException({ error: "file required" });
    const body = (form.body ?? "").trim().slice(0, 4000);
    const clientTempId =
      typeof form.clientTempId === "string" && form.clientTempId
        ? form.clientTempId
        : undefined;
    const threadRootId =
      typeof form.threadRootId === "string" && form.threadRootId
        ? form.threadRootId
        : null;

    try {
      const bytes = await readFile(file.path);
      const out = await this.channels.uploadMedia(session.teamId, session.userId, id, {
        file: {
          bytes: new Uint8Array(bytes),
          mimeType: file.mimetype || "application/octet-stream",
          filename: file.originalname || "upload",
          size: file.size,
        },
        body,
        clientTempId,
        threadRootId,
      });
      return { ok: true, ...out };
    } finally {
      // Best-effort cleanup. A leaked temp file is preferable to throwing
      // out of the finally block; the OS tmp dir sweeps on reboot and the
      // sweeper at apps/api/src/lib/sweepers/blob-orphan.ts also handles
      // strays via the periodic clean.
      await unlink(file.path).catch(() => undefined);
    }
  }
}

/**
 * Strip path separators + truncate so the original filename doesn't smuggle
 * a relative path into the temp directory.
 */
function sanitizeChannelOriginalName(name: string | undefined): string {
  if (!name) return "file";
  const base = name.replace(/[/\\]/g, "_").replace(/\.+$/g, "");
  return base.slice(-64) || "file";
}
