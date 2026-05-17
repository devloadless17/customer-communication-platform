import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { CreateNoteSchema, type CreateNoteInput } from "./notes.schemas";
import { NotesService } from "./notes.service";

/**
 * Internal notes.
 *
 *   POST   /api/notes            — create
 *   DELETE /api/notes/:id        — delete
 */
@Controller("api/notes")
@UseGuards(SessionGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateNoteSchema)) body: CreateNoteInput,
  ) {
    const out = await this.notes.create(session.teamId, session.userId, body);
    return { ok: true, noteId: out.noteId };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.notes.remove(session.teamId, id);
    return { ok: true };
  }
}
