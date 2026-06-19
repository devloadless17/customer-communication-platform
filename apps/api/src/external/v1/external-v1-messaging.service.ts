import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import {
  conversationRowToExternal,
  toExternalMessage,
  EXTERNAL_CONVERSATION_INCLUDE,
  type ExternalMessage,
} from "@/lib/external-shapes";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { MAX_CHAIN_DEPTH } from "@/lib/workflows/events";

import {
  sendTemplateInternal,
  SendTemplateValidationError,
} from "@/lib/messaging/send-template-internal";
import {
  consumeConversationSendBudget,
  ConversationSendRateLimitedError,
} from "@/lib/messaging/conversation-send-budget";
import { getProviderBinding } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { encodeConvoCursor, parseConvoCursor } from "@/lib/queries/_cursors";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import type { Message, Channel } from "@ccp/shared/types";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { computeWindowStatus } from "@ccp/shared/utils/window";
import {
  assignConversation,
  setConversationStatus,
  setConversationAiEnabled,
} from "@/lib/conversations/mutations";
import { pickRoundRobinAssignee } from "@/lib/conversations/round-robin";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import { ApiIdempotencyService } from "./api-idempotency.service";
import type {
  ExternalAssignInput,
  ExternalContactAssignInput,
  ExternalContactStatusInput,
  ExternalNoteInput,
  ExternalSendMessageInput,
  ExternalStatusInput,
  ExternalSetAiInput,
  ExternalTopLevelSendMessageInput,
  ListConversationsQueryInput,
  ListMessagesQueryInput,
} from "./external-v1.schemas";

/**
 * Extracted from the original `external-v1.service.ts` to keep file sizes
 * tractable. Holds every conversation-/message-/note-/send-shaped route on
 * the external `/v1` surface; the parent `ExternalV1Service` delegates to
 * an instance of this class via DI.
 *
 * No behavior changes vs the previous monolith — same event publish shapes,
 * same audit-attribution discipline (`changedByApiKeyId` / `senderApiKeyId`
 * threaded through every domain event the partner triggers).
 */
@Injectable()
export class ExternalV1MessagingService {
  private readonly logger = new Logger(ExternalV1MessagingService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly idem: ApiIdempotencyService,
  ) {}

  // ===========================================================================
  // IDEMPOTENCY (thin delegates to the shared ApiIdempotencyService)
  // ===========================================================================
  //
  // The actual claim/complete/release logic now lives in
  // `ApiIdempotencyService` so the NON-send mutations (assign / status / tag /
  // contact-update, in the sibling ExternalV1Service) reuse the exact same
  // implementation. These thin wrappers keep the existing send-path call sites
  // (sendMessage / sendTopLevelMessage below) unchanged.

  private claimIdempotency<T>(
    teamId: string,
    apiKeyId: string,
    key: string,
    requestHash: string,
    opts?: { refuseStaleOnAmbiguity?: boolean },
  ): Promise<{ kind: "claimed" } | { kind: "replay"; result: T }> {
    return this.idem.claim<T>(teamId, apiKeyId, key, requestHash, opts);
  }

  private completeIdempotency<T>(
    teamId: string,
    apiKeyId: string,
    key: string,
    result: T,
  ): Promise<void> {
    return this.idem.complete<T>(teamId, apiKeyId, key, result);
  }

  private releaseIdempotency(
    teamId: string,
    apiKeyId: string,
    key: string,
  ): Promise<void> {
    return this.idem.release(teamId, apiKeyId, key);
  }

  // ===========================================================================
  // CONVERSATIONS
  // ===========================================================================

  async listConversations(teamId: string, q: ListConversationsQueryInput) {
    // API-1: keyset cursor over the COMPOSITE (lastMessageAt, id) sort, not a
    // bare `cursor:{id}, skip:1`. `lastMessageAt` is mutable (every inbound /
    // outbound bumps it), so the old id-cursor over a moving sort key silently
    // SKIPPED or DUPLICATED rows during a partner's full export of a busy
    // tenant. Mirrors the internal inbox list (lib/queries/conversations.ts).
    // API-3: normalize the phone filter (same as /contacts) so "+1 555…" and
    // "15550000" match the stored E.164 form.
    const cursor = parseConvoCursor(q.cursor ?? null);
    const phone = q.phone ? normalizePhoneE164(q.phone) ?? q.phone : null;
    const rows = await this.db.conversation.findMany({
      where: {
        teamId,
        ...(q.status ? { status: q.status } : {}),
        ...(phone ? { contact: { phoneNumber: phone } } : {}),
        ...(cursor
          ? {
              OR: [
                { lastMessageAt: { lt: cursor.lastMessageAt } },
                { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: EXTERNAL_CONVERSATION_INCLUDE,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const items = page.map(conversationRowToExternal);
    const lastRow = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && lastRow
        ? encodeConvoCursor({ lastMessageAt: lastRow.lastMessageAt, id: lastRow.id })
        : null;
    return { items, nextCursor };
  }

  async getConversation(teamId: string, id: string) {
    const row = await this.db.conversation.findFirst({
      where: { id, teamId },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    if (!row) throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });
    // `conversation.contact` is embedded; the top-level `contact` is kept as a
    // convenience alias so the single-conversation response still surfaces it
    // at the root for callers that read response.contact directly.
    const conversation = conversationRowToExternal(row);
    return { conversation, contact: conversation.contact };
  }

  async assign(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    // Idempotency — a partner retry of the same assign (n8n re-firing on a
    // timeout) must not re-publish conversation.assigned + re-trigger workflows
    // / webhooks. CLAIM-then-execute via the shared service (F2 in
    // docs/audit-guide.md). A replay returns the prior
    // { ok: true } with zero side effects.
    if (idempotencyKey) {
      const claim = await this.idem.claim<{ ok: true }>(
        teamId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("assign", {
          conversationId,
          assignedUserId: input.assignedUserId,
        }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.assignInternal(teamId, apiKeyId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(teamId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(teamId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async assignInternal(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
  ): Promise<{ ok: true }> {
    // Shared business rule (member validation, CAS on assignee+status,
    // status-flip on assign-to-closed → pending, gated event publishing) lives
    // in lib/conversations/mutations.ts so a partner /v1 POST, a UI click, and
    // a workflow step all produce the IDENTICAL end state. Previously this
    // route flipped assign-to-closed → "open" (a drift); it now matches the
    // others (→ pending; assignment never sets "open" — only chatting does).
    // `changedByApiKeyId` threads partner attribution; `silent` skips workflow
    // re-trigger + webhook echo.
    const result = await assignConversation({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      targetUserId: input.assignedUserId,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      silent: input.silent === true,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });
      }
      if (result.reason === "invalid_user") {
        throw new BadRequestException({ error: "user_not_in_team", detail: "user not in team" });
      }
      throw new ConflictException({
        error: "write_conflict",
        detail: "conversation was reassigned by someone else",
      });
    }
    return { ok: true };
  }

  async setStatus(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    // Idempotency — see assign(). A retry must not re-publish
    // conversation.status_changed (+ the unassign-on-close cascade).
    if (idempotencyKey) {
      const claim = await this.idem.claim<{ ok: true }>(
        teamId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("set_status", { conversationId, status: input.status }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.setStatusInternal(teamId, apiKeyId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(teamId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(teamId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async setStatusInternal(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
  ): Promise<{ ok: true }> {
    // Shared business rule (CAS, unassign-on-close, event publishing) lives in
    // lib/conversations/mutations.ts so a /v1 close matches the inbox UI + the
    // workflow close step exactly. (Also tightens the update with a status CAS
    // + teamId guard the old hand-rolled version lacked.) `changedByApiKeyId`
    // threads partner attribution; `silent` skips workflow re-trigger + echo.
    const result = await setConversationStatus({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      status: input.status,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      silent: input.silent === true,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });
      }
      throw new ConflictException({
        error: "write_conflict",
        detail: "conversation status changed by someone else",
      });
    }
    return { ok: true };
  }

  async setAiEnabled(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSetAiInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    // Idempotency — see setStatus(). A retry must not re-publish ai_changed.
    if (idempotencyKey) {
      const claim = await this.idem.claim<{ ok: true }>(
        teamId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("set_ai", { conversationId, aiEnabled: input.aiEnabled }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.setAiEnabledInternal(teamId, apiKeyId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(teamId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(teamId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async setAiEnabledInternal(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSetAiInput,
  ): Promise<{ ok: true }> {
    // Same shared CAS + publish as the inbox toggle. `silent` defaults true-ish
    // intent for the AI's self-pause (skip the outbound webhook echo so the AI
    // doesn't get its own ai_changed delivery back); honored as supplied.
    const result = await setConversationAiEnabled({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      aiEnabled: input.aiEnabled,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      silent: input.silent === true,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });
      }
      throw new ConflictException({
        error: "write_conflict",
        detail: "conversation ai setting changed by someone else",
      });
    }

    // Customer-initiated handoff: run the team's configured assignment action
    // when the AI is paused via THIS route. This endpoint is only ever hit by
    // the AI flow's "human" branch (the agent inbox toggle uses the session
    // route, auto-pause-on-reply uses the internal mutation) — so applying the
    // handoff here is the DEFAULT, not opt-in, and works with the existing n8n
    // body `{aiEnabled:false, silent:true}` with no flow changes. Send
    // `applyHandoffPolicy:false` to explicitly opt a call out. Gated on
    // `changed` so a retry / already-paused thread doesn't churn assignment.
    // Best-effort — the critical action (AI off) already succeeded, so a failure
    // here degrades to "paused but unassigned", never an error to the partner.
    const applyHandoff = input.applyHandoffPolicy !== false;
    if (applyHandoff && result.changed && input.aiEnabled === false) {
      await this.runHandoffPolicy(teamId, apiKeyId, conversationId).catch((err) => {
        this.logger.warn(
          `handoff policy failed for conversation ${conversationId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    }
    return { ok: true };
  }

  /**
   * Apply the team's configured customer-handoff action after the AI was paused
   * by the customer. Routes every action through the shared `assignConversation`
   * mutation so `conversation.assigned` fires and the inbox updates live (same
   * realtime/audit/analytics path as a manual assign). System actor
   * (changedByUserId null), attributed to the calling API key.
   */
  private async runHandoffPolicy(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
  ): Promise<void> {
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { aiHandoffAction: true, aiHandoffAssigneeId: true },
    });
    if (!team || team.aiHandoffAction === "none") return;

    let targetUserId: string | null = null;
    if (team.aiHandoffAction === "assign_fixed") {
      targetUserId = team.aiHandoffAssigneeId;
      if (!targetUserId) return; // misconfigured (no member set) → leave as-is
    } else if (team.aiHandoffAction === "round_robin") {
      targetUserId = await pickRoundRobinAssignee({ db: this.db, teamId });
      if (!targetUserId) return; // no eligible agent → leave unassigned
    }
    // "unassign" falls through with targetUserId = null.

    const assigned = await assignConversation({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      targetUserId,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
    });

    // A configured fixed assignee who's been deactivated/removed → don't fail
    // the handoff; fall back to leaving the thread unassigned for triage.
    if (!assigned.ok && "reason" in assigned && assigned.reason === "invalid_user") {
      this.logger.warn(
        `handoff assign_fixed target ${targetUserId} invalid for team ${teamId}; leaving unassigned`,
      );
      await assignConversation({
        db: this.db,
        publish: (e) => this.bus.publish(e),
        teamId,
        conversationId,
        targetUserId: null,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
      });
    }
  }

  // ===========================================================================
  // MESSAGES
  // ===========================================================================

  async listMessages(
    teamId: string,
    conversationId: string,
    q: ListMessagesQueryInput,
  ) {
    // The existence check doubles as the conversation context we return
    // alongside the messages, so a page of messages always tells the caller
    // who the thread is with (contact + assignee embedded) without a separate
    // GET /v1/conversations/:id.
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    if (!conv) throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });

    const rows = await this.db.message.findMany({
      where: { conversationId },
      // Select EXACTLY the columns toExternalMessage reads — not `omit:
      // rawPayload`, which still ships ~15 unused columns (reply FKs, error
      // strings, teamId, audit timestamps) per row on this partner-pollable
      // export endpoint. The compiler enforces this set stays in sync with the
      // mapper: drop a field the mapper reads and `toExternalMessage(row)`
      // below fails to typecheck.
      select: {
        id: true,
        conversationId: true,
        externalId: true,
        channel: true,
        direction: true,
        body: true,
        status: true,
        timestamp: true,
        senderUserId: true,
        mediaKind: true,
        mediaUrl: true,
        mediaMimeType: true,
        mediaFilename: true,
        mediaSizeBytes: true,
        mediaDurationMs: true,
        mediaThumbnailUrl: true,
        mediaCaption: true,
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalMessage);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { conversation: conversationRowToExternal(conv), items, nextCursor };
  }

  async findMessage(teamId: string, id: string) {
    const row = await this.db.message.findFirst({
      where: { id, teamId },
      omit: { rawPayload: true },
      // Embed the parent conversation (which itself embeds contact + assignee)
      // so a single message fetch carries who it's with — no follow-up call.
      include: { conversation: { include: EXTERNAL_CONVERSATION_INCLUDE } },
    });
    if (!row) throw new NotFoundException({ error: "message_not_found", detail: "message not found" });
    return {
      message: toExternalMessage(row),
      conversation: conversationRowToExternal(row.conversation),
    };
  }

  async sendMessage(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    /** Optional idempotency key from the `Idempotency-Key` request header. */
    idempotencyKey?: string,
    /**
     * Inbound `X-CCP-Depth`. When a partner forwards our outbound webhook
     * payload back into /v1, the header rides along. Drop early at the
     * cross-system ceiling so the http_request -> partner -> /v1 send ->
     * message.sent -> workflow -> http_request loop can't sustain. Shares
     * the ceiling (MAX_CHAIN_DEPTH) with the incoming_webhook trigger.
     */
    chainDepth?: number,
  ) {
    if (chainDepth !== undefined && chainDepth >= MAX_CHAIN_DEPTH) {
      throw new HttpException(
        {
          error: "chain_depth_exceeded",
          detail:
            `inbound X-CCP-Depth ${chainDepth} >= ${MAX_CHAIN_DEPTH} — request dropped to ` +
            "break a likely cross-system loop (our outbound webhooks return X-CCP-Depth; " +
            "a partner integration that calls /v1 send on every webhook must respect the " +
            "cap when forwarding the header).",
        },
        429,
      );
    }
    // Idempotency-Key is MANDATORY on send routes (OUTBOUND-1): a Meta send is
    // irreversible + billed, and a partner HTTP client retrying on a 5xx/timeout
    // with no key would double-send (deduped only by externalId AFTER Meta
    // already charged + delivered twice). n8n/Zapier omit it by default, so the
    // contract must require it.
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: "idempotency_key_required",
        detail:
          "Send routes require an Idempotency-Key header (a unique id per distinct " +
          "send) so a network retry can't double-send a billed message.",
      });
    }
    // Idempotency — CLAIM-then-execute via the shared `claimIdempotency`
    // helper (also used by the template path so the two can't drift). A
    // replay returns the prior response with zero side effects; a fresh
    // claim means we own the pending row and MUST resolve it below
    // (releaseIdempotency on any failure, completeIdempotency on success).
    // `refuseStaleOnAmbiguity` so a crashed-mid-send pending row past TTL is
    // NOT auto-cleared into a re-send (OUTBOUND-1).
    {
      const claim = await this.claimIdempotency<{ message: ExternalMessage }>(
        teamId,
        apiKeyId,
        idempotencyKey,
        requestFingerprint("send_message", {
          conversationId,
          body: input.body,
          replyToMessageId: input.replyToMessageId ?? null,
          onlyIfAiEnabled: input.onlyIfAiEnabled ?? false,
        }),
        { refuseStaleOnAmbiguity: true },
      );
      if (claim.kind === "replay") return claim.result;
    }

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        contactId: true,
        // Channel is conversation-owned — bind + stamp from here.
        channel: true,
        aiEnabled: true,
        contact: {
          select: {
            phoneNumber: true,
            identityChannel: true,
            externalContactId: true,
            lastInboundAt: true,
          },
        },
      },
    });
    if (!conversation) {
      // Provably-not-sent validation failure — release the claim so it doesn't
      // strand a pending row (which, with refuseStaleOnAmbiguity, would wrongly
      // block a corrected retry after TTL) — API-2.
      if (idempotencyKey) await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
      throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });
    }

    // No-interrupt guard. When the AI flow sets `onlyIfAiEnabled`, send ONLY if
    // AI Autopilot is still on for this conversation. This closes the race
    // where a human (or the customer typing "human") takes over WHILE the AI is
    // mid-generation: the AI's queued reply must NOT land on top of a live
    // human↔customer chat. Checked right before the send (ms window, vs the
    // seconds-long client GET re-check), and we release the idempotency claim
    // so a legitimate later send can reuse the key. Returns 200 {skipped} so
    // n8n treats it as a clean no-op, not a retryable error.
    if (input.onlyIfAiEnabled && conversation.aiEnabled === false) {
      if (idempotencyKey) await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
      return { message: null, skipped: "ai_disabled" as const };
    }

    let channel;
    try {
      channel = resolveContactChannel(conversation.contact);
    } catch (err) {
      if (err instanceof NoChannelDestinationError) {
        if (idempotencyKey) await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
        throw new BadRequestException({
          error: "contact_has_no_phone",
          detail: "This contact has no reachable address.",
        });
      }
      throw err;
    }
    const provider = conversation.channel;
    const binding = getProviderBinding(provider);

    // Free-form send window — driven by the provider capability; `null` skips
    // it (channel with no window restriction).
    const windowMs = binding.provider.capabilities.freeFormWindowMs;
    if (windowMs !== null) {
      const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        if (idempotencyKey) await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail:
            "free-form messages are only allowed within 24h of the contact's last inbound. " +
            "use a pre-approved template for cold outbound (not yet exposed via the external API).",
          lastInboundAt,
        });
      }
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (input.replyToMessageId) {
      const replyRow = await this.db.message.findFirst({
        where: { id: input.replyToMessageId, conversationId, teamId },
        select: { id: true, externalId: true },
      });
      if (!replyRow) {
        // Previously silently dropped — partner thought their reply was
        // quoted but the message went out as a top-level send. Surface
        // the failure so they can see the bad id in their automation logs.
        if (idempotencyKey) await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
        throw new BadRequestException({
          error: "reply_target_not_found",
          detail:
            "replyToMessageId does not match a message in this conversation. " +
            "It may have been deleted, belongs to a different conversation, or " +
            "is owned by a different team.",
        });
      }
      replyToMessageId = replyRow.id;
      if (!replyRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyRow.externalId;
      }
    }


    // Per-conversation send ceiling. Bounds a partner-driven hot-potato
    // (their automation reacts to its own `message.sent` webhook and POSTs
    // back) inside one thread before the per-key 60/min budget bites. See
    // lib/messaging/conversation-send-budget.ts for rationale. The
    // idempotency claim above this point already committed; if rate-limit
    // throws here, the calling partner can release + retry after the
    // Retry-After window expires.
    try {
      consumeConversationSendBudget(teamId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        // Release the idempotency claim so the partner's retry after
        // Retry-After expires can re-claim a fresh slot.
        if (idempotencyKey) {
          await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
        }
        throw new HttpException(
          {
            error: "conversation_rate_limited",
            detail: err.message,
            retryAfter: err.retryAfter,
          },
          429,
        );
      }
      throw err;
    }

    let send;
    try {
      const config = await binding.getSendConfig(teamId);
      send = await binding.provider.sendText(
        {
          to: channel.to,
          body: input.body,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
      // OUTBOUND-1: release the idempotency claim ONLY when the send PROVABLY
      // never reached Meta — never-configured (we never called Meta) or a Meta
      // 4xx rejection (Meta refused, nothing sent). For an AMBIGUOUS failure (a
      // 5xx, a timeout, a network drop — Meta may have accepted) we KEEP the
      // pending claim so a same-key retry can't re-send a possibly-delivered
      // billed message; the partner gets 409 (in-flight, then ambiguous) and
      // must use a fresh key to deliberately resend.
      const normalized = normalizeMetaSendError(err);
      const provablyNotSent =
        err instanceof ProviderNotConfiguredError ||
        (normalized != null && normalized.httpStatus < 500);
      if (idempotencyKey && provablyNotSent) {
        await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
      }
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp_not_connected",
          detail: err.message,
        });
      }
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          detail: `Meta ${normalized.httpStatus}: ${normalized.message}${
            normalized.detail ? ` — ${normalized.detail}` : ""
          }`,
        });
      }
      this.logger.error("external sendText failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const created = await createOutboundMessageIdempotent({
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: null,
      body: input.body,
      direction: "out",
      channel: provider,
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId } as Prisma.InputJsonValue,
      timestamp: send.timestamp,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });

    const preview = input.body.slice(0, 200);
    const message: Message = {
      id: created.id,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: null,
      body: input.body,
      direction: "out",
      channel: provider,
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId },
      timestamp: send.timestamp.toISOString(),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };
    // Strict-monotonic bump + atomic message.sent publish, unified in
    // commitOutboundSend — the same helper the user-facing + lib send paths
    // use (closes the crash window between tx commit and a post-tx publish()).
    // Backend audit 2026-05-29 H1 flagged external-v1 + interactive as the two
    // paths missed by the original text/template migration; this routes the
    // last hand-rolled copy through the canonical commit.
    await commitOutboundSend({
      conversationId,
      bumpTimestamp: send.timestamp,
      preview,
      event: {
        type: "message.sent",
        teamId,
        conversationId,
        contactId: conversation.contactId,
        message,
        preview,
        senderUserId: null,
        senderApiKeyId: apiKeyId,
      },
      onMissing: () => {
        throw new BadGatewayException({
          error: "conversation_disappeared_mid_send",
        });
      },
    });

    const result = { message: toExternalMessage(created) };

    // Complete the claim — flip the pending sentinel to the real response.
    // AWAITED (not fire-and-forget) so concurrent retries arriving at the
    // claim path immediately see the completed row instead of racing the
    // partner into a duplicate send.
    if (idempotencyKey) {
      await this.completeIdempotency(teamId, apiKeyId, idempotencyKey, result);
    }

    return result;
  }

  // ===========================================================================
  // CONTACT-KEYED CONVERSATION ACTIONS (mirror respond.io's n8n surface)
  // ===========================================================================

  /**
   * Find the contact's most-recent conversation. Returns null when the
   * contact has none (e.g. brand-new manual contact that hasn't received a
   * message yet). Caller decides whether to 404 or auto-create.
   */
  private async resolveContactConversation(
    teamId: string,
    contactId: string,
  ): Promise<{ id: string } | null> {
    const conversation = await this.db.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    return conversation;
  }

  /** Resolve `contact: { id } | { phone }` to a contactId. Throws 404 on miss. */
  private async resolveContactIdentifier(
    teamId: string,
    contact: { id: string } | { phone: string },
  ): Promise<string> {
    if ("id" in contact) {
      const row = await this.db.contact.findFirst({
        where: { id: contact.id, teamId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
      return row.id;
    }
    const phone = normalizePhoneE164(contact.phone);
    if (!phone) {
      throw new BadRequestException({
        error: "invalid_phone",
        detail: "phone must be a valid international number (e.g. +1 555 555 0100)",
      });
    }
    const row = await this.db.contact.findFirst({
      where: { teamId, phoneNumber: phone },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    return row.id;
  }

  async assignByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
    idempotencyKey?: string,
  ) {
    const contactRow = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    const conv = await this.resolveContactConversation(teamId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet — start one with POST /v1/messages first",
      });
    }
    // Idempotency is enforced inside assign() on the resolved conversation id.
    await this.assign(
      teamId,
      apiKeyId,
      conv.id,
      { assignedUserId: input.assignedUserId, silent: input.silent },
      idempotencyKey,
    );
    return { conversationId: conv.id };
  }

  async setStatusByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
    idempotencyKey?: string,
  ) {
    const contactRow = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    const conv = await this.resolveContactConversation(teamId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet",
      });
    }
    // Idempotency is enforced inside setStatus() on the resolved conversation id.
    await this.setStatus(
      teamId,
      apiKeyId,
      conv.id,
      { status: input.status, silent: input.silent },
      idempotencyKey,
    );
    return { conversationId: conv.id };
  }

  // ===========================================================================
  // TOP-LEVEL POST /v1/messages — n8n-shaped send
  // ===========================================================================

  async sendTopLevelMessage(
    teamId: string,
    apiKeyId: string,
    input: ExternalTopLevelSendMessageInput,
    idempotencyKey?: string,
    /** See `sendMessage` chainDepth doc — same cross-system cap. */
    chainDepth?: number,
  ): Promise<{ ok: true; message: ExternalMessage; clientTempId: string | null }> {
    if (chainDepth !== undefined && chainDepth >= MAX_CHAIN_DEPTH) {
      throw new HttpException(
        {
          error: "chain_depth_exceeded",
          detail:
            `inbound X-CCP-Depth ${chainDepth} >= ${MAX_CHAIN_DEPTH} — request dropped to ` +
            "break a likely cross-system loop.",
        },
        429,
      );
    }
    if (input.media) {
      throw new BadRequestException({
        error: "media_not_yet_supported",
        detail:
          "URL-based media send via /v1/messages is not yet wired. Use the existing " +
          "media-send paths via the inbox UI for now; the URL → upload → send pipeline " +
          "is on the roadmap.",
      });
    }
    // Idempotency-Key is MANDATORY on send routes (OUTBOUND-1). A billed cold-
    // outbound template is the most expensive duplicate; a keyless partner retry
    // on a 5xx/timeout would double-send.
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: "idempotency_key_required",
        detail:
          "Send routes require an Idempotency-Key header (a unique id per distinct " +
          "send) so a network retry can't double-send a billed message.",
      });
    }

    const contactId = await this.resolveContactIdentifier(teamId, input.contact);

    // Find an active (non-closed) conversation or create one. Mirrors the
    // inbound-ingest "one-contact-one-conversation" invariant — if the most
    // recent conversation is closed, we reopen it via the existing
    // conversation-status path so the audit trail captures the reopen.
    let conv = await this.db.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, status: true },
    });
    if (!conv) {
      // Stamp the new thread's channel from the contact's identity — the
      // source of truth at creation (contacts are siloed + immutable-identity).
      // Load-bearing now that the send paths stamp Message.channel FROM the
      // conversation: a wrong @default(meta_cloud) here would propagate to
      // every message on a future non-phone contact's thread.
      const contactChannel = await this.db.contact.findUnique({
        where: { id: contactId },
        select: { phoneNumber: true, identityChannel: true, externalContactId: true },
      });
      let channel: Channel = "whatsapp";
      if (contactChannel) {
        try {
          channel = resolveContactChannel(contactChannel).channel;
        } catch {
          // No reachable address — keep the default; the downstream send will
          // surface the proper "contact has no reachable address" error.
        }
      }
      try {
        conv = await this.db.conversation.create({
          data: {
            teamId,
            contactId,
            channel,
            status: "pending",
            lastMessageAt: new Date(),
            lastMessagePreview: "",
          },
          select: { id: true, status: true },
        });
      } catch (err) {
        // Lost the race for this contact's single conversation (unique
        // [teamId, contactId]) to a concurrent inbound/forward — reuse the
        // winner's row (it was just created `pending`, so no reopen needed).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          conv = await this.db.conversation.findFirstOrThrow({
            where: { teamId, contactId },
            orderBy: { lastMessageAt: "desc" },
            select: { id: true, status: true },
          });
        } else throw err;
      }
    } else if (conv.status === "closed") {
      // Reopen via setStatus so the audit + analytics counters fire correctly.
      await this.setStatus(teamId, apiKeyId, conv.id, { status: "pending" });
    }

    // ---- Template send ---------------------------------------------------
    //
    // Templates DON'T need the 24h customer-service window — that's their
    // whole point (cold outbound + re-engagement).
    if (input.template) {
      const template = await this.db.messageTemplate.findFirst({
        where: { teamId, name: input.template.name, language: input.template.language },
        select: { id: true },
      });
      if (!template) {
        throw new NotFoundException({
          error: "template_not_found",
          detail: `template "${input.template.name}" (${input.template.language}) not in this team's catalog`,
        });
      }

      // Idempotency — same claim-then-execute as the text path (shared
      // helpers). Templates are billed cold-outbound, so a partner retry
      // double-send is the most expensive duplicate; this closes the gap
      // where the template branch ignored the Idempotency-Key entirely
      // (audit 2026-05-22). Claimed AFTER the template lookup so a bad
      // template name doesn't strand a pending row.
      {
        const claim = await this.claimIdempotency<{
          ok: true;
          message: ExternalMessage;
          clientTempId: string | null;
        }>(
          teamId,
          apiKeyId,
          idempotencyKey,
          requestFingerprint("send_template", {
            contact: input.contact,
            template: input.template,
          }),
          // Crashed-mid-send pending row past TTL must not auto-clear into a
          // re-send of a billed template (OUTBOUND-1).
          { refuseStaleOnAmbiguity: true },
        );
        if (claim.kind === "replay") return claim.result;
      }

      let out: { ok: true; message: ExternalMessage; clientTempId: string | null };
      try {
        const result = await sendTemplateInternal({
          teamId,
          conversationId: conv.id,
          templateId: template.id,
          variables: input.template.variables,
          senderUserId: null,
          senderApiKeyId: apiKeyId,
          sentVia: `api/external/v1/messages/template/${apiKeyId}`,
        });
        const message = await this.db.message.findUniqueOrThrow({
          where: { id: result.messageId },
        });
        out = {
          ok: true,
          message: toExternalMessage(message),
          clientTempId: input.client_temp_id ?? null,
        };
      } catch (err) {
        if (err instanceof SendTemplateValidationError) {
          // Pre-delivery validation failure — nothing was sent. Release the
          // claim so a corrected retry can re-claim fresh.
          if (idempotencyKey) {
            await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
          }
          throw new BadRequestException({
            error: err.code,
            ...(err.detail ? { detail: err.detail } : {}),
          });
        }
        const normalized = normalizeMetaSendError(err);
        if (normalized) {
          // Release ONLY on a Meta 4xx (definitive rejection, nothing sent). A
          // 5xx may have landed AFTER Meta accepted — treat as ambiguous + keep
          // the claim so a retry can't double-send (OUTBOUND-1).
          if (idempotencyKey && normalized.httpStatus < 500) {
            await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
          }
          throw new UnprocessableEntityException({
            error: normalized.code,
            message: normalized.message,
            detail: normalized.detail,
          });
        }
        // Unknown / ambiguous error that may have landed AFTER Meta accepted
        // the send — do NOT release. Leave the pending claim so a retry gets
        // 409 rather than risking a duplicate billed template send. Mirrors
        // the text path, which never releases once past the Meta call.
        throw err;
      }
      if (idempotencyKey) {
        await this.completeIdempotency(teamId, apiKeyId, idempotencyKey, out);
      }
      return out;
    }

    // ---- Text send (default) ---------------------------------------------
    if (!input.text) {
      throw new BadRequestException({ error: "text_required", detail: "text required" });
    }

    const result = await this.sendMessage(
      teamId,
      apiKeyId,
      conv.id,
      {
        body: input.text,
        ...(input.reply_to_message_id ? { replyToMessageId: input.reply_to_message_id } : {}),
      },
      idempotencyKey,
    );
    // The top-level send never sets `onlyIfAiEnabled`, so the no-interrupt skip
    // can't fire here — `message` is always present. Guard keeps the types honest.
    if (!result.message) {
      throw new BadGatewayException({ error: "send_failed", detail: "send skipped unexpectedly" });
    }
    return { ok: true, message: result.message, clientTempId: input.client_temp_id ?? null };
  }

  // ===========================================================================
  // NOTES
  // ===========================================================================

  async createNote(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalNoteInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ) {
    // Loop guard — a partner whose `note.created` outbound-webhook
    // receiver POSTs back here would otherwise note-thrash until the
    // route's 300/min global rate limit catches up. Cap at MAX_CHAIN_DEPTH
    // mirroring the send routes.
    if (chainDepth !== undefined && chainDepth >= MAX_CHAIN_DEPTH) {
      throw new HttpException(
        {
          error: "chain_depth_exceeded",
          detail:
            `inbound X-CCP-Depth ${chainDepth} >= ${MAX_CHAIN_DEPTH} — request dropped to ` +
            "break a likely cross-system loop.",
        },
        429,
      );
    }
    // Idempotency — a partner retry of the same note must not write a
    // second InternalNote + re-publish `note.created` (which audit + outbound
    // webhooks subscribe to). Same shape as the assign / set_status paths.
    if (idempotencyKey) {
      const claim = await this.idem.claim<{
        note: {
          id: string;
          conversationId: string;
          authorUserId: string;
          body: string;
          timestamp: string;
        };
      }>(
        teamId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("create_note", {
          conversationId,
          authorUserId: input.authorUserId,
          body: input.body,
        }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.createNoteInternal(teamId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(teamId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(teamId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async createNoteInternal(
    teamId: string,
    conversationId: string,
    input: ExternalNoteInput,
  ) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });

    if (!input.authorUserId) {
      throw new BadRequestException({
        error: "authorUserId_required",
        detail:
          "Notes created via /v1 must specify `authorUserId` (a member of " +
          "the team). Create a dedicated service-account user for your " +
          "integration if no human author applies.",
      });
    }
    const u = await this.db.user.findFirst({
      where: { id: input.authorUserId, teamId },
      select: { id: true },
    });
    if (!u) {
      throw new BadRequestException({
        error: "user_not_in_team",
        detail: "authorUserId is not a member of this team",
      });
    }
    const authorUserId: string = u.id;

    const note = await this.db.internalNote.create({
      data: { teamId, conversationId, authorUserId, body: input.body },
    });

    const notePayload = {
      id: note.id,
      conversationId,
      authorUserId,
      body: input.body,
      timestamp: note.timestamp.toISOString(),
    };

    await this.bus.publish({
      type: "note.created",
      teamId,
      conversationId,
      note: notePayload,
      // Honor `silent: true` so a partner whose `note.created` webhook
      // receiver creates ANOTHER note (loop) can break their own echo
      // chain without depending on chain-depth alone.
      silent: input.silent === true,
    });

    return { note: notePayload };
  }
}

/**
 * Canonical request fingerprint for idempotency-key reuse detection. `payload`
 * is the already-Zod-parsed input (stable key order for a given route), so a
 * plain JSON.stringify is deterministic — two identical requests hash equal,
 * two different payloads under the same key hash differently. The `route`
 * prefix keeps a text send and a template send under the same key distinct.
 */
function requestFingerprint(route: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${route}\n${JSON.stringify(payload)}`)
    .digest("hex");
}
