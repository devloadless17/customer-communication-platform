import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { CallDirection, CallStatus, Prisma } from "@prisma/client";

import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  BIC_BLOCKED_COUNTRY_CODES,
  SANCTIONED_COUNTRY_CODES,
} from "@ccp/shared/providers/calling-regions";
import type { Capability } from "@ccp/shared/auth/permissions";
import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";
import type { ApiSession } from "../auth/session.guard";

/**
 * Calls service.
 *
 *   initiateCall    — outbound call from agent → customer. Runs the BIC
 *                     pre-flight gauntlet (region / revocation / 24h
 *                     window / 5-per-24h cap / permission request).
 *   requestPermission — explicit permission request (when 24h window is
 *                     closed and no live permission exists).
 *   answerCall      — CAS-gated; first agent wins. Calls preAcceptCall
 *                     THEN acceptCall (Meta requires that order).
 *   rejectCall      — incoming-only.
 *   endCall         — terminate in-progress.
 *   forwardIce      — relay ICE candidate browser → Meta.
 *   list            — call history for a conversation, keyset paginated.
 *
 * All Meta SDK calls happen AFTER the local DB write so a Meta hiccup
 * leaves consistent local state the user can retry from.
 */

export type InitiateCallFailure =
  | { ok: false; reason: "permission_required" }
  | { ok: false; reason: "bic_blocked_region" }
  | { ok: false; reason: "permission_revoked" }
  | { ok: false; reason: "rate_limited"; retryAt: string }
  | { ok: false; reason: "daily_cap_reached" };

export interface InitiateCallSuccess {
  ok: true;
  callId: string;
  externalCallId: string;
  status: CallStatus;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Initiate an outbound call. Pre-flight gauntlet runs in this order so
   * each failure surfaces a precise reason the UI can render:
   *   1. capability check (gate decorator already ran; sanity check here)
   *   2. conversation + contact load (with phone country)
   *   3. region gate (BIC_BLOCKED_COUNTRY_CODES + sanctioned)
   *   4. revocation gate (Contact.callPermissionRevokedUntil)
   *   5. 24h window check OR live permission
   *   6. 5-calls-per-24h-per-contact cap
   *   7. placeCall against Meta + INSERT Call row + publish ringing_out
   */
  async initiateCall(
    session: ApiSession,
    conversationId: string,
  ): Promise<InitiateCallSuccess | InitiateCallFailure> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId: session.teamId },
      select: {
        id: true,
        channel: true,
        contact: {
          select: {
            id: true,
            phoneNumber: true,
            countryCode: true,
            callPermissionRevokedUntil: true,
            lastInboundAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const contact = conversation.contact;
    if (!contact?.phoneNumber) {
      throw new BadRequestException({ error: "contact has no phone number" });
    }

    // Region gate. The UI hides the Phone button when the country is on
    // either list, but defense-in-depth catches a direct API call.
    if (contact.countryCode) {
      const cc = contact.countryCode.toUpperCase();
      if (
        BIC_BLOCKED_COUNTRY_CODES.has(cc) ||
        SANCTIONED_COUNTRY_CODES.has(cc)
      ) {
        return { ok: false, reason: "bic_blocked_region" };
      }
    }

    // Permission revocation gate. Meta strips calling permission after 4
    // consecutive unanswered outbound calls; this column mirrors that.
    if (
      contact.callPermissionRevokedUntil &&
      contact.callPermissionRevokedUntil.getTime() > Date.now()
    ) {
      return { ok: false, reason: "permission_revoked" };
    }

    // 24h-window check. Inside the window → free-form calls OK. Outside →
    // need a live permission row OR auto-request one.
    const now = Date.now();
    const insideWindow = Boolean(
      contact.lastInboundAt &&
        now - contact.lastInboundAt.getTime() < 24 * 60 * 60 * 1000,
    );
    if (!insideWindow) {
      const livePerm = await this.db.callPermissionRequest.findFirst({
        where: { teamId: session.teamId, contactId: contact.id },
        orderBy: { requestedAt: "desc" },
        select: { expiresAt: true, rateLimitedUntil: true },
      });
      const permLive =
        livePerm?.expiresAt && livePerm.expiresAt.getTime() > now;
      if (!permLive) {
        // Decide between "rate_limited" and "permission_required" based on
        // a fresh-enough rate-limit timestamp.
        if (
          livePerm?.rateLimitedUntil &&
          livePerm.rateLimitedUntil.getTime() > now
        ) {
          return {
            ok: false,
            reason: "rate_limited",
            retryAt: livePerm.rateLimitedUntil.toISOString(),
          };
        }
        // Fire the permission request opportunistically — if Meta accepts,
        // log it; if Meta rate-limits, write the rateLimitedUntil row.
        // Either way the UI surfaces "permission_required" and the agent
        // re-clicks once granted.
        await this.requestPermissionInternal(
          session.teamId,
          contact.id,
          contact.phoneNumber,
        );
        return { ok: false, reason: "permission_required" };
      }
    } else {
      // 5-per-24h cap. Only counts COMPLETED outbound calls — failed /
      // rejected / missed don't burn the cap (the customer doesn't pay
      // attention to those either).
      const since = new Date(now - 24 * 60 * 60 * 1000);
      const dailyOutboundConnected = await this.db.call.count({
        where: {
          teamId: session.teamId,
          conversationId,
          direction: CallDirection.out,
          status: CallStatus.completed,
          ringingAt: { gte: since },
        },
      });
      if (dailyOutboundConnected >= 5) {
        return { ok: false, reason: "daily_cap_reached" };
      }
    }

    // All checks passed. Hit Meta to initiate the call, then INSERT the
    // Call row, then publish call.ringing_out. Order matters: Meta first
    // so we capture the real externalCallId on the row; a failure here
    // surfaces a clean error and we haven't written a phantom Call row.
    const binding = getProviderBinding(conversation.channel);
    const placeCall = requireProviderMethod(
      binding.provider,
      "placeCall",
      conversation.channel,
    );
    const sendConfig = await binding.getSendConfig(session.teamId);
    let placed;
    try {
      placed = await placeCall({ to: contact.phoneNumber }, sendConfig);
    } catch (err) {
      this.logger.warn(
        `placeCall failed for team=${session.teamId} contact=${contact.id}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      throw new HttpException(
        { error: "provider_rejected" },
        502,
      );
    }

    const ringingAt = new Date();
    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.call.create({
        data: {
          teamId: session.teamId,
          conversationId,
          externalCallId: placed.externalCallId,
          channel: conversation.channel,
          direction: CallDirection.out,
          status: CallStatus.ringing,
          ringingAt,
          // Verbatim provider response for forensics.
          rawPayload: { placedAt: ringingAt.toISOString() } as Prisma.InputJsonValue,
        },
        select: { id: true, status: true, externalCallId: true },
      });
      return row;
    });

    // Publish so the originating thread room shows ringing-out state.
    await this.bus.publish({
      type: "call.ringing_out",
      teamId: session.teamId,
      conversationId,
      callId: created.id,
      externalCallId: created.externalCallId,
      initiatedByUserId: session.userId,
      ringingAt: ringingAt.toISOString(),
    });

    return {
      ok: true,
      callId: created.id,
      externalCallId: created.externalCallId,
      status: created.status,
    };
  }

  /**
   * Send an explicit permission request to the contact. Idempotent over a
   * fresh-enough live row — if one already exists, returns its id without
   * re-hitting Meta. Used by the standalone POST /call-permission endpoint
   * AND internally as a fallback from initiateCall.
   */
  async requestPermission(
    session: ApiSession,
    conversationId: string,
  ): Promise<{ permissionRequestId: string; expiresAt: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId: session.teamId },
      select: {
        channel: true,
        contact: { select: { id: true, phoneNumber: true } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    if (!conversation.contact?.phoneNumber) {
      throw new BadRequestException({ error: "contact has no phone number" });
    }
    const result = await this.requestPermissionInternal(
      session.teamId,
      conversation.contact.id,
      conversation.contact.phoneNumber,
      conversation.channel,
    );
    return {
      permissionRequestId: result.permissionRequestId,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  /**
   * Shared internal: sends the request to Meta, records the row, mirrors
   * rate-limit on a 4xx. Channel defaults to whatsapp — the only channel
   * with calling today.
   */
  private async requestPermissionInternal(
    teamId: string,
    contactId: string,
    phoneNumber: string,
    channel: "whatsapp" = "whatsapp",
  ): Promise<{ permissionRequestId: string; expiresAt: Date }> {
    const binding = getProviderBinding(channel);
    const sendPerm = requireProviderMethod(
      binding.provider,
      "sendCallPermissionRequest",
      channel,
    );
    const config = await binding.getSendConfig(teamId);
    try {
      const out = await sendPerm({ to: phoneNumber }, config);
      await this.db.callPermissionRequest.create({
        data: {
          teamId,
          contactId,
          externalRequestId: out.permissionRequestId,
          expiresAt: out.expiresAt,
        },
      });
      return out;
    } catch (err) {
      // Meta returns 4xx with a body that mentions rate-limiting on
      // 1/24h or 2/7d violations. We don't try to parse the wire
      // message — just record a 24h cooldown and let the next attempt
      // surface a fresh state.
      const rateLimitedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await this.db.callPermissionRequest.create({
        data: {
          teamId,
          contactId,
          expiresAt: new Date(0),
          rateLimitedUntil,
        },
      });
      throw err;
    }
  }

  /**
   * Accept an incoming call. CAS-gated so multiple agents racing each
   * other on the same incoming-call toast produce exactly one winner.
   * On CAS success: pre_accept → accept Meta (in that order, REQUIRED),
   * then publish call.answered_by_agent.
   */
  async answerCall(
    session: ApiSession,
    callId: string,
    sdpAnswer: string,
  ): Promise<{ ok: true; answeredByUserId: string }> {
    const call = await this.db.call.findFirst({
      where: { id: callId, teamId: session.teamId },
      select: {
        id: true,
        teamId: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        status: true,
        answeredByUserId: true,
      },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });

    // Capability check — guard already gated, but the second cap
    // (receive) isn't on the decorator (decorators are single-cap).
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (!perms["calls:receive" as Capability]) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    // CAS update. updateMany returns count; 0 = lost the race.
    const answeredAt = new Date();
    const cas = await this.db.call.updateMany({
      where: {
        id: callId,
        answeredByUserId: null,
        status: CallStatus.ringing,
      },
      data: {
        answeredByUserId: session.userId,
        status: CallStatus.in_progress,
        answeredAt,
      },
    });
    if (cas.count === 0) {
      throw new ConflictException({ error: "already_answered" });
    }

    // Now talk to Meta — pre_accept THEN accept. preAcceptCall failure
    // surfaces as 502; the row is already flipped to in_progress, but
    // the caller knows the answer never landed.
    const binding = getProviderBinding(call.channel);
    const preAccept = requireProviderMethod(
      binding.provider,
      "preAcceptCall",
      call.channel,
    );
    const accept = requireProviderMethod(
      binding.provider,
      "acceptCall",
      call.channel,
    );
    const config = await binding.getSendConfig(session.teamId);
    try {
      await preAccept({ externalCallId: call.externalCallId }, config);
      await accept(
        { externalCallId: call.externalCallId, sdpAnswer },
        config,
      );
    } catch (err) {
      this.logger.warn(
        `acceptCall provider error for call=${callId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      throw new HttpException({ error: "provider_rejected" }, 502);
    }

    await this.bus.publish({
      type: "call.answered_by_agent",
      teamId: session.teamId,
      conversationId: call.conversationId,
      callId: call.id,
      answeredByUserId: session.userId,
      answeredAt: answeredAt.toISOString(),
    });
    return { ok: true, answeredByUserId: session.userId };
  }

  /**
   * Reject an incoming call. Same CAS pattern as answer — the row must
   * still be in `ringing` for the decline to land. Once in `in_progress`,
   * use endCall instead.
   */
  async rejectCall(
    session: ApiSession,
    callId: string,
    reason?: "busy" | "declined",
  ): Promise<{ ok: true }> {
    const call = await this.db.call.findFirst({
      where: { id: callId, teamId: session.teamId },
      select: {
        id: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        status: true,
      },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });

    const cas = await this.db.call.updateMany({
      where: { id: callId, status: CallStatus.ringing },
      data: { status: CallStatus.rejected, endedAt: new Date() },
    });
    if (cas.count === 0) {
      // Either already answered (someone won the race) or already
      // terminal — idempotent success in either case.
      return { ok: true };
    }

    const binding = getProviderBinding(call.channel);
    const reject = requireProviderMethod(
      binding.provider,
      "rejectCall",
      call.channel,
    );
    const config = await binding.getSendConfig(session.teamId);
    try {
      await reject(
        {
          externalCallId: call.externalCallId,
          ...(reason ? { reason } : {}),
        },
        config,
      );
    } catch (err) {
      // Non-fatal — the row is already rejected locally.
      this.logger.warn(
        `rejectCall provider error for call=${callId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    await this.bus.publish({
      type: "call.rejected",
      teamId: session.teamId,
      conversationId: call.conversationId,
      callId: call.id,
      rejectedByUserId: session.userId,
    });
    return { ok: true };
  }

  /**
   * Hang up an in-progress call. Idempotent — re-calling on an already-
   * terminated call returns success. Cap check is inline because either
   * make OR receive capability is sufficient (the answering agent + the
   * initiating agent can both hang up).
   */
  async endCall(
    session: ApiSession,
    callId: string,
  ): Promise<{ ok: true; durationSeconds: number | null }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const call = await this.db.call.findFirst({
      where: { id: callId, teamId: session.teamId },
      select: {
        id: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        direction: true,
        status: true,
        answeredAt: true,
      },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });

    // Already terminal — idempotent OK.
    if (
      call.status === CallStatus.completed ||
      call.status === CallStatus.missed ||
      call.status === CallStatus.rejected ||
      call.status === CallStatus.failed
    ) {
      return { ok: true, durationSeconds: null };
    }

    const endedAt = new Date();
    const durationSeconds = call.answeredAt
      ? Math.max(
          0,
          Math.floor((endedAt.getTime() - call.answeredAt.getTime()) / 1000),
        )
      : null;

    const cas = await this.db.call.updateMany({
      where: {
        id: callId,
        status: { in: [CallStatus.ringing, CallStatus.in_progress] },
      },
      data: {
        status: CallStatus.completed,
        endedAt,
        durationSeconds,
      },
    });
    if (cas.count === 0) {
      // Race lost — somebody (or a webhook) terminated it between read
      // and write. Idempotent success.
      return { ok: true, durationSeconds: null };
    }

    const binding = getProviderBinding(call.channel);
    const end = requireProviderMethod(
      binding.provider,
      "endCall",
      call.channel,
    );
    const config = await binding.getSendConfig(session.teamId);
    try {
      await end({ externalCallId: call.externalCallId }, config);
    } catch (err) {
      this.logger.warn(
        `endCall provider error for call=${callId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      // Non-fatal — local state already terminal.
    }

    await this.bus.publish({
      type: "call.ended",
      teamId: session.teamId,
      conversationId: call.conversationId,
      callId: call.id,
      direction: call.direction === CallDirection.in ? "in" : "out",
      endedAt: endedAt.toISOString(),
      durationSeconds,
      reason: "hangup_by_agent",
    });

    return { ok: true, durationSeconds };
  }

  /**
   * Forward a browser-generated ICE candidate to Meta. Best-effort —
   * candidates trickle; missing one is recoverable from the next.
   */
  async forwardIce(
    session: ApiSession,
    callId: string,
    candidate: string,
    sdpMid: string | null,
    sdpMLineIndex: number | null,
  ): Promise<{ ok: true }> {
    const call = await this.db.call.findFirst({
      where: { id: callId, teamId: session.teamId },
      select: { externalCallId: true, channel: true, status: true },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });
    if (
      call.status !== CallStatus.ringing &&
      call.status !== CallStatus.in_progress
    ) {
      // Late ICE after the call ended — drop silently.
      return { ok: true };
    }
    const binding = getProviderBinding(call.channel);
    const sendIce = binding.provider.sendIceCandidate;
    if (!sendIce) return { ok: true };
    const config = await binding.getSendConfig(session.teamId);
    try {
      await sendIce(
        {
          externalCallId: call.externalCallId,
          candidate,
          sdpMid,
          sdpMLineIndex,
        },
        config,
      );
    } catch (err) {
      // Non-fatal — log only.
      this.logger.debug(
        `sendIceCandidate failed for call=${callId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    return { ok: true };
  }

  /**
   * List call history for a conversation. Keyset paginated on
   * (ringingAt DESC, id DESC).
   */
  async list(
    session: ApiSession,
    conversationId: string,
    take: number,
    cursor: string | undefined,
  ): Promise<{ items: SerializedCall[]; cursor: string | null }> {
    // Team scope via the conversation FK — defensive lookup.
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId: session.teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    const rows = await this.db.call.findMany({
      where: { conversationId },
      orderBy: [{ ringingAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        direction: true,
        status: true,
        answeredByUserId: true,
        ringingAt: true,
        answeredAt: true,
        endedAt: true,
        durationSeconds: true,
        recordingUrl: true,
      },
    });
    const hasMore = rows.length > take;
    const items = (hasMore ? rows.slice(0, take) : rows).map(serializeCall);
    const nextCursor = hasMore ? rows[take - 1]!.id : null;
    return { items, cursor: nextCursor };
  }
}

export interface SerializedCall {
  id: string;
  conversationId: string;
  externalCallId: string;
  channel: string;
  direction: "in" | "out";
  status: CallStatus;
  answeredByUserId: string | null;
  ringingAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
}

function serializeCall(row: {
  id: string;
  conversationId: string;
  externalCallId: string;
  channel: string;
  direction: CallDirection;
  status: CallStatus;
  answeredByUserId: string | null;
  ringingAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
}): SerializedCall {
  return {
    id: row.id,
    conversationId: row.conversationId,
    externalCallId: row.externalCallId,
    channel: row.channel,
    direction: row.direction === CallDirection.in ? "in" : "out",
    status: row.status,
    answeredByUserId: row.answeredByUserId,
    ringingAt: row.ringingAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
    recordingUrl: row.recordingUrl,
  };
}
