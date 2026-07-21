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

  @Get("conversations/:id/overview")
  async overview(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.svc.overview(session.teamId, id);
  }

  /** On-demand summary for an agent-picked `from`/`to` date range. */
  @Get("conversations/:id/summary")
  async rangeSummary(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(SummaryRangeQuerySchema)) query: SummaryRangeQuery,
  ) {
    return this.svc.rangeSummary(session.teamId, id, new Date(query.from), new Date(query.to));
  }

  @Post("conversations/:id/state")
  async setState(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(StateActionSchema)) body: StateActionInput,
  ) {
    const state = await this.svc.setState(session.teamId, id, session.userId, body.action);
    return { state };
  }

  @Post("suggestions/:id/decision")
  async decideSuggestion(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SuggestionDecisionSchema)) body: SuggestionDecisionInput,
  ) {
    const suggestion = await this.svc.decideSuggestion(
      session.teamId,
      session.userId,
      id,
      body.action,
      body.editedText,
      body.sendAs,
    );
    return { suggestion };
  }

  @Get("suggestions/:id/audio")
  async suggestionAudio(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const obj = await this.svc.getSuggestionAudio(session.teamId, id);
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
    const suggestion = await this.svc.regenerateSuggestion(session.teamId, session.userId, id);
    return { suggestion };
  }

  @Get("customers/:id/memory")
  async listMemory(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    const memory = await this.svc.listMemory(session.teamId, id);
    return { memory };
  }

  @Patch("memory/:id")
  async patchMemory(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PatchMemorySchema)) body: PatchMemoryInput,
  ) {
    const memory = await this.svc.patchMemory(session.teamId, session.userId, id, body);
    return { memory };
  }

  @Delete("memory/:id")
  async deleteMemory(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.svc.deleteMemory(session.teamId, id);
  }

  @Get("transcriptions/:messageId")
  async getTranscription(@CurrentSession() session: ApiSession, @Param("messageId") messageId: string) {
    const transcription = await this.svc.getTranscription(session.teamId, messageId);
    return { transcription };
  }

  @Patch("transcriptions/:messageId")
  async correctTranscription(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Body(zBody(CorrectTranscriptionSchema)) body: CorrectTranscriptionInput,
  ) {
    const transcription = await this.svc.correctTranscription(
      session.teamId,
      session.userId,
      messageId,
      body.correctedText,
    );
    return { transcription };
  }
}
