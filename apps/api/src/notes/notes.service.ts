import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

import type { InternalNote, Role } from "@ccp/shared/types";

import {
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import type { CreateNoteInput } from "./notes.schemas";

/**
 * Internal notes — never leave the platform. No provider call, no external
 * id, no WhatsApp message. CLAUDE.md week-3 deliverable.
 */
@Injectable()
export class NotesService {
  constructor(private readonly db: DbService) {}

  async create(
    workspaceId: string,
    authorUserId: string,
    input: CreateNoteInput,
    viewer?: ConversationViewer,
  ): Promise<{ noteId: string }> {
    const conversation = await this.db.conversation.findFirst({
      // Visibility boundary — a restricted agent can't leave a note on a
      // thread they can't see (404, same as a missing conversation).
      where: {
        id: input.conversationId,
        workspaceId,
        ...(viewer ? visibilityWhere(viewer) : {}),
      },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation_not_found" });

    // Insert + event commit atomically via publishInTx (same durability the
    // messages path uses). A bare create()-then-publish() dropped the audit row
    // AND the outbound-webhook delivery permanently on any crash between the DB
    // commit and the emit; the transactional outbox guarantees the drainer
    // delivers the event at-least-once. kickOutbox() drains it in ~1ms so the
    // note still appears live.
    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.internalNote.create({
        data: {
          workspaceId,
          conversationId: input.conversationId,
          authorUserId,
          body: input.body,
        },
      });
      const note: InternalNote = {
        id: row.id,
        conversationId: row.conversationId,
        authorUserId: row.authorUserId,
        body: row.body,
        timestamp: row.timestamp.toISOString(),
      };
      await publishInTx(tx, {
        type: "note.created",
        workspaceId,
        conversationId: input.conversationId,
        note,
      });
      return row;
    });
    kickOutbox();

    return { noteId: created.id };
  }

  async remove(
    workspaceId: string,
    requesterUserId: string,
    requesterRole: Role,
    id: string,
    viewer?: ConversationViewer,
  ): Promise<void> {
    // Team scope via the parent conversation — defends against id-stuffing
    // across tenants without joining at the note level (which lacks workspaceId).
    const note = await this.db.internalNote.findFirst({
      where: {
        id,
        conversation: {
          workspaceId,
          ...(viewer ? visibilityWhere(viewer) : {}),
        },
      },
      select: { id: true, conversationId: true, authorUserId: true },
    });
    if (!note) throw new NotFoundException({ error: "note_not_found" });

    // Authorship check: the note's author can always delete it. Anyone else
    // needs admin-or-higher (admin / manager / superAdmin) — an agent
    // shouldn't be able to remove a teammate's note. Pre-migration we leaked
    // this guard during the rewrite; restoring it here.
    const isAuthor = note.authorUserId === requesterUserId;
    const isPrivileged =
      requesterRole === "admin" ||
      requesterRole === "manager";
    if (!isAuthor && !isPrivileged) {
      throw new ForbiddenException({
        error: "note_delete_forbidden",
        detail: "Only the note's author or a team admin can delete this note.",
      });
    }

    await this.db.$transaction(async (tx) => {
      await tx.internalNote.delete({ where: { id } });
      await publishInTx(tx, {
        type: "note.deleted",
        workspaceId,
        conversationId: note.conversationId,
        noteId: id,
        deletedByUserId: requesterUserId,
      });
    });
    kickOutbox();
  }
}
