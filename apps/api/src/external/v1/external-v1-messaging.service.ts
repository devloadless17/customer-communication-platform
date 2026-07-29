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
  redactExternalContactPii,
  toExternalMessage,
  EXTERNAL_CONVERSATION_INCLUDE,
  type ExternalMessage,
} from "@/lib/external-shapes";
import { assignByPolicy } from "@/lib/assignment/apply";
import { toExternalMediaUrl } from "@/lib/blob-storage";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import { SendTextValidationError } from "@/lib/messaging/send-text-internal";
import { checkTextCap } from "@/lib/messaging/text-cap";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { MAX_CHAIN_DEPTH } from "@/lib/workflows/events";

/**
 * Presign an ExternalMessage's media links so a `/v1` API caller can actually
 * fetch them — `toExternalMessage` emits the stored PRIVATE R2 urls (403 to
 * anyone outside our process). Legacy/foreign urls pass through. Applied at
 * every response site that returns a message. See toExternalMediaUrl.
 */
async function withPresignedMedia(msg: ExternalMessage): Promise<ExternalMessage> {
  if (!msg.media) return msg;
  const [url, thumbnailUrl] = await Promise.all([
    toExternalMediaUrl(msg.media.url),
    toExternalMediaUrl(msg.media.thumbnailUrl),
  ]);
  return { ...msg, media: { ...msg.media, url, thumbnailUrl } };
}

import {
  sendTemplateInternal,
  SendTemplateValidationError,
} from "@/lib/messaging/send-template-internal";
import {
  consumeConversationSendBudget,
  ConversationSendRateLimitedError,
} from "@/lib/messaging/conversation-send-budget";
import { getProviderBinding } from "@/lib/providers";
import { resolveOutboundAccountId } from "@/lib/conversations/account";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { encodeConvoCursor, parseConvoCursor } from "@/lib/queries/_cursors";
import { isProvablyNotSent, normalizeMetaSendError } from "@/lib/providers/meta";
import type { Message, Channel } from "@ccp/shared/types";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import {
  computeWindowStatus,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";
import {
  assignConversation,
  setConversationStatus,
  setConversationAiEnabled,
} from "@/lib/conversations/mutations";
import { runHandoffPolicy } from "@/lib/conversations/handoff";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import { ApiIdempotencyService } from "./api-idempotency.service";
import type {
  ExternalAssignInput,
  ExternalContactAssignInput,
  ExternalContactStatusInput,
  ExternalNoteInput,
  ExternalSendInteractiveInput,
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
    workspaceId: string,
    apiKeyId: string,
    key: string,
    requestHash: string,
    opts?: { refuseStaleOnAmbiguity?: boolean },
  ): Promise<{ kind: "claimed" } | { kind: "replay"; result: T }> {
    return this.idem.claim<T>(workspaceId, apiKeyId, key, requestHash, opts);
  }

  private completeIdempotency<T>(
    workspaceId: string,
    apiKeyId: string,
    key: string,
    result: T,
  ): Promise<void> {
    return this.idem.complete<T>(workspaceId, apiKeyId, key, result);
  }

  private releaseIdempotency(
    workspaceId: string,
    apiKeyId: string,
    key: string,
  ): Promise<void> {
    return this.idem.release(workspaceId, apiKeyId, key);
  }

  // ===========================================================================
  // CONVERSATIONS
  // ===========================================================================

  async listConversations(
    workspaceId: string,
    q: ListConversationsQueryInput,
    includeContactPii = true,
    /**
     * Predicates from a saved view, already resolved by the controller (which
     * owns the membership check + dangling-id cleanup).
     *
     * ANDed, never spread. The view can set `status` and so can `q`; merging by
     * spread would let one silently delete the other, and the caller would get
     * a page that quietly ignores half the filter they asked for.
     */
    viewClauses: Prisma.ConversationWhereInput[] = [],
  ) {
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
        workspaceId,
        ...(q.status ? { status: q.status } : {}),
        ...(phone ? { contact: { phoneNumber: phone } } : {}),
        // Narrow to one connected account. Scoped by `workspaceId` above, so an
        // id from another tenant matches nothing rather than reading across.
        ...(q.accountId ? { channelConnectionId: q.accountId } : {}),
        ...(cursor
          ? {
              OR: [
                { lastMessageAt: { lt: cursor.lastMessageAt } },
                { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
        ...(viewClauses.length ? { AND: viewClauses } : {}),
      },
      include: EXTERNAL_CONVERSATION_INCLUDE,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const items = page
      .map(conversationRowToExternal)
      .map((c) =>
        includeContactPii
          ? c
          : { ...c, contact: redactExternalContactPii(c.contact) },
      );
    const lastRow = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && lastRow
        ? encodeConvoCursor({ lastMessageAt: lastRow.lastMessageAt, id: lastRow.id })
        : null;
    return { items, nextCursor };
  }

  async getConversation(workspaceId: string, id: string, includeContactPii = true) {
    const row = await this.db.conversation.findFirst({
      where: { id, workspaceId },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    if (!row) throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });
    // `conversation.contact` is embedded; the top-level `contact` is kept as a
    // convenience alias so the single-conversation response still surfaces it
    // at the root for callers that read response.contact directly.
    const full = conversationRowToExternal(row);
    const conversation = includeContactPii
      ? full
      : { ...full, contact: redactExternalContactPii(full.contact) };
    return { conversation, contact: conversation.contact };
  }

  async assign(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    // Idempotency — a partner retry of the same assign (n8n re-firing on a
    // timeout) must not re-publish conversation.assigned + re-trigger workflows
    // / webhooks. CLAIM-then-execute via the shared service (F2 in
    // tests/VERIFICATION-2026-07-29.md). A replay returns the prior
    // { ok: true } with zero side effects.
    if (idempotencyKey) {
      const claim = await this.idem.claim<{ ok: true }>(
        workspaceId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("assign", {
          conversationId,
          assignedUserId: input.assignedUserId ?? null,
          autoAssign: input.autoAssign === true,
          policyId: input.policyId ?? null,
        }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.assignInternal(workspaceId, apiKeyId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(workspaceId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(workspaceId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async assignInternal(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
  ): Promise<{ ok: true }> {
    // Policy-routed assign: hand the whole thing to the assignment engine,
    // which owns the pick AND the write (validation retry, CAS-conflict
    // handling, the never-steal-from-a-human guard). One implementation shared
    // with the AI handoff, the workflow step and the inbound auto-router — a
    // partner integration gets exactly the routing the admin configured.
    if (input.autoAssign === true) {
      const outcome = await assignByPolicy({
        db: this.db,
        publish: (e) => this.bus.publish(e),
        workspaceId,
        conversationId,
        source: "api",
        policyId: input.policyId ?? null,
        // An explicit API call is a deliberate instruction, so it reassigns by
        // default — the opposite of internal automation's fill-empty-only.
        onlyIfUnassigned: input.overwrite === false,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
        silent: input.silent === true,
      });
      if (!outcome.applied && outcome.skipped === "not_found") {
        throw new NotFoundException({
          error: "conversation_not_found",
          detail: "conversation not found",
        });
      }
      // `no_assignee` (nobody eligible / everyone at capacity) is NOT an error:
      // it's the policy's configured outcome, and the conversation is sitting
      // in the visible triage queue. Reporting a 4xx would make partners retry
      // a call that behaved correctly.
      return { ok: true };
    }

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
      workspaceId,
      conversationId,
      targetUserId: input.assignedUserId ?? null,
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
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    // Idempotency — see assign(). A retry must not re-publish
    // conversation.status_changed (+ the unassign-on-close cascade).
    if (idempotencyKey) {
      const claim = await this.idem.claim<{ ok: true }>(
        workspaceId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("set_status", { conversationId, status: input.status }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.setStatusInternal(workspaceId, apiKeyId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(workspaceId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(workspaceId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  /**
   * Deferred post-send reopen — flip a still-closed thread back to pending via
   * the shared status CAS. Re-reads the CURRENT status right before reopening so
   * an agent who reopened (closed->open) mid-send isn't downgraded back to
   * pending (setConversationStatus's CAS re-reads fresh too, so it can't guard
   * this on its own — it would flip open->pending). Best-effort: the billed send
   * already succeeded, so a reopen failure degrades to "sent into a still-closed
   * thread" and never errors the partner.
   */
  private async reopenIfStillClosed(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
  ): Promise<void> {
    // Fully best-effort: this runs AFTER the send is committed + the idempotency
    // claim completed, so neither the status READ nor the setStatus mutation may
    // throw out of the caller — a transient DB blip here must never turn a
    // successful, billed send into a failure response. Swallow everything.
    try {
      const current = await this.db.conversation.findFirst({
        where: { id: conversationId, workspaceId },
        select: { status: true },
      });
      if (current?.status !== "closed") return;
      await this.setStatus(workspaceId, apiKeyId, conversationId, { status: "pending" });
    } catch (err) {
      this.logger.warn(
        `reopen after top-level send failed for conversation ${conversationId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private async setStatusInternal(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
  ): Promise<{ ok: true }> {
    // Shared business rule (CAS, unassign-on-close, event publishing) lives in
    // lib/conversations/mutations.ts so a /v1 close matches the inbox UI + the
    // workflow close step exactly. (Also tightens the update with a status CAS
    // + workspaceId guard the old hand-rolled version lacked.) `changedByApiKeyId`
    // threads partner attribution; `silent` skips workflow re-trigger + echo.
    const result = await setConversationStatus({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      workspaceId,
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
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSetAiInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true }> {
    // Idempotency — see setStatus(). A retry must not re-publish ai_changed.
    if (idempotencyKey) {
      const claim = await this.idem.claim<{ ok: true }>(
        workspaceId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("set_ai", { conversationId, aiEnabled: input.aiEnabled }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.setAiEnabledInternal(workspaceId, apiKeyId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(workspaceId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(workspaceId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async setAiEnabledInternal(
    workspaceId: string,
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
      workspaceId,
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
      await runHandoffPolicy({
        db: this.db,
        publish: (e) => this.bus.publish(e),
        workspaceId,
        conversationId,
        changedByApiKeyId: apiKeyId,
        onError: (m) => this.logger.warn(m),
      }).catch((err) => {
        this.logger.warn(
          `handoff policy failed for conversation ${conversationId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    }
    return { ok: true };
  }

  // ===========================================================================
  // MESSAGES
  // ===========================================================================

  async listMessages(
    workspaceId: string,
    conversationId: string,
    q: ListMessagesQueryInput,
    includeContactPii = true,
  ) {
    // The existence check doubles as the conversation context we return
    // alongside the messages, so a page of messages always tells the caller
    // who the thread is with (contact + assignee embedded) without a separate
    // GET /v1/conversations/:id.
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    if (!conv) throw new NotFoundException({ error: "conversation_not_found", detail: "conversation not found" });

    const rows = await this.db.message.findMany({
      where: { conversationId },
      // Select EXACTLY the columns toExternalMessage reads — not `omit:
      // rawPayload`, which still ships ~15 unused columns (reply FKs, error
      // strings, workspaceId, audit timestamps) per row on this partner-pollable
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
    const items = await Promise.all(
      rows.slice(0, q.limit).map((r) => withPresignedMedia(toExternalMessage(r))),
    );
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    const convWire = conversationRowToExternal(conv);
    return {
      conversation: includeContactPii
        ? convWire
        : { ...convWire, contact: redactExternalContactPii(convWire.contact) },
      items,
      nextCursor,
    };
  }

  async findMessage(workspaceId: string, id: string, includeContactPii = true) {
    const row = await this.db.message.findFirst({
      where: { id, workspaceId },
      omit: { rawPayload: true },
      // Embed the parent conversation (which itself embeds contact + assignee)
      // so a single message fetch carries who it's with — no follow-up call.
      include: { conversation: { include: EXTERNAL_CONVERSATION_INCLUDE } },
    });
    if (!row) throw new NotFoundException({ error: "message_not_found", detail: "message not found" });
    const convWire = conversationRowToExternal(row.conversation);
    return {
      message: await withPresignedMedia(toExternalMessage(row)),
      conversation: includeContactPii
        ? convWire
        : { ...convWire, contact: redactExternalContactPii(convWire.contact) },
    };
  }

  async sendMessage(
    workspaceId: string,
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
    /**
     * Reopen the conversation (closed → pending) ONLY after a fresh send lands.
     * Set by BOTH send routes (top-level POST /v1/messages and the
     * conversation-scoped POST /v1/conversations/:id/messages) for UI↔/v1 parity
     * (§12) — the inbox reply reopens, so /v1 must too. The reopen happens inside
     * the claimed section (past the replay short-circuit) and after the Meta send
     * succeeds — never before the claim, where a replayed retry or a validation
     * failure would churn an agent-closed thread. Defaults false for any internal
     * caller that doesn't opt in.
     */
    reopenIfClosed = false,
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
        workspaceId,
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
      where: { id: conversationId, workspaceId },
      select: {
        id: true,
        contactId: true,
        // Channel is conversation-owned — bind + stamp from here.
        channel: true,
        // §2: the /v1 send goes out the THREAD's account, not the workspace
        // default (see getSendConfig below).
        channelConnectionId: true,
        // Status drives the deferred reopen below (reopenIfClosed path only).
        status: true,
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
      if (idempotencyKey) await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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
      if (idempotencyKey) await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
      return { message: null, skipped: "ai_disabled" as const };
    }

    let channel;
    try {
      channel = resolveContactChannel(conversation.contact);
    } catch (err) {
      if (err instanceof NoChannelDestinationError) {
        if (idempotencyKey) await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
        throw new BadRequestException({
          error: "contact_has_no_phone",
          detail: "This contact has no reachable address.",
        });
      }
      throw err;
    }
    const provider = conversation.channel;
    const binding = getProviderBinding(provider);

    // Channel text-length cap — parity with the internal send path (WhatsApp
    // 4096, Messenger 2000, Instagram 1000). Fail fast before Meta's opaque
    // over-limit reject.
    const tooLong = checkTextCap(input.body, binding.provider.capabilities, provider);
    if (tooLong) {
      if (idempotencyKey) await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
      throw new UnprocessableEntityException({
        error: "message_too_long",
        detail: tooLong.detail,
        max: tooLong.max,
      });
    }

    // Free-form send window — driven by the provider capability; `null` skips
    // it (channel with no window restriction).
    const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
    const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
    if (windowMs !== null) {
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        if (idempotencyKey) await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail:
            "free-form messages are only allowed within 24h of the contact's last inbound. " +
            "use a pre-approved template for cold outbound (not yet exposed via the external API).",
          lastInboundAt,
        });
      }
    }
    // Meta social: past the 24h free-form band (but inside the effective window)
    // the send must carry the HUMAN_AGENT tag; RESPONSE otherwise. Same rule as
    // the internal send paths — parity keeps /v1 sends policy-correct too.
    const useHumanAgentTag = outsideFreeFormWindow(
      binding.provider.capabilities.freeFormWindowMs,
      lastInboundAt,
    );

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (input.replyToMessageId) {
      const replyRow = await this.db.message.findFirst({
        where: { id: input.replyToMessageId, conversationId, workspaceId },
        select: { id: true, externalId: true },
      });
      if (!replyRow) {
        // Previously silently dropped — partner thought their reply was
        // quoted but the message went out as a top-level send. Surface
        // the failure so they can see the bad id in their automation logs.
        if (idempotencyKey) await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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
      consumeConversationSendBudget(workspaceId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        // Release the idempotency claim so the partner's retry after
        // Retry-After expires can re-claim a fresh slot.
        if (idempotencyKey) {
          await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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
      const config = await binding.getSendConfig(
        workspaceId,
        conversation.channelConnectionId ?? undefined,
      );
      send = await binding.provider.sendText(
        {
          to: channel.to,
          body: input.body,
          useHumanAgentTag,
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
        err instanceof ProviderNotConfiguredError || isProvablyNotSent(normalized);
      if (idempotencyKey && provablyNotSent) {
        await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
      }
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          // Preserve the historical `whatsapp_not_connected` code for WhatsApp
          // (partners match on it); other channels (messenger/instagram/
          // webchatwidget) get the generic code the interactive path already
          // uses, instead of a WhatsApp-specific mislabel.
          error: err.channel === "whatsapp" ? "whatsapp_not_connected" : "channel_not_connected",
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
      workspaceId,
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
      workspaceId,
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
        workspaceId,
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

    const result = { message: await withPresignedMedia(toExternalMessage(created)) };

    // Complete the claim — flip the pending sentinel to the real response.
    // AWAITED (not fire-and-forget) so concurrent retries arriving at the
    // claim path immediately see the completed row instead of racing the
    // partner into a duplicate send.
    if (idempotencyKey) {
      await this.completeIdempotency(workspaceId, apiKeyId, idempotencyKey, result);
    }

    // Deferred reopen — the send landed (fresh, past the replay short-circuit),
    // so now flip a closed thread back to pending via the shared status CAS. Doing
    // it here (not before the claim) means a replayed retry or a pre-send failure
    // can't churn an agent-closed thread. Best-effort: the billed send already
    // succeeded, so a reopen failure degrades to "sent into a still-closed thread",
    // never an error back to the partner.
    if (reopenIfClosed) {
      // `conversation` was snapshotted (line 642) before the Meta send, so
      // reopenIfStillClosed re-reads fresh to avoid downgrading a thread an
      // agent reopened (closed->open) mid-send.
      await this.reopenIfStillClosed(workspaceId, apiKeyId, conversationId);
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
    workspaceId: string,
    contactId: string,
  ): Promise<{ id: string } | null> {
    const conversation = await this.db.conversation.findFirst({
      where: { workspaceId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    return conversation;
  }

  /** Resolve `contact: { id } | { phone }` to a contactId. Throws 404 on miss. */
  private async resolveContactIdentifier(
    workspaceId: string,
    contact: { id: string } | { phone: string },
  ): Promise<string> {
    if ("id" in contact) {
      // deletedAt:null — a tombstoned contact 404s on GET/PATCH; it must also be
      // unreachable on the highest-side-effect route (a billed WhatsApp send).
      const row = await this.db.contact.findFirst({
        where: { id: contact.id, workspaceId, deletedAt: null },
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
      // Scope to the phone-owning channel (whatsapp). The partial unique on
      // (workspaceId, phoneNumber) fires only for identityChannel='whatsapp', so the
      // same phone can also sit on a social/widget contact via contact-share or
      // widget pre-chat. Without this scope a billed partner send could resolve
      // to that social/widget row instead of the WhatsApp contact. Mirrors
      // ingest.ts's channel-scoped phone lookup.
      where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp", deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    return row.id;
  }

  async assignByContact(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
    idempotencyKey?: string,
  ) {
    const contactRow = await this.db.contact.findFirst({
      // deletedAt:null — consistent with getContact + resolveContactIdentifier;
      // a tombstoned contact must not be mutable through the by-contact routes.
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    const conv = await this.resolveContactConversation(workspaceId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet — start one with POST /v1/messages first",
      });
    }
    // Idempotency is enforced inside assign() on the resolved conversation id.
    await this.assign(
      workspaceId,
      apiKeyId,
      conv.id,
      // Pass the whole body through so the contact-keyed route supports every
      // option the conversation-keyed one does (auto-route, named policy,
      // overwrite) instead of silently dropping them.
      input,
      idempotencyKey,
    );
    return { conversationId: conv.id };
  }

  async setStatusByContact(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
    idempotencyKey?: string,
  ) {
    const contactRow = await this.db.contact.findFirst({
      // deletedAt:null — see assignByContact; tombstoned contacts stay 404 here.
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    const conv = await this.resolveContactConversation(workspaceId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet",
      });
    }
    // Idempotency is enforced inside setStatus() on the resolved conversation id.
    await this.setStatus(
      workspaceId,
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
    workspaceId: string,
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

    const contactId = await this.resolveContactIdentifier(workspaceId, input.contact);

    // Find an active (non-closed) conversation or create one. Mirrors the
    // inbound-ingest "one-contact-one-conversation" invariant — if the most
    // recent conversation is closed, we reopen it via the existing
    // conversation-status path so the audit trail captures the reopen.
    let conv = await this.db.conversation.findFirst({
      where: { workspaceId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, status: true, channelConnectionId: true },
    });
    // A closed thread is reopened ONLY after a fresh send actually lands (the
    // template branch below, and the text branch via sendMessage's
    // reopenIfClosed) — never here, before the idempotency claim. Reopening
    // up front let a replayed retry (which sends nothing) or a send that then
    // failed validation flip an agent-closed thread to pending and re-fire
    // conversation.status_changed + reopen workflows/webhooks.
    const wasClosed = conv?.status === "closed";
    // An EXISTING thread owns its account: the customer messaged that number,
    // the 24h window belongs to it, and their reply comes back to it. So an
    // `account_id` naming a different one is a caller mistake worth surfacing —
    // silently ignoring it would send from a number the partner did not ask for
    // while their logs say otherwise. Matching (the normal case, echoing the
    // webhook's `account.id` straight back) passes through.
    if (conv && input.account_id && conv.channelConnectionId !== input.account_id) {
      throw new BadRequestException({
        error: "account_mismatch",
        detail:
          `this contact's conversation belongs to account ${conv.channelConnectionId ?? "(unbound)"}, ` +
          `not ${input.account_id}. A reply must go out the account the customer messaged — ` +
          "omit `account_id` to use the thread's own account.",
      });
    }
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
      // Bind the new thread to an account through the shared rule — an
      // integration-started thread must be as attributable as an inbound one,
      // and in a multi-account workspace a null here makes every later send
      // fail `account-unresolved`.
      const { accountId, explicitNotFound } = await resolveOutboundAccountId(
        this.db,
        workspaceId,
        channel,
        input.account_id,
      );
      // A named account that doesn't exist (or isn't active, or belongs to a
      // different channel than the contact is reachable on) must NOT quietly
      // degrade to the default — that is the same "wrong number, no signal"
      // failure the account block on the webhook exists to end.
      if (explicitNotFound) {
        throw new NotFoundException({
          error: "account_not_found",
          detail:
            `no active ${channel} account ${input.account_id} in this workspace. ` +
            "List them with GET /v1/channels.",
        });
      }
      try {
        conv = await this.db.conversation.create({
          data: {
            workspaceId,
            contactId,
            channel,
            channelConnectionId: accountId,
            status: "pending",
            lastMessageAt: new Date(),
            lastMessagePreview: "",
          },
          select: { id: true, status: true, channelConnectionId: true },
        });
      } catch (err) {
        // Lost the race for this contact's single conversation (unique
        // [workspaceId, contactId]) to a concurrent inbound/forward — reuse the
        // winner's row (it was just created `pending`, so no reopen needed).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          conv = await this.db.conversation.findFirstOrThrow({
            where: { workspaceId, contactId },
            orderBy: { lastMessageAt: "desc" },
            select: { id: true, status: true, channelConnectionId: true },
          });
        } else throw err;
      }
    }

    // ---- Template send ---------------------------------------------------
    //
    // Templates DON'T need the 24h customer-service window — that's their
    // whole point (cold outbound + re-engagement).
    if (input.template) {
      // Scope the name lookup to the WABA this thread actually sends from.
      // `(name, language)` is NOT unique across a workspace — the catalog is
      // keyed `(workspaceId, wabaId, name, language)` — so once a workspace
      // runs two WABAs, an unscoped findFirst picks between two legitimately
      // distinct templates by row order. `sendTemplateInternal` would then
      // refuse it as `template_wrong_account`, which is correct but reads to
      // the partner as "your own template is wrong". Resolve it properly here.
      const account = conv.channelConnectionId
        ? await this.db.channelConnection.findFirst({
            where: { id: conv.channelConnectionId, workspaceId },
            select: { wabaId: true },
          })
        : null;
      const accountWaba = account?.wabaId ?? "";
      const byName = {
        workspaceId,
        name: input.template.name,
        language: input.template.language,
      };
      // Prefer this account's own catalog; fall back to the legacy `""`
      // sentinel (pre-multi-account rows, which belong to no WABA in
      // particular). With no account WABA known there is nothing to scope by,
      // so keep the original behaviour and let the send-time guard decide.
      const template = accountWaba
        ? ((await this.db.messageTemplate.findFirst({
            where: { ...byName, wabaId: accountWaba },
            select: { id: true },
          })) ??
          (await this.db.messageTemplate.findFirst({
            where: { ...byName, wabaId: "" },
            select: { id: true },
          })))
        : await this.db.messageTemplate.findFirst({
            where: byName,
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
          workspaceId,
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

      // Per-conversation send ceiling — SAME gate as the text path. Templates
      // are the BILLED cold-outbound path, so a partner hot-potato here is the
      // most expensive to leave uncapped. Claimed idempotency above is released
      // on rate-limit so a retry after Retry-After can re-claim fresh.
      try {
        consumeConversationSendBudget(workspaceId, conv.id);
      } catch (err) {
        if (err instanceof ConversationSendRateLimitedError) {
          if (idempotencyKey) {
            await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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

      let out: { ok: true; message: ExternalMessage; clientTempId: string | null };
      try {
        const result = await sendTemplateInternal({
          workspaceId,
          conversationId: conv.id,
          templateId: template.id,
          variables: input.template.variables,
          senderUserId: null,
          senderApiKeyId: apiKeyId,
          sentVia: `api/external/v1/messages/template/${apiKeyId}`,
        });
        const message = await this.db.message.findUniqueOrThrow({
          where: { id: result.messageId },
          // Same omit as every neighbouring read here. rawPayload is the full
          // original webhook body and is never part of the external wire shape,
          // so loading it just pulls a large JSONB off disk on the billed
          // template-send path and drops it.
          omit: { rawPayload: true },
        });
        out = {
          ok: true,
          message: await withPresignedMedia(toExternalMessage(message)),
          clientTempId: input.client_temp_id ?? null,
        };
      } catch (err) {
        if (err instanceof SendTemplateValidationError) {
          // The template send has TWO failure shapes that share the
          // `conversation_not_found` code but land on opposite sides of the Meta
          // call. The POST-send onMissing (message "conversation_disappeared_mid_send",
          // thrown by commitOutboundSend AFTER Meta accepted + billed the
          // template) is ambiguous — releasing the claim would let a same-key
          // retry re-send a SECOND billed template. Leave the claim pending and
          // surface a 502 so the retry gets 409 idempotency_ambiguous, mirroring
          // the text path. Every OTHER SendTemplateValidationError is a
          // pre-delivery validation failure — nothing was sent, so release the
          // claim and 400 so a corrected retry can re-claim fresh.
          if (err.message === "conversation_disappeared_mid_send") {
            throw new BadGatewayException({
              error: "send_ambiguous",
              detail: "conversation_disappeared_mid_send",
            });
          }
          if (idempotencyKey) {
            await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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
          if (idempotencyKey && isProvablyNotSent(normalized)) {
            await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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
        await this.completeIdempotency(workspaceId, apiKeyId, idempotencyKey, out);
      }
      // Deferred reopen — only now that a fresh template send has landed (past
      // the replay short-circuit + successful send). Best-effort: the billed
      // send already succeeded, so a reopen failure never errors the partner.
      if (wasClosed) {
        // `wasClosed` was snapshotted (line 1081) before the idempotency claim +
        // the entire sendTemplateInternal Meta round-trip, so reopenIfStillClosed
        // re-reads fresh to avoid downgrading a thread an agent reopened mid-send.
        await this.reopenIfStillClosed(workspaceId, apiKeyId, conv.id);
      }
      return out;
    }

    // ---- Text send (default) ---------------------------------------------
    if (!input.text) {
      throw new BadRequestException({ error: "text_required", detail: "text required" });
    }

    const result = await this.sendMessage(
      workspaceId,
      apiKeyId,
      conv.id,
      {
        body: input.text,
        ...(input.reply_to_message_id ? { replyToMessageId: input.reply_to_message_id } : {}),
      },
      idempotencyKey,
      // No inbound X-CCP-Depth to forward here (already gated at the top of this
      // method); pass the top-level reopen intent so a closed thread reopens
      // only after this send lands, inside the claimed section.
      undefined,
      wasClosed,
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
    workspaceId: string,
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
        workspaceId,
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
      const result = await this.createNoteInternal(workspaceId, conversationId, input);
      if (idempotencyKey) {
        await this.idem.complete(workspaceId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(workspaceId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async createNoteInternal(
    workspaceId: string,
    conversationId: string,
    input: ExternalNoteInput,
  ) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
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
      where: { id: input.authorUserId, workspaceMemberships: { some: { workspaceId } } },
      select: { id: true },
    });
    if (!u) {
      throw new BadRequestException({
        error: "user_not_in_team",
        detail: "authorUserId is not a member of this team",
      });
    }
    const authorUserId: string = u.id;

    // Insert + event commit atomically via publishInTx — same durability the
    // internal NotesService.create uses. A bare create()-then-publish() dropped
    // the audit row AND the outbound-webhook delivery permanently on any crash
    // between the DB commit and the emit; the transactional outbox guarantees
    // at-least-once. kickOutbox() drains it in ~1ms so the note still appears live.
    const note = await this.db.$transaction(async (tx) => {
      const row = await tx.internalNote.create({
        data: { workspaceId, conversationId, authorUserId, body: input.body },
      });
      const notePayload = {
        id: row.id,
        conversationId,
        authorUserId,
        body: input.body,
        timestamp: row.timestamp.toISOString(),
      };
      await publishInTx(tx, {
        type: "note.created",
        workspaceId,
        conversationId,
        note: notePayload,
        // Honor `silent: true` so a partner whose `note.created` webhook
        // receiver creates ANOTHER note (loop) can break their own echo
        // chain without depending on chain-depth alone.
        silent: input.silent === true,
      });
      return notePayload;
    });
    kickOutbox();

    return { note };
  }

  /**
   * `DELETE /v1/conversations/:id/notes/:noteId` — the external twin of the
   * inbox's `DELETE /api/notes/:id`, closing the §12 parity gap that left note
   * deletion (and the partner-facing `note.deleted` webhook) reachable only from
   * the UI. Publishes the SAME `note.deleted` event the UI path does, so an
   * API-driven CRM mirror can complete a create→delete round-trip. Naturally
   * idempotent — a repeated delete 404s, so no Idempotency-Key is required.
   * Team scope goes through the parent conversation (InternalNote has no workspaceId).
   */
  async deleteNote(workspaceId: string, conversationId: string, noteId: string) {
    const note = await this.db.internalNote.findFirst({
      where: { id: noteId, conversationId, conversation: { workspaceId } },
      select: { id: true, conversationId: true },
    });
    if (!note) throw new NotFoundException({ error: "note_not_found", detail: "note not found" });

    // Delete + event commit atomically (see createNoteInternal) so a crash
    // between the row delete and the emit can't drop the audit row + partner
    // webhook.
    await this.db.$transaction(async (tx) => {
      await tx.internalNote.delete({ where: { id: note.id } });
      await publishInTx(tx, {
        type: "note.deleted",
        workspaceId,
        conversationId: note.conversationId,
        noteId: note.id,
        // API-driven deletion has no human actor — the API key is the actor.
        deletedByUserId: null,
      });
    });
    kickOutbox();
    return { ok: true as const, deleted: note.id };
  }

  // ===========================================================================
  // INTERACTIVE SEND (buttons / list / consent chips)
  // ===========================================================================

  /**
   * `POST /v1/conversations/:id/interactive` — the external twin of the
   * composer's `POST /api/messages/interactive`. Closes the §12 parity gap that
   * left `contactShare` (Meta's one-tap phone/email consent chips) reachable
   * only from the UI.
   *
   * Delegates to the SAME domain function the composer uses
   * (`sendInteractiveInternal`), so the window gate, the capability check, the
   * HUMAN_AGENT tag decision, persistence, and the atomic `message.sent` publish
   * are shared, not re-implemented. This service only adds what `/v1` owes every
   * send: a mandatory `Idempotency-Key` claim and API-key attribution.
   */
  async sendInteractive(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendInteractiveInput,
    idempotencyKey: string,
  ): Promise<{ ok: true; messageId: string; externalId: string }> {
    // CLAIM-then-execute, identical to the text/template sends. A replay returns
    // the prior response with zero side effects; `refuseStaleOnAmbiguity` stops
    // a crashed-mid-send pending row from auto-clearing into a second send.
    {
      const claim = await this.claimIdempotency<{
        ok: true;
        messageId: string;
        externalId: string;
      }>(
        workspaceId,
        apiKeyId,
        idempotencyKey,
        requestFingerprint("send_interactive", { conversationId, ...input }),
        { refuseStaleOnAmbiguity: true },
      );
      if (claim.kind === "replay") return claim.result;
    }

    // Per-conversation send ceiling — SAME gate as the text/template paths. This
    // was the only customer-facing /v1 send entry point without it, breaking
    // parity (a partner hot-potato of interactive sends bypassed the cap).
    // Claimed idempotency above is released on rate-limit so a retry after
    // Retry-After can re-claim fresh.
    try {
      consumeConversationSendBudget(workspaceId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        if (idempotencyKey) {
          await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
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

    try {
      const result = await sendInteractiveInternal({
        workspaceId,
        conversationId,
        bodyText: input.body,
        kind: input.kind,
        options: input.options,
        ...(input.ctaUrl ? { ctaUrl: input.ctaUrl } : {}),
        ...(input.carouselCards ? { carouselCards: input.carouselCards } : {}),
        ...(input.listCtaLabel ? { listCtaLabel: input.listCtaLabel } : {}),
        ...(input.headerText ? { headerText: input.headerText } : {}),
        ...(input.footerText ? { footerText: input.footerText } : {}),
        ...(input.contactShare?.length ? { contactShare: input.contactShare } : {}),
        senderUserId: null,
        senderApiKeyId: apiKeyId,
        sentVia: "api/external/v1/interactive",
      });
      const payload = {
        ok: true as const,
        messageId: result.messageId,
        externalId: result.externalId,
      };
      // COMPLETE the idempotency claim FIRST — the send already reached Meta and
      // billed, so the success must be durably recorded before any best-effort
      // follow-up. The text + template paths order it exactly this way. Doing the
      // reopen before completing would let a transient DB error in the reopen
      // read fall into the catch below and return a false 502 with the claim
      // stuck pending (success unrecoverable, retries double-bill).
      await this.completeIdempotency(workspaceId, apiKeyId, idempotencyKey, payload);
      // A closed thread that receives an interactive send should reopen to
      // pending, like the /v1 text send (reopenIfClosed) and the composer's
      // interactive path (autoAssignOnAgentSend). Best-effort AND past the
      // completed claim, so a reopen hiccup can neither re-send nor strand it.
      await this.reopenIfStillClosed(workspaceId, apiKeyId, conversationId);
      return payload;
    } catch (err) {
      // OUTBOUND-1: release the claim ONLY when the send PROVABLY never reached
      // Meta. A validation error never called Graph; a Meta 4xx means Graph
      // refused. An ambiguous 5xx/timeout keeps the pending claim so a same-key
      // retry can't re-send a possibly-delivered message.
      //
      // ONE exception, and it is the whole reason this branch is subtle:
      // `sendInteractiveInternal` sends to Meta FIRST, then commits. If the
      // conversation vanishes between those two steps, `commitOutboundSend`'s
      // `onMissing` throws a SendTextValidationError whose code is the same
      // `conversation_not_found` used by the PRE-send guard — but Meta has
      // already accepted and billed the message. Releasing the claim there would
      // let a same-key retry send it a SECOND time. The message is the only
      // discriminator; the template path (sendTemplate, above) guards it the
      // same way.
      const normalized = normalizeMetaSendError(err);
      const sentThenLostConversation =
        err instanceof SendTextValidationError &&
        err.message === "conversation_disappeared_mid_send";
      const provablyNotSent =
        !sentThenLostConversation &&
        (err instanceof SendTextValidationError ||
          err instanceof ProviderNotConfiguredError ||
          isProvablyNotSent(normalized));
      if (provablyNotSent) {
        await this.releaseIdempotency(workspaceId, apiKeyId, idempotencyKey);
      }

      if (sentThenLostConversation) {
        // Meta accepted it; we just couldn't commit. A 404 would tell the partner
        // "nothing happened" and invite a retry of an already-billed send. Surface
        // it as ambiguous so a same-key retry gets 409 idempotency_ambiguous —
        // identical to the text and template paths.
        throw new BadGatewayException({
          error: "send_ambiguous",
          detail: "conversation_disappeared_mid_send",
        });
      }
      if (err instanceof SendTextValidationError) {
        // Same mapping the composer uses, so a partner and an agent get the
        // same status for the same cause.
        const status =
          err.code === "conversation_not_found"
            ? 404
            : err.code === "outside_24h_window" ||
                err.code === "provider_not_configured" ||
                err.code === "contact_share_not_supported"
              ? 422
              : 400;
        throw new HttpException(
          { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
          status,
        );
      }
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({ error: "channel_not_connected", detail: err.message });
      }
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          detail: `Meta ${normalized.httpStatus}: ${normalized.message}${
            normalized.detail ? ` — ${normalized.detail}` : ""
          }`,
        });
      }
      this.logger.error("external sendInteractive failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
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
