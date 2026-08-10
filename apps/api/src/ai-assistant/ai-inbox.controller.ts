import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { ScopedByConversation } from "../auth/conversation-visibility.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { AiInboxService } from "./ai-inbox.service";
import {
  CorrectTranscriptionSchema,
  PatchMemorySchema,
  StateActionSchema,
  SuggestionDecisionSchema,
  SummaryRangeQuerySchema,
  type CorrectTranscriptionInput,
  type PatchMemoryInput,
  type StateActionInput,
  type SuggestionDecisionInput,
  type SummaryRangeQuery,
} from "./ai-inbox.schemas";

/**
 * Inbox-facing AI operations. Agent-level (SessionGuard only) — any team member
 * operating a conversation can pause/resume the AI, act on a draft, curate
 * customer memory, and correct a transcript. Settings/config live elsewhere
 * (team/ai-assistant, gated by aiAssistant:manage).
 */
@Controller("api/ai-assistant")
@UseGuards(SessionGuard)
export class AiInboxController {
  constructor(private readonly svc: AiInboxService) {}

  // `:id` here is a CONVERSATION id — scoped. (Deliberately NOT class-level:
  // the suggestion / customer / transcription routes below also use `:id`, and
  // a blanket guard would look those ids up as conversations and 404 them.)
  @ScopedByConversation("id")
  @Get("conversations/:id/overview")
  async overview(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.svc.overview(session.workspaceId, id);
  }

  /** On-demand summary for an agent-picked `from`/`to` date range. */
  // Conversation-scoped: this returns a summary of the thread's contents, so
  // it needs the same visibility boundary as the thread itself.
  @ScopedByConversation("id")
  @Get("conversations/:id/summary")
  async rangeSummary(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(SummaryRangeQuerySchema)) query: SummaryRangeQuery,
  ) {
    return this.svc.rangeSummary(session.workspaceId, id, new Date(query.from), new Date(query.to));
  }

  @ScopedByConversation("id")
  @Post("conversations/:id/state")
  async setState(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(StateActionSchema)) body: StateActionInput,
  ) {
    const state = await this.svc.setState(session.workspaceId, id, session.userId, body.action);
    return { state };
  }

  @Post("suggestions/:id/decision")
  async decideSuggestion(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SuggestionDecisionSchema)) body: SuggestionDecisionInput,
  ) {
    const suggestion = await this.svc.decideSuggestion(
      session.workspaceId,
      session.userId,
      id,
      body.action,
      body.editedText,
      body.sendAs,
      session,
    );
    return { suggestion };
  }

  @Get("suggestions/:id/audio")
  async suggestionAudio(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const obj = await this.svc.getSuggestionAudio(session.workspaceId, id, session);
    if (!obj) {
      res.status(404).json({ error: "no_audio" });
      return;
    }
    res.setHeader("Content-Type", obj.contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    obj.body.pipe(res);
  }

  @Post("suggestions/:id/regenerate")
  async regenerateSuggestion(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    const suggestion = await this.svc.regenerateSuggestion(session.workspaceId, session.userId, id, session);
    return { suggestion };
  }

  @Get("customers/:id/memory")
  async listMemory(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    const memory = await this.svc.listMemory(session.workspaceId, id, session);
    return { memory };
  }

  @Patch("memory/:id")
  async patchMemory(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PatchMemorySchema)) body: PatchMemoryInput,
  ) {
    const memory = await this.svc.patchMemory(session.workspaceId, session.userId, id, body, session);
    return { memory };
  }

  @Delete("memory/:id")
  async deleteMemory(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.svc.deleteMemory(session.workspaceId, id, session);
  }

  /** Whether a given (AI-authored) message was flagged as a hallucination risk. */
  @Get("messages/:messageId/hallucination")
  async messageFlag(@CurrentSession() session: ApiSession, @Param("messageId") messageId: string) {
    return this.svc.getMessageFlag(session.workspaceId, messageId, session);
  }

  @Get("transcriptions/:messageId")
  async getTranscription(@CurrentSession() session: ApiSession, @Param("messageId") messageId: string) {
    const transcription = await this.svc.getTranscription(session.workspaceId, messageId, session);
    return { transcription };
  }

  @Patch("transcriptions/:messageId")
  async correctTranscription(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Body(zBody(CorrectTranscriptionSchema)) body: CorrectTranscriptionInput,
  ) {
    const transcription = await this.svc.correctTranscription(
      session.workspaceId,
      session.userId,
      messageId,
      body.correctedText,
      // Pass the viewer — the sibling read `getTranscription` does. Without it
      // `assertMessageVisible` returns true for `viewer === undefined`, so a
      // restricted agent could read + overwrite a colleague's voice transcript.
      session,
    );
    return { transcription };
  }
}
