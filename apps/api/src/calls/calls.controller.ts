import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { RequireCapability } from "../auth/capability.guard";
import { RequireRole } from "../auth/role.guard";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { RateLimit } from "../common/rate-limit.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { CallsService } from "./calls.service";
import {
  AnswerCallSchema,
  EndCallSchema,
  InitiateCallSchema,
  ListCallsQuerySchema,
  RejectCallSchema,
  RequestCallPermissionSchema,
  type AnswerCallInput,
  type EndCallInput,
  type InitiateCallInput,
  type ListCallsQuery,
  type RejectCallInput,
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

  @Get("api/conversations/:conversationId/calls")
  async list(
    @CurrentSession() session: ApiSession,
    @Param("conversationId") conversationId: string,
    @Query(zQuery(ListCallsQuerySchema)) query: ListCallsQuery,
  ) {
    return this.calls.list(session, conversationId, query.take, query.cursor);
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
  async enableCalling(@CurrentSession() session: ApiSession) {
    return this.calls.enableCallingForTeam(session);
  }

  /**
   * Diagnostic GET: dumps Meta's current phone-number settings so we can
   * see what's actually configured (calling.status, call_icon_visibility,
   * call_hours, etc.). Use when inbound calls aren't reaching the webhook.
   * ADMIN-only — discloses the team's full Meta calling configuration.
   */
  @Get("api/calls/admin/settings")
  @RequireRole("admin")
  async getSettings(@CurrentSession() session: ApiSession) {
    return this.calls.getPhoneNumberSettings(session);
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

  @Post("api/calls/:callId/end")
  @HttpCode(200)
  async end(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(EndCallSchema)) _body: EndCallInput,
  ) {
    return this.calls.endCall(session, callId);
  }

}
