import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import type { Channel } from "@ccp/shared/types";
import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import { RequireCapability } from "../auth/capability.guard";
import { RequireRole } from "../auth/role.guard";
import { ScopedByConversation } from "../auth/conversation-visibility.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { RateLimit } from "../common/rate-limit.interceptor";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { CallsService } from "./calls.service";
import {
  AnswerCallSchema,
  EndCallSchema,
  InitiateCallSchema,
  ListCallsQuerySchema,
  ListTeamCallsQuerySchema,
  MediaUpdateSchema,
  RejectCallSchema,
  UpdateCallSettingsSchema,
  RequestCallPermissionSchema,
  type AnswerCallInput,
  type EndCallInput,
  type InitiateCallInput,
  type ListCallsQuery,
  type ListTeamCallsQuery,
  type MediaUpdateInput,
  type RejectCallInput,
  type UpdateCallSettingsInput,
  type RequestCallPermissionInput,
} from "./calls.schemas";

/**
 * Calls API.
 *
 *   /api/conversations/:id/call             — initiate outbound from a thread
 *   /api/conversations/:id/call-permission  — request calling permission
 *   /api/conversations/:id/calls            — list history
 *   /api/calls/:id/answer                   — accept incoming
 *   /api/calls/:id/reject                   — decline incoming
 *   /api/calls/:id/end                      — terminate in-progress
 *   /api/calls/admin/enable                 — one-time Meta calling enablement
 *   /api/calls/admin/settings               — read Meta's calling config
 *
 * Capability gates: `calls:make` on initiate/permission; `calls:receive` on
 * answer/reject; `calls:make || calls:receive` on list (inline check) and end
 * (inline check). The two `/admin/*` endpoints are ADMIN-only (`@RequireRole`)
 * — they mutate/disclose the team's Meta phone-number calling config, a
 * team-administration operation structurally identical to the WhatsApp settings
 * controller, NOT a per-agent "allowed to dial" action. `calls:make` defaults
 * true for agents, so gating the admin routes on it let any agent reconfigure
 * the number — fixed to @RequireRole("admin").
 *
 * Rate limit: class-level 60/min mirroring MessagesController — every initiate/
 * permission handler hits Meta's Cloud API synchronously and counts against the
 * number's quality rating (Meta caps calling tightly; a retry storm at the
 * 300/min global default could get the number flagged/throttled).
 *
 * NOTE: there's no `/ice` endpoint — Meta uses ICE-LITE (all candidates
 * baked into the SDP) so client-side trickle isn't possible.
 */
@Controller()
@UseGuards(SessionGuard)
@RateLimit({ perMinute: 60 })
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  // --- Conversation-scoped ---------------------------------------------------

  @ScopedByConversation("conversationId")
  // Placing a call / requesting permission WRITES to a customer on this
  // thread, so it needs the visibility boundary as much as reading does.
  // Applied per-route because this controller also serves `api/calls/:callId/*`.
  @Post("api/conversations/:conversationId/call")
  @HttpCode(200)
  @RequireCapability("calls:make")
  async initiate(
    @CurrentSession() session: ApiSession,
    @Param("conversationId") conversationId: string,
    @Body(zBody(InitiateCallSchema)) body: InitiateCallInput,
  ) {
    return this.calls.initiateCall(session, conversationId, body.sdp);
  }

  @ScopedByConversation("conversationId")
  @Post("api/conversations/:conversationId/call-permission")
  @HttpCode(200)
  @RequireCapability("calls:make")
  async permission(
    @CurrentSession() session: ApiSession,
    @Param("conversationId") conversationId: string,
    @Body(zBody(RequestCallPermissionSchema)) _body: RequestCallPermissionInput,
  ) {
    return this.calls.requestPermission(session, conversationId);
  }

  @ScopedByConversation("conversationId")
  @Get("api/conversations/:conversationId/calls")
  async list(
    @CurrentSession() session: ApiSession,
    @Param("conversationId") conversationId: string,
    @Query(zQuery(ListCallsQuerySchema)) query: ListCallsQuery,
  ) {
    return this.calls.list(session, conversationId, query.take, query.cursor);
  }

  /**
   * TEAM-WIDE call history for the Calls page (every call across all
   * conversations, newest-first). Capability-gated in the service
   * (calls:make OR calls:receive), same keyset cursor as the per-conversation
   * list. No `:id` collision — this is a fixed sub-path of /api/calls.
   */
  @Get("api/calls")
  async listTeam(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListTeamCallsQuerySchema)) query: ListTeamCallsQuery,
  ) {
    return this.calls.listTeamCalls(session, query.take, query.cursor, {
      q: query.q,
      from: query.from,
      to: query.to,
      page: query.page,
    });
  }

  /**
   * Live-calls count for the inbox "Calls" badge — how many calls are ringing
   * or in progress team-wide right now. Fixed sub-path of /api/calls (declared
   * before the `:callId` routes so it isn't matched as an id).
   */
  @Get("api/calls/live-count")
  async liveCount(@CurrentSession() session: ApiSession) {
    return this.calls.liveCount(session);
  }

  // --- Admin -----------------------------------------------------------------

  /**
   * One-time setup endpoint: enables Cloud API Calling on this team's
   * phone number via Meta's settings API. Required before placeCall
   * works (Meta error 138000 otherwise). Idempotent. ADMIN-only: this
   * OVERWRITES the team's Meta calling config (status, call_icon_visibility,
   * call_hours → 24/7), a team-administration mutation — not something a
   * per-agent `calls:make` (default-true) should authorize.
   */
  @Post("api/calls/admin/enable")
  @HttpCode(200)
  @RequireRole("admin")
  async enableCalling(
    @CurrentSession() session: ApiSession,
    @Query("channel") channel?: string,
  ) {
    return this.calls.enableCallingForTeam(session, this.channelOf(channel));
  }

  /**
   * Diagnostic GET: dumps Meta's current phone-number settings so we can
   * see what's actually configured (calling.status, call_icon_visibility,
   * call_hours, etc.). Use when inbound calls aren't reaching the webhook.
   * ADMIN-only — discloses the team's full Meta calling configuration.
   */
  @Get("api/calls/admin/settings")
  @RequireRole("admin")
  async getSettings(
    @CurrentSession() session: ApiSession,
    @Query("channel") channel?: string,
  ) {
    return this.calls.getPhoneNumberSettings(session, this.channelOf(channel));
  }

  /**
   * The calling setup checklist + current configuration, for the Settings
   * screen. ADMIN-only — it discloses the team's full calling configuration.
   */
  @Get("api/calls/admin/readiness")
  @RequireRole("admin")
  async readiness(
    @CurrentSession() session: ApiSession,
    @Query("channel") channel?: string,
  ) {
    return this.calls.getCallingReadiness(session, this.channelOf(channel));
  }

  /**
   * Change calling configuration (enable/disable, call icon, callback
   * permission, business hours). A PATCH — only the supplied fields are
   * written, so toggling one setting can't reset another. ADMIN-only.
   */
  @Patch("api/calls/admin/settings")
  @HttpCode(200)
  @RequireRole("admin")
  async updateSettings(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateCallSettingsSchema)) body: UpdateCallSettingsInput,
    @Query("channel") channel?: string,
  ) {
    const { channel: _ignored, ...settings } = body;
    return this.calls.updateCallSettings(
      session,
      settings,
      this.channelOf(channel),
    );
  }

  /**
   * Validate a `?channel=` query param instead of silently coercing anything
   * unrecognized to WhatsApp — a typo would otherwise configure the wrong
   * channel. Defaults to WhatsApp when absent.
   */
  private channelOf(raw: string | undefined): Channel {
    const value = raw ?? "whatsapp";
    if (!LIVE_CHANNELS.has(value as Channel)) {
      throw new BadRequestException({
        error: "invalid_channel",
        detail: `Unknown or unsupported channel: ${value}`,
      });
    }
    return value as Channel;
  }

  // --- Call-scoped -----------------------------------------------------------

  @Post("api/calls/:callId/answer")
  @HttpCode(200)
  @RequireCapability("calls:receive")
  async answer(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(AnswerCallSchema)) body: AnswerCallInput,
  ) {
    return this.calls.answerCall(session, callId, body.sdp);
  }

  @Post("api/calls/:callId/reject")
  @HttpCode(200)
  @RequireCapability("calls:receive")
  async reject(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(RejectCallSchema)) body: RejectCallInput,
  ) {
    return this.calls.rejectCall(session, callId, body.reason);
  }

  /**
   * Complete the accept of an INBOUND call. The answering agent's browser calls
   * this the moment its peer connection reaches `connected`, and holds its
   * audio until this returns — the provider requires the accept to land after
   * the WebRTC connection is up, and media flowing before it costs the caller
   * the first words of the call.
   *
   * (There is no outbound equivalent. Customer pickup is reported by the
   * provider's own call-status webhook, not guessed at by the browser.)
   */
  @Post("api/calls/:callId/accept-media")
  @HttpCode(200)
  @RequireCapability("calls:receive")
  async acceptMedia(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(AnswerCallSchema)) body: AnswerCallInput,
  ) {
    return this.calls.completeAccept(session, callId, body.sdp);
  }

  @Post("api/calls/:callId/end")
  @HttpCode(200)
  async end(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(EndCallSchema)) _body: EndCallInput,
  ) {
    return this.calls.endCall(session, callId);
  }

  /**
   * Mid-call media renegotiation (Messenger). Meta sends a post-pickup
   * `media_update` webhook carrying a new SDP offer; the agent's browser answers
   * it and POSTs that answer here to relay to Meta. No capability decorator (an
   * agent already on the live call must be able to keep its media alive — same
   * posture as /end); the service scopes by teamId + `in_progress`.
   */
  @Post("api/calls/:callId/media-update")
  @HttpCode(200)
  async mediaUpdate(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(MediaUpdateSchema)) body: MediaUpdateInput,
  ) {
    return this.calls.mediaUpdate(session, callId, body.sdp);
  }

}
