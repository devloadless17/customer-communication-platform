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
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { CallsService } from "./calls.service";
import {
  AnswerCallSchema,
  EndCallSchema,
  IceCandidateSchema,
  InitiateCallSchema,
  ListCallsQuerySchema,
  RejectCallSchema,
  RequestCallPermissionSchema,
  type AnswerCallInput,
  type EndCallInput,
  type IceCandidateInput,
  type InitiateCallInput,
  type ListCallsQuery,
  type RejectCallInput,
  type RequestCallPermissionInput,
} from "./calls.schemas";

/**
 * Calls API.
 *
 * Two URL spaces to keep paths intuitive:
 *
 *   /api/conversations/:id/call             — initiate outbound from a thread
 *   /api/conversations/:id/call-permission  — request permission
 *   /api/conversations/:id/calls            — list history
 *   /api/calls/:id/answer                   — accept incoming
 *   /api/calls/:id/reject                   — decline incoming
 *   /api/calls/:id/end                      — terminate in-progress
 *   /api/calls/:id/ice                      — relay browser ICE candidate
 *
 * Capability gates:
 *   - calls:make on initiate / permission / end
 *   - calls:receive on answer / reject / end
 *
 * /end accepts either capability; the service does the actual inline check.
 */
@Controller()
@UseGuards(SessionGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  // --- Conversation-scoped ---------------------------------------------------

  @Post("api/conversations/:conversationId/call")
  @RequireCapability("calls:make")
  async initiate(
    @CurrentSession() session: ApiSession,
    @Param("conversationId") conversationId: string,
    @Body(zBody(InitiateCallSchema)) _body: InitiateCallInput,
  ) {
    return this.calls.initiateCall(session, conversationId);
  }

  @Post("api/conversations/:conversationId/call-permission")
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

  @Post("api/calls/:callId/ice")
  @HttpCode(200)
  async ice(
    @CurrentSession() session: ApiSession,
    @Param("callId") callId: string,
    @Body(zBody(IceCandidateSchema)) body: IceCandidateInput,
  ) {
    return this.calls.forwardIce(
      session,
      callId,
      body.candidate,
      body.sdpMid,
      body.sdpMLineIndex,
    );
  }
}
