import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { RealtimeEmitter } from "../realtime/emitter.service";
import type {
  InternalNote,
  Message,
  MessageStatus,
  User,
} from "@ccp/shared/types";

/**
 * Dev-only event firehose. Used by the floating DevTools widget to
 * simulate inbound messages, status changes, etc. without going through
 * Meta.
 *
 * Three layers of defence:
 *   1) `NODE_ENV !== "production"` — refuses prod builds outright (the
 *      route 404s in prod).
 *   2) `ENABLE_DEV_TOOLS=1` — opt-in env flag; defaults off even in dev.
 *   3) SessionGuard + every lookup scoped to `workspaceId` — even with the
 *      flag on, an unauthenticated caller can't touch anything, and a
 *      logged-in user can't reach into another team.
 *
 * Direct-emit semantics preserved on purpose: the dev tool is for
 * client-side testing of socket payload handling, NOT for exercising the
 * full pipeline. Using `RealtimeEmitter` here instead of `bus.publish`
 * skips audit / analytics / workflow-dispatch — which is the original
 * behavior the DevTools UI was designed around.
 */

/**
 * Discriminated-union body schema. The three defenses ([devToolsEnabled],
 * SessionGuard, per-team scoping) protect against the route being callable;
 * this schema protects against arbitrary unvalidated input being written
 * into Message.body / InternalNote.body / emitted into socket frames if the
 * env-flag guard is EVER bypassed by accident (staging mis-tagged as prod,
 * Caddy mis-routed, etc.). Defense in depth — every other controller in
 * this codebase runs zBody; this one was an exception worth closing.
 *
 * Bounded body lengths match what the real ingest paths enforce so a dev
 * payload can't smuggle a row larger than production would ever produce.
 */
const ConversationStatusSchema = z.enum(["open", "pending", "closed"]);

const FakeInboundMessageSchema = z.object({
  kind: z.literal("fake-inbound-message"),
  conversationId: z.string().min(1).max(64),
  body: z.string().min(1).max(4096),
});
const MarkLastReadSchema = z.object({
  kind: z.literal("mark-last-read"),
  conversationId: z.string().min(1).max(64),
});
const AddNoteSchema = z.object({
  kind: z.literal("add-fake-note"),
  conversationId: z.string().min(1).max(64),
  body: z.string().min(1).max(4096),
});
const ToggleStatusSchema = z.object({
  kind: z.literal("toggle-status"),
  conversationId: z.string().min(1).max(64),
  status: ConversationStatusSchema,
});
const AssignSchema = z.object({
  kind: z.literal("assign"),
  conversationId: z.string().min(1).max(64),
  assignedUserId: z.union([z.string().min(1).max(64), z.null()]),
});

const DevEmitSchema = z.discriminatedUnion("kind", [
  FakeInboundMessageSchema,
  MarkLastReadSchema,
  AddNoteSchema,
  ToggleStatusSchema,
  AssignSchema,
]);

type FakeInboundMessageBody = z.infer<typeof FakeInboundMessageSchema>;
type MarkLastReadBody = z.infer<typeof MarkLastReadSchema>;
type AddNoteBody = z.infer<typeof AddNoteSchema>;
type ToggleStatusBody = z.infer<typeof ToggleStatusSchema>;
type AssignBody = z.infer<typeof AssignSchema>;
type DevEmitBody = z.infer<typeof DevEmitSchema>;

function devToolsEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ENABLE_DEV_TOOLS === "1";
}

@Controller("api/dev")
@UseGuards(SessionGuard)
export class DevEmitController {
  constructor(
    private readonly db: DbService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  @Post("emit")
  async emit(
    @CurrentSession() session: ApiSession,
    @Body(zBody(DevEmitSchema)) body: DevEmitBody,
  ): Promise<{ ok: boolean; messageId?: string; noteId?: string; status?: MessageStatus }> {
    if (!devToolsEnabled()) {
      throw new NotFoundException({ error: "not_found" });
    }
    const { workspaceId, userId } = session;

    switch (body.kind) {
      case "fake-inbound-message":
        return this.handleFakeInbound(body, workspaceId);
      case "mark-last-read":
        return this.handleMarkLastRead(body, workspaceId);
      case "add-fake-note":
        return this.handleAddNote(body, workspaceId, userId);
      case "toggle-status":
        return this.handleToggleStatus(body, workspaceId);
      case "assign":
        return this.handleAssign(body, workspaceId);
      default: {
        const _exhaustive: never = body;
        void _exhaustive;
        throw new BadRequestException({ error: "unknown_kind" });
      }
    }
  }

  // -------------------------------------------------------------------------

  private async loadOwnedConversation(conversationId: string, workspaceId: string) {
    return this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
  }

  private async handleFakeInbound(
    { conversationId, body }: FakeInboundMessageBody,
    workspaceId: string,
  ) {
    const convo = await this.loadOwnedConversation(conversationId, workspaceId);
    if (!convo) throw new NotFoundException({ error: "conversation_not_found" });

    const externalId = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    const created = await this.db.message.create({
      data: {
        workspaceId,
        conversationId,
        externalId,
        direction: "in",
        channel: "whatsapp",
        status: "delivered",
        body,
        rawPayload: { fake: true, devTools: true },
        timestamp: now,
      },
    });

    const bumped = await this.db.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: now,
        lastMessagePreview: body,
        lastMessageDirection: "in",
        unreadCount: { increment: 1 },
      },
      select: { unreadCount: true },
    });

    const message: Message = {
      id: created.id,
      workspaceId: created.workspaceId,
      conversationId: created.conversationId,
      externalId: created.externalId,
      senderUserId: null,
      body: created.body,
      direction: "in",
      channel: "whatsapp",
      status: "delivered",
      rawPayload: created.rawPayload as Record<string, unknown>,
      timestamp: created.timestamp.toISOString(),
    };

    // Single team-room emit. Subscribers in conversation rooms also see
    // it (same socket is in both rooms) and filter by conversationId.
    this.emitter.emitToWorkspace(workspaceId, "message:new", {
      workspaceId,
      conversationId,
      message,
      preview: body,
      lastMessageAt: now.toISOString(),
      unreadCount: bumped.unreadCount,
    });

    return { ok: true, messageId: created.id };
  }

  private async handleMarkLastRead(
    { conversationId }: MarkLastReadBody,
    workspaceId: string,
  ) {
    const convo = await this.loadOwnedConversation(conversationId, workspaceId);
    if (!convo) throw new NotFoundException({ error: "conversation_not_found" });

    const lastOutbound = await this.db.message.findFirst({
      where: { conversationId, workspaceId, direction: "out" },
      orderBy: { timestamp: "desc" },
    });
    if (!lastOutbound) {
      throw new NotFoundException({ error: "no_outbound_message" });
    }
    const next: MessageStatus =
      lastOutbound.status === "sent"
        ? "delivered"
        : lastOutbound.status === "delivered"
          ? "read"
          : "read";

    await this.db.message.update({
      where: { id: lastOutbound.id },
      data: { status: next },
    });

    this.emitter.emitToWorkspace(workspaceId, "message:status", {
      workspaceId,
      conversationId,
      messageId: lastOutbound.id,
      status: next,
    });

    return { ok: true, status: next };
  }

  private async handleAddNote(
    { conversationId, body }: AddNoteBody,
    workspaceId: string,
    userId: string,
  ) {
    const convo = await this.loadOwnedConversation(conversationId, workspaceId);
    if (!convo) throw new NotFoundException({ error: "conversation_not_found" });

    const created = await this.db.internalNote.create({
      // Always attribute to the calling user — the request body has no say.
      data: { workspaceId, conversationId, authorUserId: userId, body },
    });

    const note: InternalNote = {
      id: created.id,
      conversationId: created.conversationId,
      authorUserId: created.authorUserId,
      body: created.body,
      timestamp: created.timestamp.toISOString(),
    };

    this.emitter.emitToWorkspace(workspaceId, "note:new", {
      workspaceId,
      conversationId,
      note,
    });

    return { ok: true, noteId: created.id };
  }

  private async handleToggleStatus(
    { conversationId, status }: ToggleStatusBody,
    workspaceId: string,
  ) {
    const convo = await this.loadOwnedConversation(conversationId, workspaceId);
    if (!convo) throw new NotFoundException({ error: "conversation_not_found" });

    await this.db.conversation.update({
      where: { id: conversationId },
      data: { status },
    });

    this.emitter.emitToWorkspace(workspaceId, "conversation:status", {
      workspaceId,
      conversationId,
      status,
    });

    return { ok: true };
  }

  private async handleAssign(
    { conversationId, assignedUserId }: AssignBody,
    workspaceId: string,
  ) {
    const convo = await this.loadOwnedConversation(conversationId, workspaceId);
    if (!convo) throw new NotFoundException({ error: "conversation_not_found" });

    if (assignedUserId) {
      const assignee = await this.db.user.findFirst({
        where: { id: assignedUserId, workspaceMemberships: { some: { workspaceId } } },
        select: { id: true },
      });
      if (!assignee) {
        throw new BadRequestException({ error: "assignee_not_in_team" });
      }
    }

    const updated = await this.db.conversation.update({
      where: { id: conversationId },
      data: { assignedUserId },
      include: { assignedUser: { include: { workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } } } },
    });

    const assignedUser: User | null = updated.assignedUser
      ? {
          id: updated.assignedUser.id,
          workspaceId,
          role: updated.assignedUser.workspaceMemberships[0]?.role ?? "agent",
          name: updated.assignedUser.name,
          email: updated.assignedUser.email,
          avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
          isActive: updated.assignedUser.deactivatedAt === null,
        }
      : null;

    this.emitter.emitToWorkspace(workspaceId, "conversation:assigned", {
      workspaceId,
      conversationId,
      assignedUser,
    });

    return { ok: true };
  }
}
