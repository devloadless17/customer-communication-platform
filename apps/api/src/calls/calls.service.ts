import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import {
  CallDirection,
  CallPermissionStatus,
  CallStatus,
  Prisma,
} from "@prisma/client";

import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import { normalizeMetaSendError } from "@/lib/providers/meta";
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
 *   list            — call history for a conversation, keyset paginated.
 *
 * All Meta SDK calls happen AFTER the local DB write so a Meta hiccup
 * leaves consistent local state the user can retry from.
 */

export type InitiateCallFailure =
  | { ok: false; reason: "permission_required" }
  | { ok: false; reason: "permission_pending" }
  | { ok: false; reason: "bic_blocked_region" }
  | { ok: false; reason: "permission_revoked" }
  | { ok: false; reason: "rate_limited"; retryAt: string }
  | { ok: false; reason: "daily_cap_reached" }
  | { ok: false; reason: "provider_not_configured" }
  | { ok: false; reason: "provider_rejected" };

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
    sdpOffer: string,
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

    // Testing escape hatch: skip our permission / 24h-window / daily-cap
    // pre-flight so QA can place repeat calls without tripping Meta's permission
    // dance or our own 5/24h cap. Gated to non-production AND an explicit flag,
    // so it can never silently weaken prod. NOTE: Meta still enforces its OWN
    // window / permission rules at placeCall — this only removes OUR friction,
    // so an out-of-window customer with no granted permission will still get a
    // provider_rejected from Meta. Region/sanctions gate above is NEVER skipped.
    const skipPreflight =
      process.env.NODE_ENV !== "production" &&
      process.env.CALLS_SKIP_PREFLIGHT === "1";
    if (skipPreflight) {
      this.logger.warn(
        `CALLS_SKIP_PREFLIGHT active — bypassing permission/window/cap for team=${session.teamId} contact=${contact.id}`,
      );
    }

    // Permission revocation gate. Meta strips calling permission after 4
    // consecutive unanswered outbound calls; this column mirrors that.
    if (
      !skipPreflight &&
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
    if (!skipPreflight && !insideWindow) {
      // A call is only permitted out-of-window against a GRANTED permission
      // still inside its 72h validity. Sending a request is NOT a grant — the
      // permission_granted webhook stamps `granted` + `grantedAt`. expiresAt
      // alone (set +72h at REQUEST time) used to gate this, which made a merely-
      // sent request a 72h green light and produced opaque provider_rejected
      // errors for ungranted/denied contacts.
      const grantedPerm = await this.db.callPermissionRequest.findFirst({
        where: {
          teamId: session.teamId,
          contactId: contact.id,
          status: CallPermissionStatus.granted,
          expiresAt: { gt: new Date(now) },
        },
        orderBy: { requestedAt: "desc" },
        select: { id: true },
      });
      if (!grantedPerm) {
        // No live grant. Look at the newest request row to decide the precise
        // not-yet-callable reason the UI should render.
        const latest = await this.db.callPermissionRequest.findFirst({
          where: { teamId: session.teamId, contactId: contact.id },
          orderBy: { requestedAt: "desc" },
          select: {
            status: true,
            expiresAt: true,
            rateLimitedUntil: true,
          },
        });
        // Meta rate-limited a recent request (1/24h or 2/7d) — surface the
        // retry time. This is now ONLY set on a genuine Meta rate-limit
        // (see requestPermissionInternal), never on a transient failure.
        if (
          latest?.rateLimitedUntil &&
          latest.rateLimitedUntil.getTime() > now
        ) {
          return {
            ok: false,
            reason: "rate_limited",
            retryAt: latest.rateLimitedUntil.toISOString(),
          };
        }
        // A request is already out and still within its 72h window, but the
        // customer hasn't accepted it (status still `pending`, and it's not a
        // rate-limit placeholder). Don't re-fire — Meta caps requests at 1/24h
        // and a second send would just burn the quota. Tell the agent we're
        // waiting on the customer.
        if (
          latest?.status === CallPermissionStatus.pending &&
          !latest.rateLimitedUntil &&
          latest.expiresAt.getTime() > now
        ) {
          return { ok: false, reason: "permission_pending" };
        }
        // Nothing live on file (never requested, or the prior request expired /
        // was denied). Fire a fresh permission request opportunistically and
        // tell the agent to retry once the customer accepts. Swallow the throw:
        // the permission row is the source of truth for the next click; a
        // transient failure no longer writes a cooldown (it rethrows), so the
        // agent can simply retry — a 5xx-bubble here would 502 the inbox button.
        try {
          await this.requestPermissionInternal(
            session.teamId,
            contact.id,
            contact.phoneNumber,
          );
        } catch (err) {
          this.logger.warn(
            `sendCallPermissionRequest failed for team=${session.teamId} contact=${contact.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
        return { ok: false, reason: "permission_required" };
      }
    }

    // 5-per-24h connected-call cap. Runs on BOTH paths — in-window AND
    // permission-authorized. Meta's per-contact business-initiated call cap is
    // independent of WHY the call is allowed (the 24h service window vs. an
    // explicit permission grant), so it must gate both. Previously this lived
    // inside the in-window `else` branch only, which made a granted permission
    // an effectively unlimited-calls pass for its 72h validity — the exact
    // quality-rating risk the cap exists to prevent. Counts ONLY calls the
    // customer actually picked up (answeredAt non-null) — Meta's rule is about
    // CONNECTED calls; a failed handshake torn down with answeredAt=null
    // shouldn't burn the cap.
    const since = new Date(now - 24 * 60 * 60 * 1000);
    const dailyOutboundConnected = await this.db.call.count({
      where: {
        teamId: session.teamId,
        conversationId,
        direction: CallDirection.out,
        answeredAt: { not: null },
        ringingAt: { gte: since },
      },
    });
    if (!skipPreflight && dailyOutboundConnected >= 5) {
      return { ok: false, reason: "daily_cap_reached" };
    }

    // All checks passed. Hit Meta to initiate the call, then INSERT the
    // Call row, then publish call.ringing_out. Order matters: Meta first
    // so we capture the real externalCallId on the row; a failure here
    // surfaces a clean error and we haven't written a phantom Call row.
    //
    // EVERYTHING below the gauntlet returns a structured `{ ok: false, reason }`
    // on failure — no 5xx ever bubbles to the inbox. The failure mappings:
    //   - Channel missing / no provider / provider lacks placeCall → caught and
    //     mapped to `provider_rejected` (the catch's default branch — these
    //     don't match the credential/config regex)
    //   - Team has no Meta credentials → `provider_not_configured`
    //   - Meta API call itself throws (network / 4xx / 5xx) → `provider_rejected`
    //   - The local Call-row INSERT fails (non-P2002) AFTER placeCall succeeded
    //     → terminate the orphaned Meta call + `provider_rejected` (see below)
    // The UI maps every reason to a human one-liner; the alternative (502 → "Bad
    // Gateway" in console) is the failure mode we just hit in prod.
    const channelForCall = conversation.channel ?? "whatsapp";
    let placed: { externalCallId: string };
    try {
      const binding = getProviderBinding(channelForCall);
      const placeCall = requireProviderMethod(
        binding.provider,
        "placeCall",
        channelForCall,
      );
      const sendConfig = await binding.getSendConfig(session.teamId);
      placed = await placeCall(
        { to: contact.phoneNumber, sdpOffer },
        sendConfig,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `placeCall failed for team=${session.teamId} contact=${contact.id}: ${message}`,
      );
      // Differentiate config errors from provider-side rejections so the UI
      // can render the right copy. Both come back as 4xx, never 5xx.
      const reason: "provider_not_configured" | "provider_rejected" =
        /credentials|config|channel.connection|not.configured/i.test(message)
          ? "provider_not_configured"
          : "provider_rejected";
      return { ok: false, reason } as InitiateCallFailure;
    }

    const ringingAt = new Date();
    let created: { id: string; status: CallStatus; externalCallId: string };
    let createdHere = true;
    try {
      created = await this.db.$transaction(async (tx) => {
        return tx.call.create({
          data: {
            teamId: session.teamId,
            conversationId,
            externalCallId: placed.externalCallId,
            channel: conversation.channel,
            direction: CallDirection.out,
            status: CallStatus.ringing,
            ringingAt,
            // The agent placing the call — surfaces "who called" in the thread.
            initiatedByUserId: session.userId,
            // Verbatim provider response for forensics.
            rawPayload: { placedAt: ringingAt.toISOString() } as Prisma.InputJsonValue,
          },
          select: { id: true, status: true, externalCallId: true },
        });
      });
    } catch (err) {
      // P2002: Meta's first webhook for this call (ringing_out for the same
      // externalCallId) raced us and ingestCallEvent inserted the row first.
      // That's benign — the call IS placed and ringing. Re-read the existing
      // row and return success from it instead of letting the @@unique
      // violation surface (the global filter would map it to a 409, which the
      // FE treats as failure → tears down a live call → the agent re-clicks →
      // a SECOND real call). Honors the method's "no error ever bubbles" invariant.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existing = await this.db.call.findUnique({
          where: {
            teamId_channel_externalCallId: {
              teamId: session.teamId,
              channel: conversation.channel,
              externalCallId: placed.externalCallId,
            },
          },
          select: { id: true, status: true, externalCallId: true },
        });
        if (!existing) throw err; // shouldn't happen — re-throw if the row vanished
        created = existing;
        createdHere = false;
        // The webhook beat us to the insert, so its row has no initiator (the
        // webhook has no user context). Backfill it so "who called" still shows.
        // Best-effort + last-writer-wins is fine — only this agent placed it.
        void this.db.call
          .update({
            where: { id: existing.id },
            data: { initiatedByUserId: session.userId },
          })
          .catch(() => {
            // non-critical: attribution just stays null on this rare race
          });
      } else {
        // The call IS placed and ringing at Meta, but the local Call row failed
        // to persist for a reason OTHER than the benign P2002 race (e.g. a
        // transient pool timeout). Without a local row the originating browser
        // tears down its peer connection on the failure response, so when the
        // customer answers, the SDP-answer webhook frame has no PC to apply to
        // and the call dies on the ~15s ICE timeout — a ringing-into-the-void
        // orphan. Best-effort TERMINATE the Meta call so the customer's phone
        // stops ringing, then return a structured failure (never a 5xx — honors
        // this method's no-throw contract). ingest still records whatever
        // terminal webhook Meta sends, for forensics.
        this.logger.error(
          `Call row insert failed after placeCall succeeded for team=${session.teamId} contact=${contact.id} externalCallId=${placed.externalCallId}: ${
            err instanceof Error ? err.message : err
          } — terminating the orphaned Meta call`,
        );
        try {
          const binding = getProviderBinding(channelForCall);
          const end = binding.provider.endCall;
          if (end) {
            const cfg = await binding.getSendConfig(session.teamId);
            await end({ externalCallId: placed.externalCallId }, cfg);
          }
        } catch (terminateErr) {
          this.logger.warn(
            `failed to terminate orphaned Meta call externalCallId=${placed.externalCallId}: ${
              terminateErr instanceof Error ? terminateErr.message : terminateErr
            }`,
          );
        }
        return { ok: false, reason: "provider_rejected" } as InitiateCallFailure;
      }
    }

    // Publish ringing-out so the originating thread shows the right state with
    // the REAL initiator. Skip the publish on the P2002-recovery path: the
    // ingest insert already emitted its own call.ringing_out frame (with an
    // empty initiatedByUserId), so we'd otherwise double-publish. The FE's
    // optimistic ringing panel already covers the initiator's own view.
    if (createdHere) {
      await this.bus.publish({
        type: "call.ringing_out",
        teamId: session.teamId,
        conversationId,
        callId: created.id,
        externalCallId: created.externalCallId,
        initiatedByUserId: session.userId,
        ringingAt: ringingAt.toISOString(),
      });
    }

    return {
      ok: true,
      callId: created.id,
      externalCallId: created.externalCallId,
      status: created.status,
    };
  }

  /**
   * Admin: read Meta's current phone-number settings. Lets us see what
   * calling fields are currently set (status, call_icon_visibility,
   * call_hours, etc.) so we can diagnose why inbound calls aren't
   * arriving at our webhook.
   */
  async getPhoneNumberSettings(
    session: ApiSession,
    channel: "whatsapp" = "whatsapp",
  ): Promise<{ raw: unknown }> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.getPhoneNumberSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "provider does not support getPhoneNumberSettings",
      });
    }
    const config = await binding.getSendConfig(session.teamId);
    try {
      return await fn(config);
    } catch (err) {
      throw new HttpException(
        {
          error: "provider_rejected",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  }

  /**
   * Admin: enable WhatsApp Cloud API Calling on this team's phone number.
   * One-time setup — Meta requires this before any placeCall succeeds.
   * Returns Meta's response verbatim for diagnosis. Idempotent.
   */
  async enableCallingForTeam(
    session: ApiSession,
    channel: "whatsapp" = "whatsapp",
  ): Promise<{ ok: true; raw: unknown }> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.enableCalling;
    if (!fn) {
      throw new BadRequestException({
        error: "provider does not support enableCalling",
      });
    }
    const config = await binding.getSendConfig(session.teamId);
    try {
      return await fn(config);
    } catch (err) {
      this.logger.warn(
        `enableCalling failed for team=${session.teamId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      throw new HttpException(
        {
          error: "provider_rejected",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
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

    // Idempotency short-circuit — honor the doc-comment promise BEFORE hitting
    // Meta. Mirrors initiateCall's pre-flight semantics exactly so both callers
    // agree on what "already usable" means:
    //   - a GRANTED + unexpired row → return it, no Meta hit (re-requesting a
    //     live grant would burn the 1/24h quota and could 500 / cooldown).
    //   - a recent rate-limit placeholder (rateLimitedUntil > now) → return it
    //     instead of re-firing into the cooldown.
    //   - a still-live pending request (not rate-limited, expiresAt > now) →
    //     return it; the customer just hasn't accepted yet. Re-sending caps out.
    // Only when nothing usable is on file do we fall through to Meta — the
    // genuine first-request path, unchanged from before.
    const now = Date.now();
    const grantedPerm = await this.db.callPermissionRequest.findFirst({
      where: {
        teamId: session.teamId,
        contactId: conversation.contact.id,
        status: CallPermissionStatus.granted,
        expiresAt: { gt: new Date(now) },
      },
      orderBy: { requestedAt: "desc" },
      select: { id: true, externalRequestId: true, expiresAt: true },
    });
    if (grantedPerm) {
      return {
        permissionRequestId: grantedPerm.externalRequestId ?? grantedPerm.id,
        expiresAt: grantedPerm.expiresAt.toISOString(),
      };
    }
    const latest = await this.db.callPermissionRequest.findFirst({
      where: { teamId: session.teamId, contactId: conversation.contact.id },
      orderBy: { requestedAt: "desc" },
      select: {
        id: true,
        externalRequestId: true,
        status: true,
        expiresAt: true,
        rateLimitedUntil: true,
      },
    });
    if (
      (latest?.rateLimitedUntil && latest.rateLimitedUntil.getTime() > now) ||
      (latest?.status === CallPermissionStatus.pending &&
        !latest.rateLimitedUntil &&
        latest.expiresAt.getTime() > now)
    ) {
      return {
        permissionRequestId: latest.externalRequestId ?? latest.id,
        expiresAt: latest.expiresAt.toISOString(),
      };
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
          // The request was DELIVERED — but it's not a grant yet. The customer
          // still has to accept; the permission_granted webhook flips this to
          // `granted`. The pre-flight gate keys on `granted`, so `pending` here
          // surfaces a clear "waiting on the customer" state, not a green light.
          status: CallPermissionStatus.pending,
        },
      });
      return out;
    } catch (err) {
      // ONLY persist a rate-limit cooldown when Meta ACTUALLY rate-limited the
      // request (its 1/24h or 2/7d cap → numeric code 4 / 80007, normalized to
      // `rate_limited`). A transient failure — a 5xx, a network error, or the
      // 20s metaFetch timeout (which throws a plain Error, not a MetaSendError)
      // — must NOT brick outbound calling to this contact for 24h under a
      // misleading "rate_limited" reason. Those rethrow with no row written, so
      // the agent can simply retry. Previously EVERY failure wrote a 24h cooldown
      // and initiateCall reads only the NEWEST row, so one network blip shadowed
      // any valid grant for a full day.
      const normalized = normalizeMetaSendError(err);
      if (normalized?.code === "rate_limited") {
        const rateLimitedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await this.db.callPermissionRequest.create({
          data: {
            teamId,
            contactId,
            expiresAt: new Date(0),
            rateLimitedUntil,
            // Never reached the customer → not a pending grant; the
            // rateLimitedUntil timestamp is the discriminator the pre-flight
            // reads to surface a "rate_limited" reason instead of "pending".
            status: CallPermissionStatus.pending,
          },
        });
      }
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

    // Defense-in-depth: the controller's @RequireCapability("calls:receive")
    // already gated this. Re-checking the SAME capability here (not a second
    // one — answer needs only calls:receive) keeps the service safe if it's
    // ever invoked from an ungated path.
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

    // Now talk to Meta — pre_accept THEN accept. If Meta rejects either
    // step, the local row already flipped to in_progress; without a
    // rollback the audit log would lie ("answered at X, never ended")
    // and the inbox would show a live indicator the customer never sees.
    // Roll back to `failed` (terminal) so the agent gets a clear UI state
    // and the row reflects the truth.
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
      // Both pre_accept and accept carry the SAME SDP answer. Meta returns
      // 131009 "Missing session parameter" on pre_accept without it.
      await preAccept(
        { externalCallId: call.externalCallId, sdpAnswer },
        config,
      );
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
      // Rollback the optimistic in_progress flip so the timeline + future
      // pre-flight gates see the true state. CAS-gated so a concurrent
      // terminal webhook racing us still wins. Best-effort — a rollback
      // failure here is logged and swallowed because we're already in an
      // error path and don't want to mask the original Meta error.
      try {
        const endedAt = new Date();
        await this.db.call.updateMany({
          where: { id: callId, status: CallStatus.in_progress },
          data: {
            status: CallStatus.failed,
            endedAt,
            // The optimistic CAS above stamped answeredByUserId + answeredAt to
            // flip the row to in_progress. Meta then rejected the accept, so the
            // call NEVER connected — null both back out. Leaving answeredAt set
            // makes `connected: answeredAt !== null` (listTeamCalls) report a
            // failed answer attempt as a connected call and permanently
            // attributes the agent to a call they never spoke on. CAS-gated on
            // status:in_progress, so a racing terminal webhook still wins.
            answeredAt: null,
            answeredByUserId: null,
            // durationSeconds left null — the call never actually connected.
          },
        });
        await this.bus.publish({
          type: "call.failed",
          teamId: session.teamId,
          conversationId: call.conversationId,
          callId: call.id,
          reason: "provider_error",
          endedAt: endedAt.toISOString(),
        });
      } catch (rollbackErr) {
        this.logger.warn(
          `acceptCall rollback failed for call=${callId}: ${
            rollbackErr instanceof Error ? rollbackErr.message : rollbackErr
          }`,
        );
      }
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

    const rejectedAt = new Date();
    const cas = await this.db.call.updateMany({
      where: { id: callId, status: CallStatus.ringing },
      data: { status: CallStatus.rejected, endedAt: rejectedAt },
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
      endedAt: rejectedAt.toISOString(),
    });
    return { ok: true };
  }

  /**
   * Mark an OUTBOUND call connected (customer picked up), reported by the
   * originating agent's browser the instant it detects real inbound audio.
   *
   * Business-initiated calls give NO live pickup signal: Meta's `connect`
   * webhook is just media setup (fires ~1s after dialing, BEFORE pickup) and
   * the authoritative `start_time`/`duration` only arrive at terminate. So the
   * browser's audio-flow detection is the live "they answered" moment. Stamping
   * answeredAt here (set-once, CAS on a ringing row) makes a later agent hangup
   * resolve to a real `completed` call instead of `missed`, and keeps the
   * connected-call/daily-cap accounting honest. Mirrors inbound answerCall,
   * minus the Meta pre_accept/accept (the media leg is already up from connect).
   * Idempotent: count 0 (already connected/terminal/not-found) → success.
   */
  async markConnected(
    session: ApiSession,
    callId: string,
  ): Promise<{ ok: true }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (!perms["calls:make" as Capability]) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const answeredAt = new Date();
    const cas = await this.db.call.updateMany({
      where: {
        id: callId,
        teamId: session.teamId,
        direction: CallDirection.out,
        status: CallStatus.ringing,
        answeredAt: null,
        // Only the agent who PLACED the call can report its pickup — the
        // browser pickup signal is local to the originating peer connection.
        // Without this scope, any teammate with the default-true calls:make
        // capability could flip another agent's ringing call to connected
        // (stamping answeredAt, burning the 5/24h connected-call cap, and
        // flipping the thread pill to in_progress for every viewer on a call
        // that may never have been picked up). count 0 (not the initiator) →
        // idempotent success, same as the already-connected/terminal case.
        initiatedByUserId: session.userId,
      },
      data: { status: CallStatus.in_progress, answeredAt },
    });
    if (cas.count === 0) return { ok: true };

    const call = await this.db.call.findFirst({
      where: { id: callId, teamId: session.teamId },
      select: { conversationId: true },
    });
    if (call) {
      // Reuse call.answered_by_agent → call:answered so every viewer's thread
      // flips the activeCall pill to in_progress. The toast-dismiss it also
      // triggers is a no-op outbound (there's no incoming toast). answeredByUserId
      // = the agent on the call.
      await this.bus.publish({
        type: "call.answered_by_agent",
        teamId: session.teamId,
        conversationId: call.conversationId,
        callId,
        answeredByUserId: session.userId,
        answeredAt: answeredAt.toISOString(),
      });
    }
    return { ok: true };
  }

  /**
   * Hang up an in-progress call. Idempotent — re-calling on an already-
   * terminated call returns success. Cap check is inline because either
   * make OR receive capability is sufficient (the answering agent + the
   * initiating agent can both hang up).
   *
   * DELIBERATELY team-scoped, NOT initiator/answerer-scoped: in a shared
   * inbox any calling-capable teammate can end a live call (the same model
   * as any teammate replying to / closing a conversation). We do NOT pin
   * this to the initiator/answerer — that would block a supervisor or a
   * second agent from rescuing a stuck call. Unlike markConnected (which
   * stamps answeredAt and feeds the daily cap, so it MUST be initiator-only),
   * ending is a terminal, idempotent, audit-logged action with no such
   * accounting side effect, so the broader grant is the right product call.
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
        ringingAt: true,
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
    // A call hung up while still RINGING never connected — an agent cancelling
    // an outbound before the customer picked up, or tearing down an unanswered
    // inbound. Recording that as `completed` is misleading: the timeline pill
    // would read "Outgoing call" with no duration instead of "Customer didn't
    // answer". Map the never-answered case to `missed` so the persisted row,
    // the live pill, and any history reload all agree. `answeredAt` is the
    // connected discriminator (set once, on the first in_progress transition).
    const wasConnected = call.answeredAt !== null;
    const terminalStatus = wasConnected
      ? CallStatus.completed
      : CallStatus.missed;
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
        status: terminalStatus,
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

    // Publish the matching terminal phase so the audit pill + socket fanout
    // status line stay consistent with the DB row we just wrote:
    //   - connected hangup → call.ended (carries duration; "Call · 1:23")
    //   - never-answered cancel → call.missed ("Customer didn't answer")
    if (wasConnected) {
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
    } else {
      await this.bus.publish({
        type: "call.missed",
        teamId: session.teamId,
        conversationId: call.conversationId,
        callId: call.id,
        ringingAt: call.ringingAt.toISOString(),
      });
      // Mirror Meta's auto-revocation counter (4 consecutive unanswered
      // outbound calls). This REST endCall used to increment the counter here,
      // but that double-counted in a race: this CAS and the webhook ingest's
      // terminal-transition write are not serialized against each other, so a
      // near-simultaneous agent-cancel + Meta terminate webhook could each read
      // a non-terminal row and each increment (F17). The increment now has a
      // SINGLE owner — the webhook ingest path's genuine non-terminal→terminal
      // `missed` transition in lib/providers/ingest-call.ts (which also owns the
      // reset-on-`completed`), so the counter can't drift high. The webhook is
      // Meta's authoritative terminate signal and always lands for a real
      // unanswered outbound call; if THIS path terminalized the row first, the
      // webhook's alreadyTerminal guard correctly skips — but the local mirror
      // being eventually-consistent via the webhook is preferable to the
      // un-serialized double-increment that could spuriously trip revocation.
      // (Intentionally no increment here — do not re-add without serializing
      // against the webhook path; adding a per-Call `countedTowardRevocation`
      // CAS flag would need a migration, deliberately avoided in this change.)
    }

    return { ok: true, durationSeconds };
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
    // Capability gate: viewing call history requires either calling capability,
    // mirroring endCall's inline make-OR-receive check. Without this the read
    // path would leak full call history (who called whom, durations, answered-by)
    // to roles an admin has deliberately scoped OUT of calling — every mutating
    // calling route is gated, so the read path must be too. Decorators are
    // single-capability, hence the inline OR.
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    // Team scope via the conversation FK — defensive lookup.
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId: session.teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    // Keyset pagination on (ringingAt DESC, id DESC). A COMPOSITE cursor is
    // required: ringingAt is not unique — two calls can share a timestamp
    // (Meta delivers second-granular times; a placeCall + its near-instant
    // ringing webhook routinely collide on the same ringingAt). The previous
    // `cursor: { id }` Prisma cursor keyed on id alone, which silently
    // mis-paginates across a ringingAt tie sitting on a page boundary (drops or
    // duplicates a row). Manual (ringingAt, id) keyset — the same pattern as
    // broadcasts.service / team-chat queries — is correct regardless of ties.
    // Cursor wire form is `<ringingAtMs>_<id>`, opaque to the client.
    const parsed = parseCallCursor(cursor);
    const cursorWhere: Prisma.CallWhereInput | undefined = parsed
      ? {
          OR: [
            { ringingAt: { lt: parsed.ringingAt } },
            { ringingAt: parsed.ringingAt, id: { lt: parsed.id } },
          ],
        }
      : undefined;
    // teamId is explicit (not just the conversationId FK) to match every other
    // call query in this service and keep the tenant scope visible at the row
    // level, not implied by the prior conversation lookup.
    const baseWhere: Prisma.CallWhereInput = {
      conversationId,
      teamId: session.teamId,
    };
    const rows = await this.db.call.findMany({
      where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
      orderBy: [{ ringingAt: "desc" }, { id: "desc" }],
      take: take + 1,
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
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const items = page.map(serializeCall);
    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? `${last.ringingAt.getTime()}_${last.id}` : null;
    return { items, cursor: nextCursor };
  }

  /**
   * TEAM-WIDE call history for the Calls page — every call across every
   * conversation, newest-first, with the contact + who-placed/answered names
   * resolved in the same query. Same capability gate + keyset cursor as the
   * per-conversation `list()`; same `<ringingAtMs>_<id>` cursor wire form.
   */
  async listTeamCalls(
    session: ApiSession,
    take: number,
    cursor: string | undefined,
    filters: { q?: string; from?: string; to?: string } = {},
  ): Promise<{ items: TeamCallRow[]; cursor: string | null }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const parsed = parseCallCursor(cursor);
    const cursorWhere: Prisma.CallWhereInput | undefined = parsed
      ? {
          OR: [
            { ringingAt: { lt: parsed.ringingAt } },
            { ringingAt: parsed.ringingAt, id: { lt: parsed.id } },
          ],
        }
      : undefined;
    const baseWhere: Prisma.CallWhereInput = { teamId: session.teamId };

    // Free-text filter: substring on the contact's NAME or PHONE, reached
    // through the conversation→contact relation (the same join the select uses).
    // name is case-insensitive; phone is a raw substring (digits + leading +).
    const q = filters.q?.trim();
    if (q) {
      baseWhere.conversation = {
        contact: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phoneNumber: { contains: q } },
          ],
        },
      };
    }

    // Date range on ringingAt (the user-visible "when the call happened" time).
    // `from`/`to` are ISO instants the client already widened to the local-day
    // boundaries, so we just clamp; invalid strings are ignored (never throw).
    const ringingAt: Prisma.DateTimeFilter = {};
    if (filters.from) {
      const d = new Date(filters.from);
      if (!Number.isNaN(d.getTime())) ringingAt.gte = d;
    }
    if (filters.to) {
      const d = new Date(filters.to);
      if (!Number.isNaN(d.getTime())) ringingAt.lte = d;
    }
    if (ringingAt.gte || ringingAt.lte) baseWhere.ringingAt = ringingAt;
    const rows = await this.db.call.findMany({
      where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
      orderBy: [{ ringingAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        conversationId: true,
        direction: true,
        status: true,
        ringingAt: true,
        answeredAt: true,
        durationSeconds: true,
        initiatedBy: { select: { id: true, name: true } },
        answeredBy: { select: { id: true, name: true } },
        conversation: {
          select: { contact: { select: { id: true, name: true, phoneNumber: true } } },
        },
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const items: TeamCallRow[] = page.map((c) => ({
      id: c.id,
      conversationId: c.conversationId,
      contactId: c.conversation.contact?.id ?? null,
      contactName: c.conversation.contact?.name ?? null,
      contactPhone: c.conversation.contact?.phoneNumber ?? null,
      direction: c.direction === "in" ? ("in" as const) : ("out" as const),
      status: c.status,
      initiatedByName: c.initiatedBy?.name ?? null,
      answeredByName: c.answeredBy?.name ?? null,
      ringingAt: c.ringingAt.toISOString(),
      durationSeconds: c.durationSeconds,
      connected:
        c.answeredAt !== null ||
        (c.durationSeconds !== null && c.durationSeconds > 0),
    }));
    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? `${last.ringingAt.getTime()}_${last.id}` : null;
    return { items, cursor: nextCursor };
  }

  /**
   * Count of calls currently LIVE (ringing or in progress) for the team — the
   * number behind the inbox "Calls" badge. Capability-gated like the list; the
   * client hook debounce-refetches it on the call:* socket frames so it stays
   * current without any client-side delta accounting (can't drift).
   */
  async liveCount(session: ApiSession): Promise<{ count: number }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const count = await this.db.call.count({
      where: {
        teamId: session.teamId,
        status: { in: [CallStatus.ringing, CallStatus.in_progress] },
      },
    });
    return { count };
  }
}

/** Wire row for the team-wide Calls page. */
export interface TeamCallRow {
  id: string;
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  direction: "in" | "out";
  status: SerializedCall["status"];
  /** Agent who placed an outbound call (null for inbound). */
  initiatedByName: string | null;
  /** Agent who answered an inbound call (null if unanswered). */
  answeredByName: string | null;
  ringingAt: string;
  durationSeconds: number | null;
  connected: boolean;
}

/**
 * Decode the `<ringingAtMs>_<id>` keyset cursor `list()` emits. Returns null on
 * absent/malformed input (caller falls back to the first page). cuid ids carry
 * no underscore, so splitting on the FIRST `_` cleanly separates the epoch-ms
 * prefix from the id.
 */
function parseCallCursor(
  raw: string | undefined,
): { ringingAt: Date; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf("_");
  if (i <= 0) return null;
  const ms = Number(raw.slice(0, i));
  const id = raw.slice(i + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { ringingAt: new Date(ms), id };
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
  };
}
