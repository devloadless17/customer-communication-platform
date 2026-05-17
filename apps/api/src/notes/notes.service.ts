import { Injectable, NotFoundException } from "@nestjs/common";

import type { InternalNote } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type { CreateNoteInput } from "./notes.schemas";

/**
 * Internal notes — never leave the platform. No provider call, no external
 * id, no WhatsApp message. CLAUDE.md week-3 deliverable.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  async create(
    teamId: string,
    authorUserId: string,
    input: CreateNoteInput,
  ): Promise<{ noteId: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: input.conversationId, teamId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const created = await this.db.internalNote.create({
      data: {
        conversationId: input.conversationId,
        authorUserId,
        body: input.body,
      },
    });

    const note: InternalNote = {
      id: created.id,
      conversationId: created.conversationId,
      authorUserId: created.authorUserId,
      body: created.body,
      timestamp: created.timestamp.toISOString(),
    };

    await this.bus.publish({
      type: "note.created",
      teamId,
      conversationId: input.conversationId,
      note,
    });

    return { noteId: created.id };
  }

  async remove(teamId: string, id: string): Promise<void> {
    // Team scope via the parent conversation — defends against id-stuffing
    // across tenants without joining at the note level (which lacks teamId).
    const note = await this.db.internalNote.findFirst({
      where: { id, conversation: { teamId } },
      select: { id: true, conversationId: true },
    });
    if (!note) throw new NotFoundException({ error: "note not found" });

    await this.db.internalNote.delete({ where: { id } });

    await this.bus.publish({
      type: "note.deleted",
      teamId,
      conversationId: note.conversationId,
      noteId: id,
    });
  }
}
