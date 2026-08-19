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
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import { storeInAppRecording } from "@/lib/media/call-recording-download";
import {
  callArtifactPoliciesFor,
  deriveTranscriptPending,
} from "@/lib/media/call-artifact-policy";
import {
  providerPlaceCall,
  providerAnswerCall,
  providerCompleteAccept,
  providerRejectCall,
  providerEndCall,
  providerMediaUpdate,
  usesUnifiedCalling,
} from "@/lib/messaging/call-actions";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { channelAccountDisplayName } from "@/lib/channel-accounts/display";
import {
  getBusinessNumberCountry,
  invalidateProviderConfig,
} from "@/lib/providers/config";
import { isBicAllowedForBusinessNumber } from "@ccp/shared/providers/calling-regions";
import type { Capability } from "@ccp/shared/auth/permissions";
import { resolvePermissions } from "@ccp/shared/auth/permissions";
import type {
  CallPermissionState,
  CallSettings,
  CallSettingsState,
} from "@ccp/shared/providers/types";
import type { Channel } from "@ccp/shared/types";

/**
 * Context shown above the provider-rendered Allow/Deny prompt when we ask a
 * customer for calling permission.
 *
 * Deliberately a constant, not agent-supplied: this text is the only thing the
 * customer reads before granting an ongoing right to be phoned, so it has to
 * stay accurate and consistent. The prompt itself is rendered by the provider
 * and cannot be customized. (Per-team wording belongs in Settings alongside the
 * other calling policy, not in a free-text field on a call button.)
 */
const CALL_PERMISSION_REQUEST_BODY =
  "We'd like to call you to help with your request. Allow calls from us?";

/**
 * How long after a call ends its own agent may still push the in-app
 * recording. Wide enough for the browser's teardown upload (three retries) to
 * survive a terminate webhook that beat it and a slow multipart on a long
 * call; short enough that a finished call is not an open upload target.
 */
const INAPP_RECORDING_UPLOAD_WINDOW_MS = 10 * 60 * 1000;

import {
  conversationRelationWhere,
  visibilityWhere,
} from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";
import type { ApiSession } from "../auth/session.guard";

/**
 * Calls service.
 *
 *   initiateCall    — outbound call from agent → customer. Runs the BIC
 *                     pre-flight gauntlet (region / revocation / 24h
 *                     window / provider-reported connected-call quota —
 *                     the figure has moved 5 → 10 → 100 per 24h, which is
 *                     exactly why the code reads it live from
 *                     GET /call_permissions instead of hardcoding it /
 *                     permission request).
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
  // The provider has PAUSED calling on our number entirely (negative feedback
  // or a low pickup rate). Distinct from rate_limited, which is per-customer:
  // this blocks every call until it lifts.
  | { ok: false; reason: "calling_restricted"; retryAt: string }
  // Coexistence: the number is in use with BOTH the WhatsApp Business app and
  // Cloud API, and Meta's feature table lists voice/video calls as unsupported for
  // that configuration. Permanent for as long as the number stays on the business
  // app — no retryAt, because nothing lapses.
  | { ok: false; reason: "calling_unsupported_coexistence" }
  | { ok: false; reason: "daily_cap_reached" }
  | { ok: false; reason: "provider_not_configured" }
  | { ok: false; reason: "provider_rejected" };

/** One line of the calling setup checklist. */
export interface CallingReadinessCheck {
  key: string;
  ok: boolean;
  /** Short affirmative statement of what's required. */
  label: string;
  /** What to do about it, when `ok` is false. */
  detail: string | null;
}

export interface CallingReadiness {
  ready: boolean;
  checks: CallingReadinessCheck[];
  /** Null when the provider's settings couldn't be read. */
  settings: CallSettingsState | null;
  /** Per-number toggle: record calls (silently, in the agent's browser). */
  recordingPolicy: { enabled: boolean } | null;
  /** Per-number toggle: transcribe calls (our own Whisper pipeline). */
  transcriptionPolicy: { enabled: boolean } | null;
}

export interface InitiateCallSuccess {
  ok: true;
  callId: string;
  externalCallId: string;
  status: CallStatus;
  /**
   * Messenger returns the SDP answer synchronously from the `connect` call, so
   * the browser applies it immediately. WhatsApp omits it (its answer arrives
   * later via the `connecting` webhook), so this is undefined there.
   */
  sdpAnswer?: string;
  /**
   * True when the number's artifact mode is "inapp" and recording or
   * transcription is enabled — the BROWSER records this call (silently) and
   * uploads to `POST /api/calls/:callId/recording-upload`.
   */
  recordInApp?: boolean;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Initiate an outbound call. Pre-flight runs in this order so each failure
   * surfaces a precise reason the UI can render:
   *   1. conversation + contact load, then a capability gate on the channel's
   *      declared `capabilities.calling` (Instagram / any future non-calling
   *      channel is refused here, not left to fail deep in the provider)
   *   2. region gate — on OUR business number's country, not the customer's
   *   3. permission + quota, read from the PROVIDER (never a local ledger)
   *   4. placeCall + INSERT Call row + publish ringing_out
   *
   * The permission gate is the part worth understanding. Permission is
   * required for EVERY business-initiated call — there is no 24h-window
   * exemption; the window only decides how we may ASK. And permission can be
   * granted by paths that leave no trace on our side (automatically when the
   * customer calls us, or from the business profile), so a local request
   * ledger cannot be the gate — it would refuse contacts who are perfectly
   * callable. We ask the provider, which also returns the live quota, so no
   * call cap is hardcoded here to go stale.
   */
  async initiateCall(
    session: ApiSession,
    conversationId: string,
    sdpOffer: string,
  ): Promise<InitiateCallSuccess | InitiateCallFailure> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId: session.workspaceId },
      select: {
        id: true,
        channel: true,
        // The THREAD's account. Calling belongs to the phone number exactly
        // like messaging does — permission grants, quotas, restrictions and
        // the call itself are all per business number, so every provider call
        // below must target the number the customer is actually talking to,
        // never the workspace default.
        channelConnectionId: true,
        contact: {
          select: {
            id: true,
            phoneNumber: true,
            externalContactId: true,
            bsuid: true,
            callPermissionRevokedUntil: true,
            lastInboundAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation_not_found" });
    const contact = conversation.contact;
    if (!contact) throw new BadRequestException({ error: "conversation_has_no_contact" });

    // Channel-aware calling. WhatsApp uses method-per-action + a phone number +
    // our own permission-request ledger; Messenger uses the unified `callAction`
    // + a PSID + Meta's own permission check. Branch the whole preflight on it.
    const channelForCall = conversation.channel ?? "whatsapp";
    const binding = getProviderBinding(channelForCall);
    // Capability gate (defense-in-depth; the @RequireCalling guard + the UI
    // hiding the button are the front line). Derive from the DECLARED capability,
    // not from whether the provider happens to expose a call method — Instagram
    // (no Meta calling API) and any future non-calling channel are refused here
    // with a clean error instead of failing deep in the provider. Mirrors
    // enableCallingForTeam, which gates the same way.
    if (!binding.provider.capabilities.calling) {
      throw new BadRequestException({
        error: "calling_not_supported",
        detail: `Calling isn't available on ${channelForCall}.`,
      });
    }
    const isUnified = usesUnifiedCalling(binding.provider);
    // Phone channels identify the callee by phone OR business-scoped user id.
    // A customer who called us cold (the provider omits their number once we
    // haven't messaged them in 30 days) has ONLY a BSUID — requiring a phone
    // here made those contacts permanently uncallable, which is exactly the
    // callback case calling exists to serve.
    const to =
      (isUnified ? contact.externalContactId : contact.phoneNumber) ?? undefined;
    const recipient = isUnified ? undefined : contact.bsuid ?? undefined;
    if (!to && !recipient) {
      throw new BadRequestException({
        error: isUnified
          ? "contact has no messaging id"
          : "contact has no phone number or user id",
      });
    }

    // ── Cheap local gates first ──────────────────────────────────────────
    // Everything below this comment is answerable from our own database, so it
    // runs before any credential load or provider round-trip. Ordering them
    // this way isn't just speed: it means a team that hasn't connected
    // WhatsApp still gets the precise reason ("your number's country can't
    // place calls") rather than a blanket "not configured".

    // Region. Eligibility follows OUR business number's country, not the
    // customer's: a number registered in a blocked market can't call anyone,
    // and an eligible one can call customers anywhere. (Phone channels only —
    // a PSID carries no country, and Messenger's per-Page feature status is its
    // own region gate.) Defense-in-depth; the UI already hides the button.
    if (!isUnified) {
      const businessCountry = await getBusinessNumberCountry(
        session.workspaceId,
        conversation.channelConnectionId,
      );
      if (!isBicAllowedForBusinessNumber(businessCountry)) {
        return { ok: false, reason: "bic_blocked_region" };
      }
    }

    // Provider-imposed pause on calling for this number (negative feedback or a
    // low pickup rate). Every attempt would fail anyway; refusing here gives the
    // agent the real reason and the date it lifts instead of a generic
    // rejection, and avoids adding failed attempts to the record that caused it.
    // Restrictions are per NUMBER: read the thread's own connection when the
    // conversation is bound to one, the workspace default only as the legacy
    // single-account fallback. A restriction on a sibling number must neither
    // block this call nor mask a restriction on the number actually calling.
    const restriction = await this.db.channelConnection.findFirst({
      where: conversation.channelConnectionId
        ? { id: conversation.channelConnectionId, workspaceId: session.workspaceId }
        : { workspaceId: session.workspaceId, channel: channelForCall, isDefault: true },
      select: {
        callingRestrictedUntil: true,
        callingRestrictionType: true,
        isOnBusinessApp: true,
      },
    });
    // A Coexistence number cannot call at all. Meta's business-app feature table
    // lists "Voice and video calls" as NOT supported on Cloud API for a number in
    // use with both the WhatsApp Business app and Cloud API. Nothing checked this:
    // `isOnBusinessApp` was read only by the rate limiter and the health sweeper,
    // so an agent on such a number got a Call button that always failed — and a
    // call-permission request is a BILLED template send, so the failure cost money
    // for a capability that cannot exist.
    if (restriction?.isOnBusinessApp) {
      return { ok: false, reason: "calling_unsupported_coexistence" };
    }
    // Only a restriction that pauses OUR direction blocks here. Meta pauses
    // each direction independently: RESTRICTED_USER_INITIATED_CALLING (and the
    // low-pickup _CALL_BUTTON_HIDDEN variant) stop inbound calls + the call
    // icon while business-initiated calls stay allowed — blocking outbound on
    // one would tighten beyond Meta's own rule. Unknown/legacy types (null,
    // or anything not clearly user-initiated-only) still block, matching the
    // conservative behavior this gate always had.
    //
    // BEWARE the prefix split in Meta's own enum: the restriction that blocks BOTH
    // directions is spelled `RESTRICTED_BIZ_INITIATED_AND_USER_INITIATED_CALLING`
    // ("Business cannot make or receive calls"), while the outbound-only one is
    // `RESTRICTED_BUSINESS_INITIATED_CALLING`. Matching only "BUSINESS_INITIATED"
    // meant the combined form satisfied neither clause — it contains
    // "USER_INITIATED" so it looked inbound-only — and outbound calls sailed
    // through a restriction Meta applies to both directions. Check both spellings.
    const restrictionType = restriction?.callingRestrictionType;
    const blocksOutboundExplicitly =
      restrictionType?.includes("BIZ_INITIATED") ||
      restrictionType?.includes("BUSINESS_INITIATED");
    const pausesOutbound =
      !restrictionType ||
      !restrictionType.includes("USER_INITIATED") ||
      Boolean(blocksOutboundExplicitly);
    if (
      pausesOutbound &&
      restriction?.callingRestrictedUntil &&
      restriction.callingRestrictedUntil.getTime() > Date.now()
    ) {
      return {
        ok: false,
        reason: "calling_restricted",
        retryAt: restriction.callingRestrictedUntil.toISOString(),
      };
    }

    // Testing escape hatch: skip the permission/quota pre-flight so QA can
    // place repeat calls without burning real permission quota. Gated to
    // non-production AND an explicit flag, so it can never silently weaken
    // prod. Meta still enforces its OWN rules at placeCall — this only removes
    // our friction, so an unpermitted customer still yields a provider
    // rejection. The region gate above is NEVER skipped.
    const skipPreflight =
      process.env.NODE_ENV !== "production" &&
      process.env.CALLS_SKIP_PREFLIGHT === "1";
    if (skipPreflight) {
      this.logger.warn(
        `CALLS_SKIP_PREFLIGHT active — bypassing permission/quota for team=${session.workspaceId} contact=${contact.id}`,
      );
    }

    // NOTE: `Contact.callPermissionRevokedUntil` is deliberately NOT consulted
    // here. It is advisory context for the contact panel, not a gate.
    //
    // It was a gate briefly, and it refused customers the agent had just
    // finished speaking to. Permission can come back at any moment through
    // paths that write nothing on our side — the customer calling us (with
    // callback permission on), or granting from their business profile — so a
    // cached "revoked" flag reliably outlives the reality it describes. Same
    // failure the local permission ledger had, in a smaller box. The provider
    // read below is the authority; a genuinely revoked contact costs one Graph
    // call to discover, which is nothing on a path a human deliberately
    // triggered.

    // Everything past here needs provider credentials.
    let sendConfig: unknown;
    try {
      sendConfig = await binding.getSendConfig(
        session.workspaceId,
        conversation.channelConnectionId,
      );
    } catch (err) {
      this.logger.warn(
        `getSendConfig failed for team=${session.workspaceId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return { ok: false, reason: "provider_not_configured" };
    }

    // Messenger permission: Meta owns the model (7-day opt-in), so we ask it
    // directly. `canStartCall` also encodes Meta's per-thread call quota, so it
    // doubles as the cap gate.
    if (isUnified && !skipPreflight && to) {
      const perm = await binding.provider.checkCallPermission?.(to, sendConfig);
      if (perm && !perm.canStartCall) {
        if (perm.canRequestPermission) {
          try {
            await binding.provider.requestCallPermission?.(to, sendConfig);
          } catch (err) {
            this.logger.warn(
              `messenger call-permission request failed for team=${session.workspaceId} contact=${contact.id}: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
          return { ok: false, reason: "permission_required" };
        }
        return { ok: false, reason: "permission_pending" };
      }
    }

    // Phone-channel permission + quota, straight from the provider.
    //
    // This replaced a local ledger that tried to reconstruct the provider's
    // rules — request cooldowns, grant validity, a hardcoded per-day call cap.
    // That could never be right: two of the three ways a customer grants
    // permission (automatically by calling us, or from the business profile)
    // write nothing on our side, so the ledger refused callable contacts; and
    // the call cap has moved 5 → 10 → 100 in a year, so any number baked in
    // here is wrong by the next changelog. The provider knows all of it and
    // returns a computed verdict, so we ask.
    if (!isUnified && !skipPreflight) {
      const readPermission = binding.provider.getCallPermission;
      if (readPermission) {
        let permission: Awaited<ReturnType<typeof readPermission>>;
        try {
          permission = await readPermission(
            { ...(to ? { to } : {}), ...(recipient ? { recipient } : {}) },
            sendConfig,
          );
        } catch (err) {
          // A permission read that fails is NOT a green light — placing the
          // call anyway would burn quota and hit an opaque rejection. Refuse
          // with the reason the agent can act on.
          this.logger.warn(
            `getCallPermission failed for team=${session.workspaceId} contact=${contact.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
          return { ok: false, reason: "permission_required" };
        }

        // Mirror the provider's answer locally so the contact panel and the
        // next pre-flight agree with it without another round-trip.
        await this.syncPermissionCache(session.workspaceId, contact.id, permission);

        if (!permission.hasPermission) {
          // No permission at all. Ask for it, then tell the agent to wait —
          // sending the request is the useful action here, not an error.
          if (permission.canRequestPermission) {
            const requested = await this.tryRequestPermission(
              session.workspaceId,
              contact.id,
              conversation.channel,
              { to, recipient },
              conversation.channelConnectionId,
            );
            return {
              ok: false,
              reason: requested ? "permission_required" : "permission_pending",
            };
          }
          // Can't even ask — the request quota is spent. Distinguish this from
          // "we asked, waiting on them" so the UI doesn't tell the agent to be
          // patient when the real answer is "try again tomorrow".
          return { ok: false, reason: "permission_pending" };
        }

        // Permission exists but the connected-call quota for this customer is
        // spent. The provider tells us when it resets.
        if (!permission.canStartCall) {
          return permission.startCallResetAt
            ? {
                ok: false,
                reason: "rate_limited",
                retryAt: permission.startCallResetAt.toISOString(),
              }
            : { ok: false, reason: "daily_cap_reached" };
        }
      }
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
    let placed: { externalCallId: string; sdpAnswer?: string };
    // Set inside the try (policies are read there); consumed by the success
    // return — tells the browser to run the in-app recorder for this call.
    let recordInApp = false;
    try {
      // The number's recording/transcription toggles. Nothing is attached to
      // the provider call and nothing is sent to the customer — recording is
      // silent in-app; `recordInApp` on the response is what tells the
      // browser to run its recorder (which starts at PICKUP, not at dial).
      const policies = await this.callArtifactPolicies(
        session.workspaceId,
        channelForCall,
        conversation.channelConnectionId,
      );
      recordInApp = policies.recordingEnabled || policies.transcriptionEnabled;
      placed = await providerPlaceCall(binding.provider, channelForCall, sendConfig, {
        ...(to ? { to } : {}),
        ...(recipient ? { recipient } : {}),
        sdpOffer,
        // Echoed back (biz_opaque_callback_data) on every status/terminate
        // webhook for this call — stored in each frame's rawPayload, so
        // forensics can tie a webhook to the thread without a join. Opaque
        // cuid only: Meta hands this string to EVERY app subscribed to the
        // WABA's calls field, so it must never carry PII.
        correlationId: conversation.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `placeCall failed for team=${session.workspaceId} contact=${contact.id}: ${message}`,
      );
      // Map the provider's own error code where it says something actionable,
      // so the agent sees "they haven't allowed calls" instead of a generic
      // rejection. A permission error also means our cached grant is stale —
      // clear it so the next click re-reads rather than trusting a dead row.
      const normalized = normalizeMetaSendError(err);
      if (normalized?.code === "call_permission_required") {
        await this.invalidatePermissionCache(session.workspaceId, contact.id);
        return { ok: false, reason: "permission_required" };
      }
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
            workspaceId: session.workspaceId,
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
            workspaceId_channel_externalCallId: {
              workspaceId: session.workspaceId,
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
          `Call row insert failed after placeCall succeeded for team=${session.workspaceId} contact=${contact.id} externalCallId=${placed.externalCallId}: ${
            err instanceof Error ? err.message : err
          } — terminating the orphaned Meta call`,
        );
        try {
          const cfg = await binding.getSendConfig(
            session.workspaceId,
            conversation.channelConnectionId,
          );
          await providerEndCall(binding.provider, channelForCall, cfg, {
            externalCallId: placed.externalCallId,
          });
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
        workspaceId: session.workspaceId,
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
      // Messenger only — the browser applies this answer immediately.
      ...(placed.sdpAnswer ? { sdpAnswer: placed.sdpAnswer } : {}),
      recordInApp,
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
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<{ raw: unknown }> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.getPhoneNumberSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_not_supported", detail: "This channel's provider can't report phone-number calling settings.",
      });
    }
    const config = await binding.getSendConfig(session.workspaceId, accountId);
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
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<{ ok: true; raw: unknown }> {
    // Only calling-capable channels expose enableCalling (WhatsApp: enable Cloud
    // API Calling; Messenger: route inbound calls to us + show the call icon).
    if (!getProviderBinding(channel).provider.capabilities.calling) {
      throw new BadRequestException({
        error: "channel_does_not_support_calling",
        detail: `${channel} has no calling capability.`,
      });
    }
    const binding = getProviderBinding(channel);
    const fn = binding.provider.enableCalling;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_not_supported", detail: "This channel's provider can't enable calling.",
      });
    }
    const config = await binding.getSendConfig(session.workspaceId, accountId);
    try {
      return await fn(config);
    } catch (err) {
      this.logger.warn(
        `enableCalling failed for team=${session.workspaceId}: ${
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
   * Admin: read the current calling configuration + any active restrictions.
   *
   * Always read through to the provider rather than a local cache: an admin can
   * change these in the provider's own console, and the provider is also where
   * restrictions appear.
   */
  async getCallSettings(
    session: ApiSession,
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<CallSettingsState> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.getCallSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_settings_unsupported",
        detail: `${channel} has no configurable calling settings.`,
      });
    }
    const config = await binding.getSendConfig(session.workspaceId, accountId);
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
   * Admin: change calling configuration. A PATCH — only the fields supplied are
   * written, so an admin toggling the call icon doesn't silently reset their
   * business hours.
   */
  async updateCallSettings(
    session: ApiSession,
    settings: CallSettings,
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<CallSettingsState> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.updateCallSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_settings_unsupported",
        detail: `${channel} has no configurable calling settings.`,
      });
    }
    const config = await binding.getSendConfig(session.workspaceId, accountId);
    try {
      return await fn(settings, config);
    } catch (err) {
      this.logger.warn(
        `updateCallSettings failed for team=${session.workspaceId}: ${
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
   * The number's standing artifact policy, read fresh from its connection
   * config (OURS — the provider stores no such setting). Two bare per-number
   * toggles: should this call be recorded, should it be transcribed. They
   * drive `recordInApp` on the initiate/answer responses and the retention
   * decision after transcription.
   */
  private async callArtifactPolicies(
    workspaceId: string,
    channel: Channel,
    channelConnectionId: string | null,
  ): Promise<{
    /** Per-number toggles: does this workspace want the call recorded /
     *  transcribed? Drives the browser recorder (`recordInApp` on the
     *  initiate/answer responses). */
    recordingEnabled: boolean;
    transcriptionEnabled: boolean;
  }> {
    // Artifacts are produced IN-APP only (maintainer decision 2026-07-28):
    // the agent's browser records silently and our own STT transcribes.
    // Meta's built-in recording/transcription objects are NEVER attached to a
    // call, and nothing is sent to the customer about recording either — the
    // maintainer removed the consent-notice message outright as well; the
    // notice posture is the business's own responsibility. (The webhook
    // ingest for `call_recording_available`/`call_transcript_available`
    // remains as a safety net for artifacts of historical calls.)
    //
    // The read itself lives in the domain layer (`callArtifactPoliciesFor`)
    // because the call-recordings sweeper needs the SAME answer when it
    // finishes work for a call whose browser or API process died mid-pipeline.
    return callArtifactPoliciesFor(workspaceId, channel, channelConnectionId);
  }

  /**
   * Admin: set the number's standing artifact policy. Stored on the
   * connection's config (local, not a provider write) and applied to every
   * subsequent placed/answered call on that number — the agent's browser then
   * records the call silently (there is no announcement; the maintainer
   * removed Meta's built-in flow and the consent notice outright, see
   * `callArtifactPolicies`).
   */
  async updateCallArtifactPolicy(
    session: ApiSession,
    kind: "callRecording" | "callTranscription",
    input: { enabled: boolean },
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<{ policy: { enabled: boolean } | null }> {
    if (channel !== "whatsapp") {
      throw new BadRequestException({
        error: "recording_not_supported",
        detail: `${channel} calls can't be recorded or transcribed.`,
      });
    }
    const conn = await this.db.channelConnection.findFirst({
      where: accountId
        ? { id: accountId, workspaceId: session.workspaceId, channel }
        : { workspaceId: session.workspaceId, channel, isDefault: true },
      select: { id: true, config: true },
    });
    if (!conn) throw new NotFoundException({ error: "channel_not_connected" });
    const config = (conn.config ?? {}) as Prisma.JsonObject;
    // A bare enabled flag — announcement purpose/language belonged to Meta's
    // removed built-in flow; legacy keys in stored configs are simply
    // overwritten here.
    const policy = { enabled: input.enabled };
    await this.db.channelConnection.update({
      where: { id: conn.id },
      data: { config: { ...config, [kind]: policy } as Prisma.InputJsonValue },
    });
    // The policy itself is read fresh per call, but the send-config cache
    // snapshots `config` — invalidate so every cached view converges.
    invalidateProviderConfig(session.workspaceId);
    return { policy: input.enabled ? policy : null };
  }

  /**
   * Resolve a call's stored recording for streaming. Same capability gate as
   * the call lists (a recording is the most sensitive call artifact there is)
   * plus the agent-visibility boundary via the conversation relation.
   */
  async getRecordingRef(
    session: ApiSession,
    callId: string,
  ): Promise<{ key: string; filename: string }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const call = await this.db.call.findFirst({
      where: {
        id: callId,
        workspaceId: session.workspaceId,
        ...conversationRelationWhere(session),
      },
      select: { id: true, recordingKey: true },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    if (!call.recordingKey) {
      throw new NotFoundException({ error: "no_recording" });
    }
    return { key: call.recordingKey, filename: `call-${call.id}.ogg` };
  }

  /** Team-scoped variant for the /v1 API (scope-gated by the caller). */
  async getRecordingRefForTeam(
    workspaceId: string,
    callId: string,
  ): Promise<{ key: string; filename: string }> {
    const call = await this.db.call.findFirst({
      where: { id: callId, workspaceId },
      select: { id: true, recordingKey: true },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    if (!call.recordingKey) {
      throw new NotFoundException({ error: "no_recording" });
    }
    return { key: call.recordingKey, filename: `call-${call.id}.ogg` };
  }

  /** Transcript document ref — same gates as the recording ref. */
  async getTranscriptRef(
    session: ApiSession,
    callId: string,
  ): Promise<{ key: string; filename: string }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const call = await this.db.call.findFirst({
      where: {
        id: callId,
        workspaceId: session.workspaceId,
        ...conversationRelationWhere(session),
      },
      select: { id: true, transcriptKey: true },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    if (!call.transcriptKey) {
      throw new NotFoundException({ error: "no_transcript" });
    }
    return { key: call.transcriptKey, filename: `call-${call.id}-transcript.json` };
  }

  /** Team-scoped transcript ref for the /v1 API. */
  async getTranscriptRefForTeam(
    workspaceId: string,
    callId: string,
  ): Promise<{ key: string; filename: string }> {
    const call = await this.db.call.findFirst({
      where: { id: callId, workspaceId },
      select: { id: true, transcriptKey: true },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    if (!call.transcriptKey) {
      throw new NotFoundException({ error: "no_transcript" });
    }
    return { key: call.transcriptKey, filename: `call-${call.id}-transcript.json` };
  }

  /**
   * Admin: upload a voicemail announcement recording and return the media id
   * the settings PATCH pins as `voicemail.announcementMediaId`.
   *
   * The mime gate is a pre-flight for the one hard, checkable provider rule
   * (audio/ogg OPUS); duration (<60s) is left to the provider — probing a
   * container server-side buys nothing over Meta's own clear rejection, which
   * the 502 detail already surfaces verbatim.
   */
  async uploadVoicemailAnnouncement(
    session: ApiSession,
    file: { bytes: Uint8Array; mimeType: string; filename: string },
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<{ mediaId: string }> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.uploadMedia;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_settings_unsupported",
        detail: `${channel} has no voicemail support.`,
      });
    }
    if (!file.mimeType.toLowerCase().startsWith("audio/ogg")) {
      throw new BadRequestException({
        error: "invalid_announcement_audio",
        detail:
          "The announcement must be an OGG (OPUS) audio file under 60 seconds.",
      });
    }
    const config = await binding.getSendConfig(session.workspaceId, accountId);
    try {
      const out = await fn(
        {
          ...file,
          useCase: "call_voicemail_announcement",
          description: "Voicemail announcement",
        },
        config,
      );
      return { mediaId: out.mediaId };
    } catch (err) {
      this.logger.warn(
        `uploadVoicemailAnnouncement failed for team=${session.workspaceId}: ${
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
   * Admin: the calling setup checklist.
   *
   * Every item is a real prerequisite that, when unmet, produces a confusing
   * failure rather than a clear one. The worst is the webhook subscription:
   * without it, enabling calling SUCCEEDS and calls place fine, but no
   * lifecycle webhook ever arrives — calls ring into a void with nothing in the
   * logs to explain it. Checking up front turns each of these into a sentence
   * an admin can act on.
   *
   * That webhook item was named here from the start and was the one item with no
   * check behind it, because Meta exposes no API to read an app's WhatsApp
   * webhook fields (see the `calls_webhook` block). It is now evidence-based
   * instead: proven subscribed, or not yet proven, with the dashboard path to
   * fix it. Two of these items therefore report a state rather than a pass/fail
   * — `quality_warning` is `ok: true` with a detail for the same reason — so
   * read `ready` as "nothing we can prove is broken", not "everything verified".
   */
  async getCallingReadiness(
    session: ApiSession,
    channel: Channel = "whatsapp",
    accountId?: string | null,
  ): Promise<CallingReadiness> {
    const checks: CallingReadinessCheck[] = [];

    // Business-initiated calling isn't offered in every market, and eligibility
    // follows OUR number's country. A team here can still RECEIVE calls.
    const businessCountry = await getBusinessNumberCountry(
      session.workspaceId,
      accountId,
    );
    const regionOk = isBicAllowedForBusinessNumber(businessCountry);
    checks.push({
      key: "region",
      ok: regionOk,
      label: "Outbound calling available in your number's country",
      detail: regionOk
        ? null
        : `Business-initiated calling isn't offered for ${businessCountry ?? "this"} numbers. You can still receive calls from customers.`,
    });

    // Meta requires a 2,000-recipient daily messaging limit before calling can
    // be enabled. We already track the tier from the broadcast work, so this
    // costs no extra call.
    const connection = await this.db.channelConnection.findFirst({
      where: accountId
        ? { id: accountId, workspaceId: session.workspaceId }
        : { workspaceId: session.workspaceId, channel, isDefault: true },
      select: {
        // Needed to scope the webhook-evidence counts below to THIS account.
        id: true,
        // Messaging limit is portfolio-scoped (Meta, 2025-10-07), reached through
        // the WABA — Meta records portfolio ownership on the WABA node.
        wabaAccount: {
          select: {
            portfolio: { select: { messagingDailyCap: true, messagingTier: true } },
          },
        },
        callingRestrictedUntil: true,
        callingRestrictionReason: true,
        callingQualityWarning: true,
      },
    });
    const cap = connection?.wabaAccount?.portfolio?.messagingDailyCap ?? null;
    // Unknown tier is NON-BLOCKING (we'd rather not gate a working setup on a
    // stat we haven't synced, and the provider enforces it regardless) — but it
    // must SAY unknown, not assert "2,000+ ✓". An unregistered number has no
    // tier at all, and rendering that as a confirmed pass told an operator the
    // requirement was met when nothing was known (same honesty rule as the
    // webhook-evidence check below, and the UNTIERED/"Unlimited" fix of
    // 2026-08-11).
    const tierOk = cap === null || cap >= 2000;
    checks.push({
      key: "messaging_limit",
      ok: tierOk,
      label:
        cap === null
          ? "Messaging limit of 2,000+ unique recipients (not confirmed)"
          : "Messaging limit of 2,000+ unique recipients",
      detail:
        cap === null
          ? "Not confirmed yet — Meta hasn't assigned or synced this portfolio's messaging " +
            "limit (an unregistered number has none). Calling requires the 2,000/day tier; " +
            "Meta enforces it when you enable calling, and this check firms up once health " +
            "syncs after registration."
          : tierOk
            ? null
            : `Your number is on ${connection?.wabaAccount?.portfolio?.messagingTier ?? "a lower tier"}. Calling requires a 2,000/day messaging limit — this rises automatically as your quality and volume grow.`,
    });

    // The provider's own view: is calling on, and is anything restricted?
    let settings: CallSettingsState | null = null;
    try {
      settings = await this.getCallSettings(session, channel, accountId);
    } catch {
      // Leave null — reported as "unknown" below rather than failing the whole
      // checklist on one unreachable read.
    }
    checks.push({
      key: "calling_enabled",
      ok: settings?.enabled ?? false,
      label: "Calling enabled on your business number",
      detail: settings
        ? settings.enabled
          ? null
          : "Turn calling on below to start placing and receiving calls."
        : "Couldn't read your calling settings — check that WhatsApp is still connected.",
    });
    // SIP signaling excludes the Graph calling endpoints this platform is
    // built on — a tenant (or partner) enabling it in WhatsApp Manager
    // silently breaks every place/answer here with nothing in our logs.
    // Named check so "calling randomly stopped" has a dated explanation.
    if (settings?.sipEnabled) {
      checks.push({
        key: "sip_disabled",
        ok: false,
        label: "SIP signaling is off (required for calling here)",
        detail:
          "SIP is enabled on this number, which disables the calling API this platform uses. Turn SIP off in WhatsApp Manager (Phone numbers → Calls) to place or receive calls here.",
      });
    }
    // THE `calls` WEBHOOK FIELD — the prerequisite this docblock has always
    // named as the worst one, and the only one that had no check.
    //
    // Meta: "To receive Calling API webhooks, subscribe to the 'calls' webhook
    // field." Without it, `POST /{phone}/calls` succeeds and the Call Connect
    // webhook carrying the SDP answer never arrives, so no call can ever be
    // established — the void this list exists to explain.
    //
    // It cannot be asserted against Graph. WhatsApp webhook FIELDS are app-wide
    // dashboard config, and `GET /{app-id}/subscriptions` — the only edge that
    // reads an app's subscriptions — takes `object` in
    // `enum{user, page, permissions, payments}` and states outright: "Webhooks
    // for WhatsApp is not supported. WhatsApp webhooks must be configured using
    // the App Dashboard." So there is no API answer to fetch, and inventing one
    // (reading `subscribed_apps`, which answers a per-WABA question) would
    // report a different fact under this label.
    //
    // What we DO have is evidence. `Call.answeredAt` is written in exactly one
    // place — `ingest-call.ts`, from a `calls` webhook — so a single non-null
    // value anywhere on this account is PROOF the field is subscribed. Nothing
    // else in the codebase can set it (`calls.service` only ever writes null,
    // and `stale-calls.ts` terminalizes without it).
    //
    // The absence of proof is NOT a failure, and this check deliberately never
    // fails the checklist: "we placed calls and none connected" is also what a
    // week of customers not picking up looks like, and a false "not ready" on a
    // working setup is the flapping alarm that trains admins to ignore the real
    // one. So it reports one of three states and leaves `ready` alone.
    const callScope = connection
      ? {
          workspaceId: session.workspaceId,
          channel,
          conversation: { channelConnectionId: connection.id },
        }
      : null;
    if (callScope) {
      const [confirmed, attempts] = await Promise.all([
        this.db.call.count({ where: { ...callScope, answeredAt: { not: null } } }),
        this.db.call.count({ where: callScope }),
      ]);
      checks.push({
        key: "calls_webhook",
        ok: true,
        label: "Call webhooks arriving from WhatsApp",
        detail:
          confirmed > 0
            ? null
            : attempts > 0
              ? `${attempts} call(s) on this number and not one has ever reported as answered, which is what a missing webhook subscription looks like. In the Meta App Dashboard → Webhooks → whatsapp_business_account, tick the \`calls\` field. SIP also suppresses these webhooks — see the SIP check if it appears above.`
              : "Not confirmed yet. Meta gives no API to read your app's webhook field list, so this confirms itself on your first answered call. If `calls` isn't ticked in the App Dashboard → Webhooks → whatsapp_business_account, calls will place successfully and then ring into a void.",
      });
    }

    // Same class of silent breakage: browser WebRTC only speaks DTLS-SRTP.
    // SDES set out-of-band makes every media negotiation fail while the
    // signaling still looks healthy. A warning, not a hard failure — the read
    // may lag a fix.
    if (
      settings?.srtpKeyExchangeProtocol &&
      settings.srtpKeyExchangeProtocol.toUpperCase() !== "DTLS"
    ) {
      checks.push({
        key: "srtp_dtls",
        ok: false,
        label: "Media encryption uses DTLS (required by browsers)",
        detail: `This number's SRTP key exchange is set to ${settings.srtpKeyExchangeProtocol}, which browsers can't negotiate — calls will connect signaling but carry no audio. Switch it back to DTLS.`,
      });
    }

    // Restrictions from two sources: whatever the provider reports right now,
    // and whatever its account webhook told us (which arrives the moment
    // enforcement starts, without waiting for someone to open this page).
    const liveRestriction = settings?.restrictions[0];
    const storedRestrictedUntil = connection?.callingRestrictedUntil ?? null;
    const storedActive =
      storedRestrictedUntil !== null &&
      storedRestrictedUntil.getTime() > Date.now();
    const restricted = Boolean(liveRestriction) || storedActive;
    checks.push({
      key: "not_restricted",
      ok: !restricted,
      label: "No calling restrictions active",
      detail: restricted
        ? liveRestriction
          ? `${liveRestriction.reason || liveRestriction.type}${
              liveRestriction.expiresAt
                ? ` Lifts ${liveRestriction.expiresAt.toISOString()}.`
                : ""
            }`
          : `${connection?.callingRestrictionReason ?? "Calling is paused on your number."}${
              storedRestrictedUntil
                ? ` Lifts ${storedRestrictedUntil.toISOString()}.`
                : ""
            }`
        : null,
    });
    // A warning is NOT a failure — calling still works. Surface it as a passing
    // check with a detail, so the admin can act before it becomes a pause.
    if (connection?.callingQualityWarning) {
      checks.push({
        key: "quality_warning",
        ok: true,
        label: "Call quality warning from WhatsApp",
        detail:
          "WhatsApp has flagged your call quality. Consider hiding call buttons or narrowing your call hours — repeated flags pause calling for 7 days.",
      });
    }

    const policies = await this.callArtifactPolicies(
      session.workspaceId,
      channel,
      accountId ?? null,
    );
    return {
      ready: checks.every((c) => c.ok),
      checks,
      settings,
      recordingPolicy: policies.recordingEnabled ? { enabled: true } : null,
      transcriptionPolicy: policies.transcriptionEnabled
        ? { enabled: true }
        : null,
    };
  }

  /**
   * In-app recording upload from the agent's browser. Called repeatedly
   * during the call (periodic flushes, each a fresh full-so-far file — crash
   * resilience without a chunk protocol) and once with `final=true` at
   * teardown, which triggers the OGG remux and, when the transcription
   * policy is on, the Whisper transcription.
   *
   * WORKSPACE-scoped like every live-call route (see answerCall's note), and
   * additionally gated on the number's artifact mode actually being "inapp" —
   * a browser can never push audio onto a call whose admin didn't choose
   * in-app recording.
   *
   * OWNERSHIP + LIFECYCLE are the real gates, and both are load-bearing. The
   * capability + workspace pair alone let ANY calls-capable session attach an
   * arbitrary audio file to ANY call in the workspace — including one that
   * ended weeks ago — and the bytes would be remuxed, transcribed and
   * published onto the thread as that call's recording. So the uploader must
   * be the agent ON the call (mirrors completeAccept), and the call must still
   * be live or inside the finalisation window.
   */
  async uploadInAppRecording(
    session: ApiSession,
    callId: string,
    file: { bytes: Uint8Array; mimeType: string },
    final: boolean,
  ): Promise<{ ok: true; stored: boolean }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const call = await this.db.call.findFirst({
      where: { id: callId, workspaceId: session.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        channel: true,
        status: true,
        endedAt: true,
        answeredByUserId: true,
        initiatedByUserId: true,
        conversation: { select: { channelConnectionId: true } },
      },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    // The agent whose browser is recording: the answerer on an inbound call,
    // the placer on an outbound one. Neither set ⇒ nobody owns the media leg,
    // so there is no legitimate uploader.
    const recordingAgentId = call.answeredByUserId ?? call.initiatedByUserId;
    if (!recordingAgentId || recordingAgentId !== session.userId) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    // Live, or finishing. The final upload fires at teardown and can land
    // AFTER the terminate webhook (it retries three times, and a long call is
    // a slow multipart), so a live-only gate would drop exactly the upload
    // that triggers the remux + transcription. Past the window it is no
    // longer a call in progress — it is a file being attached to history, and
    // the recovery sweeper owns anything left unfinished.
    const live =
      call.status === CallStatus.ringing || call.status === CallStatus.in_progress;
    const finalising =
      call.endedAt !== null &&
      Date.now() - call.endedAt.getTime() <= INAPP_RECORDING_UPLOAD_WINDOW_MS;
    if (!live && !finalising) {
      throw new ConflictException({ error: "call_not_live" });
    }
    const policies = await this.callArtifactPolicies(
      session.workspaceId,
      call.channel,
      call.conversation.channelConnectionId,
    );
    if (!policies.recordingEnabled && !policies.transcriptionEnabled) {
      throw new BadRequestException({ error: "inapp_recording_not_enabled" });
    }
    if (!file.bytes.length) {
      throw new BadRequestException({ error: "file_required" });
    }
    await storeInAppRecording(call.id, file, {
      final,
      transcribe: final && policies.transcriptionEnabled,
      // Transcription-only: the browser recorded because Whisper needs audio,
      // but this workspace turned call recording OFF — the bytes are dropped
      // once the transcript is written.
      retainRecording: policies.recordingEnabled,
    });
    return { ok: true, stored: true };
  }

  /**
   * Send an explicit permission request to the contact, from the standalone
   * POST /call-permission endpoint.
   *
   * The provider decides whether a request is allowed — it tracks the request
   * quota (and resets it when a call connects), so re-deriving those windows
   * locally could only ever disagree with it. If permission is already live we
   * return it without sending anything: re-asking a customer who already said
   * yes is both wasteful and annoying.
   */
  async requestPermission(
    session: ApiSession,
    conversationId: string,
  ): Promise<{ permissionRequestId: string; expiresAt: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId: session.workspaceId },
      select: {
        channel: true,
        // The thread's OWN account — calling permission is per business phone
        // number (mirrors requestPermissionForTeam): reading or requesting it
        // against the workspace default answers about a different number than
        // the one the customer is talking to.
        channelConnectionId: true,
        contact: { select: { id: true, phoneNumber: true, bsuid: true } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation_not_found" });
    const contact = conversation.contact;
    if (!contact?.phoneNumber && !contact?.bsuid) {
      throw new BadRequestException({
        error: "contact_has_no_phone_number_or_user_id",
      });
    }
    const identity = {
      ...(contact.phoneNumber ? { to: contact.phoneNumber } : {}),
      ...(contact.bsuid ? { recipient: contact.bsuid } : {}),
    };

    const binding = getProviderBinding(conversation.channel);
    const config = await binding.getSendConfig(
      session.workspaceId,
      conversation.channelConnectionId,
    );

    // Already permitted? Hand back the live grant rather than asking again.
    const readPermission = binding.provider.getCallPermission;
    if (readPermission) {
      const permission = await readPermission(identity, config);
      await this.syncPermissionCache(session.workspaceId, contact.id, permission);
      if (permission.hasPermission) {
        return {
          permissionRequestId: "",
          // A permanent grant has no expiry; surface the sentinel the caller
          // already understands rather than inventing a far-future date.
          expiresAt: permission.expiresAt?.toISOString() ?? "",
        };
      }
      if (!permission.canRequestPermission) {
        throw new ConflictException({ error: "permission_request_rate_limited" });
      }
    }

    const sendPerm = requireProviderMethod(
      binding.provider,
      "sendCallPermissionRequest",
      conversation.channel,
    );
    const out = await sendPerm(
      { ...identity, bodyText: CALL_PERMISSION_REQUEST_BODY },
      config,
    );
    await this.db.callPermissionRequest.create({
      data: {
        workspaceId: session.workspaceId,
        contactId: contact.id,
        externalRequestId: out.permissionRequestId,
        expiresAt: out.expiresAt,
        // Delivered, not granted. The customer still has to accept; their reply
        // webhook is what flips this to `granted`.
        status: CallPermissionStatus.pending,
      },
    });
    return {
      permissionRequestId: out.permissionRequestId,
      expiresAt: out.expiresAt.toISOString(),
    };
  }


  /**
   * Team-scoped permission request, for callers with no user session (the
   * external API). Same behaviour as the session route minus the session:
   * the provider decides whether a request is allowed, and a live grant is
   * returned rather than re-asking a customer who already said yes.
   */
  async requestPermissionForTeam(
    workspaceId: string,
    conversationId: string,
  ): Promise<{ permissionRequestId: string; expiresAt: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        channel: true,
        // The thread's OWN account — calling permission is per business phone
        // number, so reading or requesting it against the workspace default
        // answers about a different number than the customer is talking to.
        channelConnectionId: true,
        contact: { select: { id: true, phoneNumber: true, bsuid: true } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation_not_found" });
    const contact = conversation.contact;
    if (!contact?.phoneNumber && !contact?.bsuid) {
      throw new BadRequestException({
        error: "contact_has_no_phone_number_or_user_id",
      });
    }
    const identity = {
      ...(contact.phoneNumber ? { to: contact.phoneNumber } : {}),
      ...(contact.bsuid ? { recipient: contact.bsuid } : {}),
    };

    const binding = getProviderBinding(conversation.channel);
    const config = await binding.getSendConfig(
      workspaceId,
      conversation.channelConnectionId,
    );
    const readPermission = binding.provider.getCallPermission;
    if (readPermission) {
      const permission = await readPermission(identity, config);
      await this.syncPermissionCache(workspaceId, contact.id, permission);
      if (permission.hasPermission) {
        return {
          permissionRequestId: "",
          expiresAt: permission.expiresAt?.toISOString() ?? "",
        };
      }
      if (!permission.canRequestPermission) {
        throw new ConflictException({ error: "permission_request_rate_limited" });
      }
    }

    const sendPerm = requireProviderMethod(
      binding.provider,
      "sendCallPermissionRequest",
      conversation.channel,
    );
    const out = await sendPerm(
      { ...identity, bodyText: CALL_PERMISSION_REQUEST_BODY },
      config,
    );
    await this.db.callPermissionRequest.create({
      data: {
        workspaceId,
        contactId: contact.id,
        externalRequestId: out.permissionRequestId,
        expiresAt: out.expiresAt,
        status: CallPermissionStatus.pending,
      },
    });
    return {
      permissionRequestId: out.permissionRequestId,
      expiresAt: out.expiresAt.toISOString(),
    };
  }

  /**
   * Send a call button — a CTA that starts a call TO us when tapped.
   *
   * Needs no calling permission at all (the customer is the caller), which
   * makes it the right move for a cold contact: it also grants us callback
   * permission as a side effect once they use it.
   */
  async sendCallButtonForTeam(
    workspaceId: string,
    conversationId: string,
    input: {
      bodyText: string;
      displayText?: string;
      ttlMinutes?: number;
      payload?: string;
    },
    senderApiKeyId?: string | null,
  ): Promise<{ externalId: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { channel: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation_not_found" });
    const binding = getProviderBinding(conversation.channel);
    if (!binding.provider.capabilities.calling) {
      throw new BadRequestException({
        error: "calling_not_supported",
        detail: `Call buttons aren't available on ${conversation.channel}.`,
      });
    }
    // Through the SHARED interactive sender, not a bare provider call. This
    // used to send straight to Meta and return: no Message row, no
    // `message.sent` publish, so the customer got a call CTA that no agent
    // ever saw in the thread, with no audit row, no realtime frame, no
    // outbound webhook, and a conversation whose lastMessageAt never moved.
    // It also resolves the THREAD's account (channelConnectionId) rather than
    // the workspace default — a call button must come from the number the
    // customer is actually talking to.
    const out = await sendInteractiveInternal({
      workspaceId,
      conversationId,
      bodyText: input.bodyText,
      kind: "voice_call",
      options: [],
      voiceCall: {
        ...(input.displayText ? { displayText: input.displayText } : {}),
        ...(input.ttlMinutes != null ? { ttlMinutes: input.ttlMinutes } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
      },
      senderApiKeyId: senderApiKeyId ?? null,
      sentVia: "v1/call-button",
    });
    return { externalId: out.externalId };
  }

  /**
   * Fire a permission request as part of a call attempt. Best-effort: the
   * agent is told to wait either way, and a transient failure must not 5xx the
   * inbox's Call button. Returns whether the request actually went out, so the
   * caller can distinguish "we asked them" from "we couldn't".
   */
  private async tryRequestPermission(
    workspaceId: string,
    contactId: string,
    channel: Channel,
    identity: { to?: string; recipient?: string },
    // The thread's account — permission is per (business number, customer)
    // pair, so the request must go out the number the call would use.
    channelConnectionId?: string | null,
  ): Promise<boolean> {
    try {
      const binding = getProviderBinding(channel);
      const sendPerm = binding.provider.sendCallPermissionRequest;
      if (!sendPerm) return false;
      const config = await binding.getSendConfig(workspaceId, channelConnectionId);
      const out = await sendPerm(
        {
          ...(identity.to ? { to: identity.to } : {}),
          ...(identity.recipient ? { recipient: identity.recipient } : {}),
          bodyText: CALL_PERMISSION_REQUEST_BODY,
        },
        config,
      );
      await this.db.callPermissionRequest.create({
        data: {
          workspaceId,
          contactId,
          externalRequestId: out.permissionRequestId,
          expiresAt: out.expiresAt,
          status: CallPermissionStatus.pending,
        },
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `sendCallPermissionRequest failed for team=${workspaceId} contact=${contactId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return false;
    }
  }

  /**
   * Mirror the provider's permission verdict into our local rows.
   *
   * Purely a cache for the UI and the audit trail — nothing gates on it. It
   * exists so the contact panel can say "calls allowed until Friday" without a
   * provider round-trip per render, and so a grant the customer made outside
   * our request flow (by calling us, or from the business profile) still shows
   * up as a permission we know about. Best-effort: a failure here must never
   * fail the call that triggered it.
   */
  private async syncPermissionCache(
    workspaceId: string,
    contactId: string,
    permission: CallPermissionState,
  ): Promise<void> {
    try {
      if (permission.hasPermission) {
        // Clear any stale revocation and refresh/insert the cached grant.
        await this.db.contact.updateMany({
          where: { id: contactId, workspaceId },
          data: { callPermissionRevokedUntil: null },
        });
        const live = await this.db.callPermissionRequest.findFirst({
          where: {
            workspaceId,
            contactId,
            status: CallPermissionStatus.granted,
          },
          orderBy: { requestedAt: "desc" },
          select: { id: true },
        });
        const data = {
          status: CallPermissionStatus.granted,
          isPermanent: permission.status === "permanent",
          // Non-null column; a permanent grant's value is never read.
          expiresAt:
            permission.expiresAt ??
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        };
        if (live) {
          await this.db.callPermissionRequest.update({
            where: { id: live.id },
            data,
          });
        } else {
          await this.db.callPermissionRequest.create({
            data: { workspaceId, contactId, grantedAt: new Date(), ...data },
          });
        }
      } else {
        // Provider says no permission — retire any cached grant so the contact
        // panel stops claiming the customer allowed calls.
        await this.db.callPermissionRequest.updateMany({
          where: {
            workspaceId,
            contactId,
            status: CallPermissionStatus.granted,
          },
          data: { status: CallPermissionStatus.denied },
        });
      }
    } catch (err) {
      this.logger.warn(
        `permission cache sync failed for team=${workspaceId} contact=${contactId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /** Drop a cached grant the provider has just contradicted. Best-effort. */
  private async invalidatePermissionCache(
    workspaceId: string,
    contactId: string,
  ): Promise<void> {
    await this.db.callPermissionRequest
      .updateMany({
        where: { workspaceId, contactId, status: CallPermissionStatus.granted },
        data: { status: CallPermissionStatus.denied },
      })
      .catch(() => {
        // Cache-only; the provider remains the authority on the next attempt.
      });
  }

  /**
   * Accept an incoming call. CAS-gated so multiple agents racing each other on
   * the same incoming-call toast produce exactly one winner.
   *
   * This is only the FIRST half for WhatsApp: it issues `pre_accept`, which
   * lets the WebRTC connection establish. The browser then reports its
   * connection up and `completeAccept` issues the real `accept`. Splitting them
   * is the entire purpose of pre_accept — media must not flow until accept
   * returns, or the caller loses the first words of the call. Firing both
   * back-to-back (as this used to) defeats it.
   *
   * `acceptPending` in the response tells the browser whether it still owes a
   * completion call before unmuting.
   */
  async answerCall(
    session: ApiSession,
    callId: string,
    sdpAnswer: string,
  ): Promise<{
    ok: true;
    answeredByUserId: string;
    acceptPending: boolean;
    sdpAnswer?: string;
    sdpRenegotiation?: string;
    /** True ⇒ the browser records this call (in-app artifact mode). */
    recordInApp: boolean;
  }> {
    // WORKSPACE-scoped, NOT conversation-visibility-scoped, and that is
    // deliberate — but it was only documented on `endCall`, which made the
    // other call-id routes read like an oversight to a reviewer (it was
    // flagged as one). Writing the rule down at the entry point:
    //
    //   LIVE call handling is TEAM-WIDE. A ringing call fans out to the team
    //   room precisely because anyone free should be able to pick it up —
    //   that is how a phone works, and scoping it to the assignee would mean
    //   an unassigned or offline-owner call rings for nobody. Answer, reject,
    //   accept-media and hang-up therefore key on the workspace only.
    //
    //   Call HISTORY is visibility-scoped (`list`, `listTeamCalls`,
    //   `liveCount` all apply `conversationRelationWhere`) because that IS
    //   thread data, and a restricted agent must not read the call log of a
    //   thread they can't open.
    //
    // The one genuinely open question this leaves is the `call.incoming`
    // TOAST, which carries the contact's name and phone to the whole team
    // under `agentConversationVisibility: "assigned"`. Narrowing that is a
    // product decision (a call nobody can identify is hard to answer well),
    // so it is recorded in the ledger rather than changed here.
    const call = await this.db.call.findFirst({
      where: { id: callId, workspaceId: session.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        status: true,
        answeredByUserId: true,
        // contactId: for the customer-service-window bump after the provider
        // accepts — a connected inbound call opens the 24h window on the
        // CONTACT. channelConnectionId: the number the call lives on; every
        // Graph call action must hit that number's /calls endpoint, not the
        // workspace default's.
        conversation: { select: { contactId: true, channelConnectionId: true } },
      },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });

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
        // Defense-in-depth alongside the {id, workspaceId} gate above — a
        // future refactor that drops the gate must not be one line away from a
        // cross-tenant write (same posture as ConversationsService.remove).
        workspaceId: session.workspaceId,
        answeredByUserId: null,
        status: CallStatus.ringing,
        // Answer is incoming-only. Without pinning direction, a scripted client
        // could POST /answer with an OUTBOUND ringing callId — the CAS would
        // match, stamp answeredAt/answeredByUserId, Meta would reject pre_accept
        // for a business-initiated call, and the rollback would flip a live
        // outbound to `failed` while the customer's phone keeps ringing (no Meta
        // endCall is issued on this path). Mirrors markConnected's direction pin.
        direction: CallDirection.in,
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
    // WhatsApp: pre_accept only, carrying the browser's SDP ANSWER — the real
    // accept follows from completeAccept once media is up. Messenger: a single
    // accept carrying the browser's SDP OFFER, returning the answer (+
    // renegotiation) for the browser to apply. The adapter hides which;
    // `sdpAnswer` here is the browser's SDP either way.
    let answerResult: {
      sdpAnswer?: string;
      sdpRenegotiation?: string;
      acceptPending: boolean;
    };
    try {
      // Resolved INSIDE the try. The CAS above already flipped the row to
      // `in_progress`, and this call throws on missing/expired credentials or
      // an unresolved account in a multi-account workspace — which used to
      // escape uncaught, skipping the rollback block below and stranding the
      // row `in_progress` for the full 2h stale-call horizon while the whole
      // team saw a live call that never existed.
      const config = await binding.getSendConfig(
        session.workspaceId,
        call.conversation.channelConnectionId,
      );
      answerResult = await providerAnswerCall(binding.provider, call.channel, config, {
        externalCallId: call.externalCallId,
        sdp: sdpAnswer,
      });
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
          where: { id: callId, workspaceId: session.workspaceId, status: CallStatus.in_progress },
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
          workspaceId: session.workspaceId,
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

    // Customer-service window: answering a user-initiated call opens/resets
    // the 24h window (service-messages doc: "When a WhatsApp user messages you
    // or calls you, a 24-hour timer … starts") — stamped HERE, after the
    // provider accepted, so the agent can free-form reply DURING the call
    // instead of waiting for the terminate webhook. Monotonic, matching the
    // ingest-call bump and the contact-drift sweeper's recompute; the answer
    // CAS above pinned direction=in, so no outbound call reaches this line.
    await this.db.contact.updateMany({
      where: {
        id: call.conversation.contactId,
        workspaceId: session.workspaceId,
        OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: answeredAt } }],
      },
      data: { lastInboundAt: answeredAt },
    });

    await this.bus.publish({
      type: "call.answered_by_agent",
      workspaceId: session.workspaceId,
      conversationId: call.conversationId,
      callId: call.id,
      answeredByUserId: session.userId,
      answeredAt: answeredAt.toISOString(),
    });
    return {
      ok: true,
      answeredByUserId: session.userId,
      // True ⇒ the browser must call completeAccept once its peer connection
      // reports connected, and must stay muted until that returns.
      acceptPending: answerResult.acceptPending,
      // Messenger returns the SDP answer (+ optional renegotiation offer) from
      // the accept call for the browser to apply; WhatsApp's arrive via webhook.
      ...(answerResult.sdpAnswer ? { sdpAnswer: answerResult.sdpAnswer } : {}),
      ...(answerResult.sdpRenegotiation ? { sdpRenegotiation: answerResult.sdpRenegotiation } : {}),
      recordInApp: await (async () => {
        // Tell the browser to start its recorder for this call. Read here (not
        // at completeAccept) so recording covers the call from first media.
        const policies = await this.callArtifactPolicies(
          session.workspaceId,
          call.channel,
          call.conversation.channelConnectionId,
        );
        return policies.recordingEnabled || policies.transcriptionEnabled;
      })(),
    };
  }

  /**
   * Complete a WhatsApp accept. The browser calls this the moment its peer
   * connection reaches `connected`, and only starts sending audio after it
   * returns — that ordering is what stops the caller's first words being lost.
   *
   * Idempotent: the provider treats a repeated (call_id, accept) as a no-op, and
   * a call that has already gone terminal returns success rather than an error,
   * because there is nothing for the browser to do about it either way.
   */
  async completeAccept(
    session: ApiSession,
    callId: string,
    sdpAnswer: string,
  ): Promise<{ ok: true }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (!perms["calls:receive" as Capability]) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const call = await this.db.call.findFirst({
      where: { id: callId, workspaceId: session.workspaceId },
      select: {
        id: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        status: true,
        answeredByUserId: true,
        conversation: { select: { channelConnectionId: true } },
      },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    // Only the agent who won the answer race may complete it — the SDP belongs
    // to their peer connection, and accepting with someone else's would break
    // the media leg.
    if (call.answeredByUserId !== session.userId) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    if (call.status !== CallStatus.in_progress) return { ok: true };

    const binding = getProviderBinding(call.channel);
    try {
      // Resolved INSIDE the try — the state CAS above has already committed,
      // so a credential/account-resolution throw here must degrade through
      // this catch rather than escape and strand the row (see answerCall).
      const config = await binding.getSendConfig(
        session.workspaceId,
        call.conversation.channelConnectionId,
      );
      // Inbound accept: nothing artifact-related is attached to the provider
      // call and nothing is sent to the customer — the browser is already
      // recording (told by answerCall's `recordInApp`).
      await providerCompleteAccept(binding.provider, call.channel, config, {
        externalCallId: call.externalCallId,
        sdp: sdpAnswer,
        // Echoed (biz_opaque_callback_data) on the terminate webhook — same
        // opaque-cuid-only correlation as placeCall.
        correlationId: call.conversationId,
      });
    } catch (err) {
      this.logger.warn(
        `completeAccept provider error for call=${callId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      throw new HttpException({ error: "provider_rejected" }, 502);
    }
    return { ok: true };
  }

  /**
   * Relay a mid-call media renegotiation to the provider. Meta (Messenger) can
   * send a post-pickup `media_update` webhook carrying a new SDP OFFER; the
   * agent's browser answers it and POSTs that answer here, and we forward it via
   * the unified `media_update` action. Only meaningful on a LIVE call the team
   * owns, so it's workspaceId-scoped and gated on `in_progress`.
   *
   * Capability-gated the same way `endCall` is. This comment used to claim
   * parity with endCall while asserting "no extra capability" — but endCall
   * DOES check, and this route was the only calling endpoint with neither a
   * controller decorator nor a service check. That gap let any session in the
   * team, INCLUDING a role scoped entirely out of calling, relay
   * attacker-supplied SDP into a teammate's live call: call ids travel in
   * `call:*` socket frames and `GET /api/calls`, so they are easy to obtain.
   * Tenant isolation was never at risk (workspaceId is scoped); intra-tenant
   * authorization was.
   *
   * Returns any SDP the provider hands back for the browser to apply. WhatsApp
   * never reaches here (no live-renegotiation flow); the adapter throws for it
   * and we surface a clean 400.
   */
  async mediaUpdate(
    session: ApiSession,
    callId: string,
    sdp: string,
  ): Promise<{ ok: true; sdpAnswer?: string; sdpRenegotiation?: string }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const call = await this.db.call.findFirst({
      where: { id: callId, workspaceId: session.workspaceId },
      select: {
        id: true,
        externalCallId: true,
        channel: true,
        status: true,
        conversation: { select: { channelConnectionId: true } },
      },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });
    if (call.status !== CallStatus.in_progress) {
      throw new BadRequestException({ error: "call_not_in_progress" });
    }
    const binding = getProviderBinding(call.channel);
    let result: { sdpAnswer?: string; sdpRenegotiation?: string };
    try {
      // Resolved INSIDE the try — the state CAS above has already committed,
      // so a credential/account-resolution throw here must degrade through
      // this catch rather than escape and strand the row (see answerCall).
      const config = await binding.getSendConfig(
        session.workspaceId,
        call.conversation.channelConnectionId,
      );
      result = await providerMediaUpdate(binding.provider, call.channel, config, {
        externalCallId: call.externalCallId,
        sdp,
      });
    } catch (err) {
      this.logger.warn(
        `mediaUpdate provider error for call=${callId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      // A renegotiation failure doesn't terminate the call — the existing media
      // keeps flowing; surface a 400 so the browser can log/ignore without
      // tearing down a working call.
      throw new BadRequestException({ error: "media_update_failed" });
    }
    return {
      ok: true,
      ...(result.sdpAnswer ? { sdpAnswer: result.sdpAnswer } : {}),
      ...(result.sdpRenegotiation ? { sdpRenegotiation: result.sdpRenegotiation } : {}),
    };
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
      where: { id: callId, workspaceId: session.workspaceId },
      select: {
        id: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        status: true,
        conversation: { select: { channelConnectionId: true } },
      },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });

    const rejectedAt = new Date();
    const cas = await this.db.call.updateMany({
      // Incoming-only, same as answerCall: pin direction so a scripted /reject
      // on an OUTBOUND ringing callId can't flip a teammate's live outbound to
      // `rejected` (leaving the customer's phone ringing with no Meta-side
      // termination). Mirrors markConnected's direction pin.
      where: {
        id: callId,
        // Defense-in-depth alongside the {id, workspaceId} gate above.
        workspaceId: session.workspaceId,
        status: CallStatus.ringing,
        direction: CallDirection.in,
      },
      data: { status: CallStatus.rejected, endedAt: rejectedAt },
    });
    if (cas.count === 0) {
      // Either already answered (someone won the race) or already
      // terminal — idempotent success in either case.
      return { ok: true };
    }

    const binding = getProviderBinding(call.channel);
    try {
      // Resolved INSIDE the try — the state CAS above has already committed,
      // so a credential/account-resolution throw here must degrade through
      // this catch rather than escape and strand the row (see answerCall).
      const config = await binding.getSendConfig(
        session.workspaceId,
        call.conversation.channelConnectionId,
      );
      await providerRejectCall(binding.provider, call.channel, config, {
        externalCallId: call.externalCallId,
        ...(reason ? { reason } : {}),
      });
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
      workspaceId: session.workspaceId,
      conversationId: call.conversationId,
      callId: call.id,
      rejectedByUserId: session.userId,
      endedAt: rejectedAt.toISOString(),
    });
    return { ok: true };
  }

  /**
   * NOTE: there is deliberately no "mark outbound connected" endpoint.
   *
   * There used to be one, driven by the browser watching for inbound RTP and
   * declaring pickup when packets started flowing. That was built on the belief
   * that the provider gives no live pickup signal for business-initiated calls.
   * It does — the `ACCEPTED` call status webhook — and the browser heuristic
   * could be fooled by ringback tone into starting the timer and burning
   * connected-call quota on a call nobody answered.
   *
   * Pickup now has a single owner: the webhook ingest path
   * (`lib/providers/ingest-call.ts`), which stamps `answeredAt` from the
   * provider's own timestamp and publishes the answered frame. Do not
   * re-introduce a client-reported variant.
   */

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
      where: { id: callId, workspaceId: session.workspaceId },
      select: {
        id: true,
        conversationId: true,
        externalCallId: true,
        channel: true,
        direction: true,
        status: true,
        ringingAt: true,
        answeredAt: true,
        conversation: { select: { channelConnectionId: true } },
      },
    });
    if (!call) throw new NotFoundException({ error: "call_not_found" });

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
    //
    // Classify (missed vs completed + duration) and CAS ATOMICALLY: the CAS
    // pins `answeredAt` to the value we classified against. Without that pin, a
    // markConnected landing in the read→CAS gap stamps answeredAt AFTER our
    // read; our updateMany (matching status alone) would then write
    // status=missed onto a now-answered row — connected=true but status=missed,
    // a contradiction the later terminate webhook can't fix (alreadyTerminal
    // guard). If the pin misses on a still-non-terminal row, the discriminator
    // flipped under us: re-read once and retry so the decision matches the row
    // we actually overwrite. answeredAt is set-once, so one retry always settles.
    let answeredAt = call.answeredAt;
    // `= false` only satisfies definite-assignment (TS can't see the loop below
    // always runs once); the loop's first statement sets the real value.
    let wasConnected = false;
    let durationSeconds: number | null = null;
    let cas = { count: 0 };
    for (let attempt = 0; attempt < 2; attempt++) {
      wasConnected = answeredAt !== null;
      const terminalStatus = wasConnected
        ? CallStatus.completed
        : CallStatus.missed;
      durationSeconds = answeredAt
        ? Math.max(
            0,
            Math.floor((endedAt.getTime() - answeredAt.getTime()) / 1000),
          )
        : null;
      cas = await this.db.call.updateMany({
        where: {
          id: callId,
          // Defense-in-depth alongside the {id, workspaceId} gate above.
          workspaceId: session.workspaceId,
          status: { in: [CallStatus.ringing, CallStatus.in_progress] },
          answeredAt: wasConnected ? { not: null } : null,
        },
        data: {
          status: terminalStatus,
          endedAt,
          durationSeconds,
        },
      });
      if (cas.count > 0 || attempt === 1) break;
      // count 0 with the classification pin set: either the row went terminal
      // (webhook/race — idempotent OK below) or answeredAt flipped under us.
      // Re-read to distinguish; on a still-non-terminal row, reclassify + retry.
      const reread = await this.db.call.findFirst({
        where: { id: callId, workspaceId: session.workspaceId },
        select: { status: true, answeredAt: true },
      });
      if (
        !reread ||
        reread.status === CallStatus.completed ||
        reread.status === CallStatus.missed ||
        reread.status === CallStatus.rejected ||
        reread.status === CallStatus.failed
      ) {
        // Terminalized between read and write. Idempotent success.
        return { ok: true, durationSeconds: null };
      }
      answeredAt = reread.answeredAt;
    }
    if (cas.count === 0) {
      // Race lost — somebody (or a webhook) terminated it between read
      // and write. Idempotent success.
      return { ok: true, durationSeconds: null };
    }

    const binding = getProviderBinding(call.channel);
    try {
      // INSIDE the try. The terminal CAS above has already committed, so a
      // throw here used to skip the `call.ended` / `call.missed` publish
      // below entirely — row terminal in the DB, no terminal frame, so the
      // panel and the live badge never cleared until a manual refetch.
      // `getSendConfig` throws on missing or expired credentials, on a cache
      // blip, and (since the account-unresolved guard) whenever a
      // multi-account workspace resolves no account — none of which should
      // cost the operator a stuck call. The existing catch is already the
      // right handling: non-fatal, local state is what matters.
      const config = await binding.getSendConfig(
        session.workspaceId,
        call.conversation.channelConnectionId,
      );
      await providerEndCall(binding.provider, call.channel, config, {
        externalCallId: call.externalCallId,
      });
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
        workspaceId: session.workspaceId,
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
        workspaceId: session.workspaceId,
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
  ): Promise<{ items: ConversationCallRow[]; cursor: string | null }> {
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
      // Visibility boundary: a restricted agent can't read the call history of
      // a thread they can't open (404, same as missing).
      where: {
        id: conversationId,
        workspaceId: session.workspaceId,
        ...visibilityWhere(session),
      },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation_not_found" });

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
    // workspaceId is explicit (not just the conversationId FK) to match every other
    // call query in this service and keep the tenant scope visible at the row
    // level, not implied by the prior conversation lookup.
    const baseWhere: Prisma.CallWhereInput = {
      conversationId,
      workspaceId: session.workspaceId,
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
        ctaPayload: true,
        deeplinkPayload: true,
        recordingKey: true,
        transcriptKey: true,
        transcriptLanguage: true,
        errorTitle: true,
        // Attribution, resolved in the same query — the customer's call history
        // in the contact panel answers "who took this call" and "which of our
        // numbers", exactly like the team-wide Calls page. Without these the
        // panel would need a second round-trip per row to say anything useful.
        initiatedBy: { select: { name: true } },
        answeredBy: { select: { name: true } },
        conversation: {
          select: {
            channelConnectionId: true,
            channelConnection: {
              select: { id: true, label: true, config: true, externalAccountId: true },
            },
          },
        },
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const items: ConversationCallRow[] = page.map((c) => ({
      ...serializeCall(c),
      channel: c.channel,
      transcriptPending: deriveTranscriptPending({
        recordingKey: c.recordingKey,
        transcriptKey: c.transcriptKey,
        endedAt: c.endedAt,
        channelConnectionConfig: c.conversation.channelConnection?.config ?? null,
      }),
      initiatedByName: c.initiatedBy?.name ?? null,
      answeredByName: c.answeredBy?.name ?? null,
      connected:
        c.answeredAt !== null ||
        (c.durationSeconds !== null && c.durationSeconds > 0),
      accountId: c.conversation.channelConnectionId,
      accountName: channelAccountDisplayName(c.conversation.channelConnection),
    }));
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
    filters: { q?: string; from?: string; to?: string; page?: number; accountId?: string } = {},
  ): Promise<{ items: TeamCallRow[]; cursor: string | null; totalCount?: number }> {
    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (
      !perms["calls:make" as Capability] &&
      !perms["calls:receive" as Capability]
    ) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    // Numbered (offset) pagination: when `page` is set the UI drives discrete
    // pages, so we OFFSET into the ordered set and ignore the keyset cursor.
    const pageMode = filters.page != null && filters.page >= 1;
    const offset = pageMode ? (filters.page! - 1) * take : 0;
    const parsed = pageMode ? null : parseCallCursor(cursor);
    const cursorWhere: Prisma.CallWhereInput | undefined = parsed
      ? {
          OR: [
            { ringingAt: { lt: parsed.ringingAt } },
            { ringingAt: parsed.ringingAt, id: { lt: parsed.id } },
          ],
        }
      : undefined;
    // The team call log joins through to contact name + phone for every call
    // in the org, so it carries the same PII weight as the conversation list
    // and gets the same boundary.
    // The restricted-agent boundary, expressed as a nested `conversation`
    // filter. Kept as its own value so the search branch below can MERGE it
    // rather than clobber it.
    const visibility = conversationRelationWhere(session);
    const baseWhere: Prisma.CallWhereInput = {
      workspaceId: session.workspaceId,
      ...visibility,
    };

    // Free-text filter: substring on the contact's NAME or PHONE, reached
    // through the conversation→contact relation (the same join the select uses).
    // name is case-insensitive; phone is a raw substring (digits + leading +).
    const q = filters.q?.trim();
    if (q) {
      // MERGE, never REASSIGN: overwriting `baseWhere.conversation` outright
      // would delete `visibility.conversation.assignedUserId` and leak every
      // agent's call log to a restricted agent the moment they type in the
      // search box. Build one `conversation` filter carrying BOTH the
      // visibility restriction and the contact search, so they AND.
      const conversation: Prisma.ConversationWhereInput = {
        ...(visibility.conversation ?? {}),
        contact: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phoneNumber: { contains: q } },
          ],
        },
      };
      baseWhere.conversation = conversation;
    }

    // Account narrow. MERGED into the same `conversation` filter for exactly
    // the reason spelled out above: reassigning it would drop the visibility
    // restriction and hand a restricted agent every teammate's calls the
    // moment they picked a number. Composes with `q` too — both write through
    // the same object rather than each owning it.
    if (filters.accountId) {
      const conversation: Prisma.ConversationWhereInput = {
        ...((baseWhere.conversation as Prisma.ConversationWhereInput | undefined) ??
          visibility.conversation ??
          {}),
        channelConnectionId: filters.accountId,
      };
      baseWhere.conversation = conversation;
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
      // Offset mode fetches exactly `take` at `offset`; keyset mode fetches one
      // extra to detect `hasMore`.
      take: pageMode ? take : take + 1,
      ...(pageMode ? { skip: offset } : {}),
      select: {
        id: true,
        conversationId: true,
        direction: true,
        status: true,
        ringingAt: true,
        answeredAt: true,
        durationSeconds: true,
        ctaPayload: true,
        deeplinkPayload: true,
        endedAt: true,
        recordingKey: true,
        transcriptKey: true,
        transcriptLanguage: true,
        errorTitle: true,
        // The call's medium — lets the UI apply the same "only show the account
        // when this CHANNEL has more than one" rule as every other surface,
        // instead of inferring it from the current page of rows.
        channel: true,
        initiatedBy: { select: { id: true, name: true } },
        answeredBy: { select: { id: true, name: true } },
        conversation: {
          select: {
            contact: { select: { id: true, name: true, phoneNumber: true } },
            // WHICH of our numbers the call was on. A call log that can't tell
            // you that is unreadable on a multi-number workspace — two calls
            // from the same customer to two different numbers look identical.
            // The thread owns the account (Call has no column by design), and
            // every call action already resolves credentials through it.
            channelConnectionId: true,
            channelConnection: {
              select: { id: true, label: true, config: true, externalAccountId: true },
            },
          },
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
      ctaPayload: c.ctaPayload,
      deeplinkPayload: c.deeplinkPayload,
      hasRecording: c.recordingKey !== null,
      hasTranscript: c.transcriptKey !== null,
      transcriptLanguage: c.transcriptLanguage,
      transcriptPending: deriveTranscriptPending({
        recordingKey: c.recordingKey,
        transcriptKey: c.transcriptKey,
        endedAt: c.endedAt,
        channelConnectionConfig: c.conversation.channelConnection?.config ?? null,
      }),
      errorTitle: c.errorTitle,
      channel: c.channel,
      accountId: c.conversation.channelConnectionId,
      // Prefer the operator's label, fall back to the number itself — the row
      // needs something a human recognises, not a cuid. Null on a thread whose
      // account was disconnected (SetNull) or that predates account binding.
      accountName: channelAccountDisplayName(c.conversation.channelConnection),
    }));
    const last = page.at(-1);
    // Offset mode uses page numbers (from totalCount), not a cursor. The count
    // shares `baseWhere` (filters, no cursor) so it matches the filtered set.
    const nextCursor =
      !pageMode && hasMore && last ? `${last.ringingAt.getTime()}_${last.id}` : null;
    const totalCount = pageMode
      ? await this.db.call.count({ where: baseWhere })
      : undefined;
    return { items, cursor: nextCursor, totalCount };
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
        workspaceId: session.workspaceId,
        status: { in: [CallStatus.ringing, CallStatus.in_progress] },
        // A restricted agent must not infer colleagues' live-call volume from
        // the badge — scope the count to conversations they can see, same as
        // the list above.
        ...conversationRelationWhere(session),
      },
    });
    return { count };
  }
}

/**
 * Wire row for ONE conversation's call history — the contact panel's Calls tab.
 *
 * `SerializedCall` plus the same attribution the team-wide Calls page carries,
 * so both surfaces render from one component and can't drift. The contact's own
 * name/phone are deliberately absent: the panel is already scoped to them.
 */
export interface ConversationCallRow extends SerializedCall {
  channel: Channel;
  /** Derived "Transcribing…" state — transcription is ON for the number, the
   *  recording exists, the transcript doesn't, and the recovery sweeper is
   *  still inside its retry horizon. Live frames carry the same flag; this is
   *  what keeps it truthful across a reload. */
  transcriptPending: boolean;
  /** Agent who placed an outbound call (null for inbound). */
  initiatedByName: string | null;
  /** Agent who answered an inbound call (null if unanswered). */
  answeredByName: string | null;
  /** Did the two sides actually talk — the difference between "called" and
   *  "missed", which neither `status` nor `durationSeconds` says alone. */
  connected: boolean;
  /** WHICH of the workspace's accounts on this channel the call was on. */
  accountId: string | null;
  /** That account named for a human — the Settings label, else the number. */
  accountName: string | null;
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
  /** Opaque payload from the call BUTTON that produced an inbound call. */
  ctaPayload: string | null;
  /** Opaque `biz_payload` from the wa.me/call deep link that produced it. */
  deeplinkPayload: string | null;
  /** True once an opted-in recording is stored and streamable. */
  hasRecording: boolean;
  /** True once the opted-in transcript document is stored. */
  hasTranscript: boolean;
  /** Auto-detected spoken language of the transcript (ISO 639, e.g. "ar"). */
  transcriptLanguage: string | null;
  /** Derived "Transcribing…" state (see ConversationCallRow). */
  transcriptPending: boolean;
  /** Why a FAILED call failed, from the provider's terminate webhook. */
  errorTitle: string | null;
  /**
   * The call's channel.
   *
   * Needed so the UI can ask "does THIS channel have more than one account?"
   * — the same rule every other account label follows. Without it the calls
   * page had to infer multi-account from whichever accounts happened to appear
   * in the current page of 25 rows, so the attribution vanished and reappeared
   * as you paginated.
   */
  channel: Channel;
  /** WHICH of the workspace's accounts on this channel the call happened on —
   *  the thread's `channelConnectionId`. Null when the thread's account was
   *  disconnected (SetNull) or predates account binding. */
  accountId: string | null;
  /** That account, named for a human: the label set in Settings, else the
   *  number itself. The UI shows it only when the workspace has more than one
   *  account on the channel, so single-number workspaces see no new noise. */
  accountName: string | null;
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
  /** Opaque payload from the call BUTTON that produced this inbound call. */
  ctaPayload: string | null;
  /** Opaque `biz_payload` from the wa.me/call deep link that produced it. */
  deeplinkPayload: string | null;
  /** True once an opted-in recording is stored and streamable. */
  hasRecording: boolean;
  /** True once the opted-in transcript document is stored. */
  hasTranscript: boolean;
  /** Auto-detected spoken language of the transcript (ISO 639, e.g. "ar"). */
  transcriptLanguage: string | null;
  /** Why a FAILED call failed, from the provider's terminate webhook. */
  errorTitle: string | null;
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
  ctaPayload: string | null;
  deeplinkPayload: string | null;
  recordingKey: string | null;
  transcriptKey: string | null;
  transcriptLanguage: string | null;
  errorTitle: string | null;
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
    ctaPayload: row.ctaPayload,
    deeplinkPayload: row.deeplinkPayload,
    hasRecording: row.recordingKey !== null,
    hasTranscript: row.transcriptKey !== null,
    transcriptLanguage: row.transcriptLanguage,
    errorTitle: row.errorTitle,
  };
}
