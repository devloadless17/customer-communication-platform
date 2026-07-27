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
import { getBusinessNumberCountry } from "@/lib/providers/config";
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
  // The provider has PAUSED calling on our number entirely (negative feedback
  // or a low pickup rate). Distinct from rate_limited, which is per-customer:
  // this blocks every call until it lifts.
  | { ok: false; reason: "calling_restricted"; retryAt: string }
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
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const contact = conversation.contact;
    if (!contact) throw new BadRequestException({ error: "conversation has no contact" });

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
      const businessCountry = await getBusinessNumberCountry(session.workspaceId);
      if (!isBicAllowedForBusinessNumber(businessCountry)) {
        return { ok: false, reason: "bic_blocked_region" };
      }
    }

    // Provider-imposed pause on calling for this number (negative feedback or a
    // low pickup rate). Every attempt would fail anyway; refusing here gives the
    // agent the real reason and the date it lifts instead of a generic
    // rejection, and avoids adding failed attempts to the record that caused it.
    const restriction = await this.db.channelConnection.findFirst({
      where: { workspaceId: session.workspaceId, channel: channelForCall, isDefault: true },
      select: { callingRestrictedUntil: true },
    });
    if (
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
      sendConfig = await binding.getSendConfig(session.workspaceId);
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
    try {
      placed = await providerPlaceCall(binding.provider, channelForCall, sendConfig, {
        ...(to ? { to } : {}),
        ...(recipient ? { recipient } : {}),
        sdpOffer,
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
          const cfg = await binding.getSendConfig(session.workspaceId);
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
  ): Promise<{ raw: unknown }> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.getPhoneNumberSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "provider does not support getPhoneNumberSettings",
      });
    }
    const config = await binding.getSendConfig(session.workspaceId);
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
  ): Promise<{ ok: true; raw: unknown }> {
    // Only calling-capable channels expose enableCalling (WhatsApp: enable Cloud
    // API Calling; Messenger: route inbound calls to us + show the call icon).
    if (!getProviderBinding(channel).provider.capabilities.calling) {
      throw new BadRequestException({
        error: "channel does not support calling",
        detail: `${channel} has no calling capability.`,
      });
    }
    const binding = getProviderBinding(channel);
    const fn = binding.provider.enableCalling;
    if (!fn) {
      throw new BadRequestException({
        error: "provider does not support enableCalling",
      });
    }
    const config = await binding.getSendConfig(session.workspaceId);
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
  ): Promise<CallSettingsState> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.getCallSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_settings_unsupported",
        detail: `${channel} has no configurable calling settings.`,
      });
    }
    const config = await binding.getSendConfig(session.workspaceId);
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
  ): Promise<CallSettingsState> {
    const binding = getProviderBinding(channel);
    const fn = binding.provider.updateCallSettings;
    if (!fn) {
      throw new BadRequestException({
        error: "calling_settings_unsupported",
        detail: `${channel} has no configurable calling settings.`,
      });
    }
    const config = await binding.getSendConfig(session.workspaceId);
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
   * Admin: the calling setup checklist.
   *
   * Every item is a real prerequisite that, when unmet, produces a confusing
   * failure rather than a clear one. The worst is the webhook subscription:
   * without it, enabling calling SUCCEEDS and calls place fine, but no
   * lifecycle webhook ever arrives — calls ring into a void with nothing in the
   * logs to explain it. Checking up front turns each of these into a sentence
   * an admin can act on.
   */
  async getCallingReadiness(
    session: ApiSession,
    channel: Channel = "whatsapp",
  ): Promise<CallingReadiness> {
    const checks: CallingReadinessCheck[] = [];

    // Business-initiated calling isn't offered in every market, and eligibility
    // follows OUR number's country. A team here can still RECEIVE calls.
    const businessCountry = await getBusinessNumberCountry(session.workspaceId);
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
      where: { workspaceId: session.workspaceId, channel, isDefault: true },
      select: {
        // Messaging limit is portfolio-scoped (Meta, 2025-10-07).
        portfolio: { select: { messagingDailyCap: true, messagingTier: true } },
        callingRestrictedUntil: true,
        callingRestrictionReason: true,
        callingQualityWarning: true,
      },
    });
    const cap = connection?.portfolio?.messagingDailyCap ?? null;
    // Unknown tier is reported as met rather than failed: we'd rather not block
    // a working setup on a stat we haven't synced yet, and the provider
    // enforces it regardless.
    const tierOk = cap === null || cap >= 2000;
    checks.push({
      key: "messaging_limit",
      ok: tierOk,
      label: "Messaging limit of 2,000+ unique recipients",
      detail: tierOk
        ? null
        : `Your number is on ${connection?.portfolio?.messagingTier ?? "a lower tier"}. Calling requires a 2,000/day messaging limit — this rises automatically as your quality and volume grow.`,
    });

    // The provider's own view: is calling on, and is anything restricted?
    let settings: CallSettingsState | null = null;
    try {
      settings = await this.getCallSettings(session, channel);
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

    return {
      ready: checks.every((c) => c.ok),
      checks,
      settings,
    };
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
        contact: { select: { id: true, phoneNumber: true, bsuid: true } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const contact = conversation.contact;
    if (!contact?.phoneNumber && !contact?.bsuid) {
      throw new BadRequestException({
        error: "contact has no phone number or user id",
      });
    }
    const identity = {
      ...(contact.phoneNumber ? { to: contact.phoneNumber } : {}),
      ...(contact.bsuid ? { recipient: contact.bsuid } : {}),
    };

    const binding = getProviderBinding(conversation.channel);
    const config = await binding.getSendConfig(session.workspaceId);

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
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const contact = conversation.contact;
    if (!contact?.phoneNumber && !contact?.bsuid) {
      throw new BadRequestException({
        error: "contact has no phone number or user id",
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
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
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
  ): Promise<boolean> {
    try {
      const binding = getProviderBinding(channel);
      const sendPerm = binding.provider.sendCallPermissionRequest;
      if (!sendPerm) return false;
      const config = await binding.getSendConfig(workspaceId);
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
  }> {
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
    const config = await binding.getSendConfig(session.workspaceId);
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
        externalCallId: true,
        channel: true,
        status: true,
        answeredByUserId: true,
      },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });
    // Only the agent who won the answer race may complete it — the SDP belongs
    // to their peer connection, and accepting with someone else's would break
    // the media leg.
    if (call.answeredByUserId !== session.userId) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    if (call.status !== CallStatus.in_progress) return { ok: true };

    const binding = getProviderBinding(call.channel);
    const config = await binding.getSendConfig(session.workspaceId);
    try {
      await providerCompleteAccept(binding.provider, call.channel, config, {
        externalCallId: call.externalCallId,
        sdp: sdpAnswer,
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
      },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });
    if (call.status !== CallStatus.in_progress) {
      throw new BadRequestException({ error: "call_not_in_progress" });
    }
    const binding = getProviderBinding(call.channel);
    const config = await binding.getSendConfig(session.workspaceId);
    let result: { sdpAnswer?: string; sdpRenegotiation?: string };
    try {
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
      },
    });
    if (!call) throw new NotFoundException({ error: "call not found" });

    const rejectedAt = new Date();
    const cas = await this.db.call.updateMany({
      // Incoming-only, same as answerCall: pin direction so a scripted /reject
      // on an OUTBOUND ringing callId can't flip a teammate's live outbound to
      // `rejected` (leaving the customer's phone ringing with no Meta-side
      // termination). Mirrors markConnected's direction pin.
      where: {
        id: callId,
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
    const config = await binding.getSendConfig(session.workspaceId);
    try {
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
    const config = await binding.getSendConfig(session.workspaceId);
    try {
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
      // Visibility boundary: a restricted agent can't read the call history of
      // a thread they can't open (404, same as missing).
      where: {
        id: conversationId,
        workspaceId: session.workspaceId,
        ...visibilityWhere(session),
      },
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
    filters: { q?: string; from?: string; to?: string; page?: number } = {},
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
