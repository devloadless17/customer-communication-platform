import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";
import { extractVideoPosterFrame } from "@/lib/media-thumbnail";
import { publish } from "@/lib/events/bus";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import type { DomainEventOf } from "@ccp/shared/events/types";
import {
  MEDIA_SIZE_CAPS,
  META_DOCUMENT_MIME_ALLOWED,
  mediaPolicyForChannel,
  kindFromMime,
  normalizeMimeType,
} from "@/lib/media-storage";
import { channelSupportsMediaKind } from "@ccp/shared/providers/media-caps";
import { transcodeToM4a, transcodeToOggOpus, VOICE_IOS_PROFILE } from "@/lib/media/audio-transcode";
import {
  consumeConversationSendBudget,
  ConversationSendRateLimitedError,
} from "@/lib/messaging/conversation-send-budget";
import { checkTextCap } from "@/lib/messaging/text-cap";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { setConversationAiEnabled } from "@/lib/conversations/mutations";
import { SendTextValidationError } from "@/lib/messaging/send-text-internal";
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import { sendStructuredInternal } from "@/lib/messaging/send-structured-internal";
import { sendReactionInternal } from "@/lib/messaging/send-reaction-internal";
import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Channel } from "@ccp/shared/types";
import { loadReplySnapshotById, mediaPreview } from "@/lib/providers/ingest";
import { MetaSendError, normalizeMetaSendError } from "@/lib/providers/meta";
import { getConversationWithRefs } from "@/lib/queries";
import type {
  ConversationWithRefs,
  ForwardResult,
  MediaAttachment,
  MediaKind,
  Message,
  User,
} from "@ccp/shared/types";
import {
  computeWindowStatus,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";
import { supportsInlineCaption } from "@ccp/shared/providers/capabilities";
import {
  workflowContactSnapshot,
  workflowConversationSnapshotAfterAssign,
  workflowConversationSnapshotAfterStatusChange,
} from "@/lib/workflows/events";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type {
  ForwardMessagesInput,
  SendMediaFormInput,
  SendTemplateInput,
  SendTextInput,
  TranslateInput,
} from "./messages.schemas";
import { runWithSendIdempotency } from "./send-idempotency";
import { enqueueMessageSend } from "./send-queue";

/**
 * Map a mime type to the template-header media kind. Templates only allow
 * IMAGE/VIDEO/DOCUMENT headers (audio/sticker are not valid header media).
 * Anything else returns null so the caller can reject with a clear message.
 */
function templateHeaderKindFromMime(
  mime: string,
): "image" | "video" | "document" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return null;
  // Everything else Meta treats as a document header (pdf, docx, xlsx, …).
  return "document";
}

/**
 * Meta's supported template-header media formats, per kind. A header's media is
 * fetched by Meta at SEND time (and on EVERY broadcast recipient), so an
 * unsupported type stages fine then fails every send. Image/video are far
 * stricter than the generic media path (jpeg/png, mp4/3gp); the document set
 * reuses Meta's standard document allowlist.
 */
const TEMPLATE_HEADER_MIME_ALLOWED: Record<
  "image" | "video" | "document",
  ReadonlySet<string>
> = {
  image: new Set(["image/jpeg", "image/png"]),
  video: new Set(["video/mp4", "video/3gp", "video/3gpp"]),
  document: META_DOCUMENT_MIME_ALLOWED,
};

const TEMPLATE_HEADER_MIME_HINT: Record<
  "image" | "video" | "document",
  string
> = {
  image: "A template image header must be JPEG or PNG.",
  video: "A template video header must be MP4 or 3GP.",
  document:
    "A template document header must be a PDF, Word, Excel, PowerPoint, text, or CSV file.",
};

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  // Lazy Anthropic client for the composer translate endpoint. Built on first
  // use (so a missing key surfaces a clean 503 instead of a boot crash) and
  // reused across calls. The SDK reads no other config we care about here.
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Translate composer text to a target language via the Claude API. Stateless
   * — it just transforms a string the agent is drafting (does NOT send or
   * persist anything), so it takes raw text rather than a conversation id.
   *
   * Model: claude-opus-4-8. No thinking (translation is a simple transform —
   * faster + cheaper without it) and a strict system prompt so the model emits
   * ONLY the translation, never a preamble or its reasoning. No prompt caching:
   * the prefix is far below Opus 4.8's 4096-token cache minimum, so a
   * cache_control breakpoint would be a silent no-op. Key in `ANTHROPIC_API_KEY`
   * for now (env, like the other secrets — moves to the Team table when
   * multi-tenant). `targetLang` is a language NAME (e.g. "Arabic").
   */
  async translate(input: TranslateInput): Promise<{ text: string }> {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "Translation isn't configured — set ANTHROPIC_API_KEY.",
      );
    }
    if (!this.anthropic) this.anthropic = new Anthropic({ apiKey });

    try {
      const message = await this.anthropic.messages.create({
        model: "claude-opus-4-8",
        // Output is bounded by the input length (composer text ≤ 8000 chars);
        // 8192 leaves headroom for languages that expand. Non-streaming is fine
        // well under the SDK's timeout threshold.
        max_tokens: 8192,
        system:
          `You are a translation engine. Translate the user's message into ${input.targetLang}. ` +
          `Preserve meaning, tone, line breaks, emoji, @mentions, URLs, and any placeholders exactly. ` +
          `Output ONLY the translated text — no preamble, no explanation, no quotes, no notes.`,
        messages: [{ role: "user", content: input.text }],
      });

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      if (!text) throw new BadGatewayException("Translation returned no result.");
      return { text };
    } catch (err) {
      if (err instanceof HttpException) throw err; // our own 502 above
      if (err instanceof Anthropic.APIError) {
        this.logger.warn(`Anthropic translate failed: ${err.status} ${err.message}`);
        if (err instanceof Anthropic.RateLimitError) {
          throw new ServiceUnavailableException(
            "Translation is busy — try again in a moment.",
          );
        }
        throw new BadGatewayException("Translation failed. Try again.");
      }
      this.logger.warn(`Translate error: ${String(err)}`);
      throw new BadGatewayException("Translation failed. Try again.");
    }
  }

  /**
   * Commit the side-effects that follow a successful outbound DB write:
   * bump the conversation summary AND persist the `message.sent` event
   * to the outbox — both in a single transaction. The outbox drainer
   * picks up the event after commit and dispatches subscribers.
   *
   * Replaces the previous `void this.bus.publish(...)` + `void this.db
   * .conversation.updateMany(...)` shape, which had two latent gaps:
   *   (a) process death between the Message create and bus.publish lost
   *       the realtime emit forever (`message.sent` is the inbox-shell's
   *       only signal for outbound persistence),
   *   (b) the synchronous bus.publish wrote its outbox row AFTER running
   *       subscribers — a crash mid-dispatch dropped the audit row too.
   *
   * publishInTx is the same primitive the inbound ingest path uses.
   *
   * The previous shape used a CAS `lastMessageAt: { lte: bumpTimestamp }`,
   * which silently no-op'd the UPDATE whenever an interleaved write
   * (inbound webhook, workflow auto-reply via the bare-UPDATE path in
   * lib/messaging/send-*-internal.ts, or a parallel send) had raced past
   * the worker's stale-from-preflight `bumpTimestamp`. The conversation
   * row stayed pinned to the racing write's preview, while THIS send's
   * `message.sent` event still fanned out with the now-stale outbound
   * preview — so the agent's list briefly flashed the correct value via
   * socket, then snapped back to the stuck preview on the next refresh.
   * Read `lastMessageAt` inside the tx and compute an effective bump that
   * is strictly monotonic relative to current DB state; that keeps the
   * inbox sort order correct AND guarantees the latest outbound's preview
   * actually lands.
   */
  private async commitOutboundEvent(args: {
    conversationId: string;
    bumpTimestamp: Date;
    preview: string;
    /**
     * `unreadCount` is omitted from the caller — outbound doesn't change
     * the team-wide counter, so the current row value is the authoritative
     * absolute we publish. Reading it inside the tx keeps the event in sync
     * with whatever inbound increments interleaved (and serializable
     * isolation ensures the read is consistent with the write below).
     */
    event: Omit<DomainEventOf<"message.sent">, "unreadCount" | "lastMessageAt">;
  }): Promise<void> {
    // No catch + fallback here on purpose. A short-lived `bus.publish()` retry
    // was added in the 2026-05-26 P3 batch to close the optimistic-bubble
    // watchdog gap when the tx failed, but it created a worse failure mode
    // under "tx-committed-but-client-error" race (commit acked on Postgres
    // but the connection drop surfaced as a thrown promise to Prisma): the
    // fallback would fire bus.publish() while the original outbox row also
    // eventually drained, so workflow-dispatch + outbound-webhook each
    // ran TWICE — partner integrations saw the same Meta wamid POST'd twice.
    // The client message dedupe (by externalId) made the bubble itself safe,
    // but the doubled partner POST is a worse externally-visible problem
    // than the original "rare bubble shows red but actually delivered."
    // Caller's own catch block (in sendText/sendMedia/sendTemplate/forward)
    // logs the warning; the optimistic bubble's 30s watchdog handles the
    // rare red-but-delivered case.
    await commitOutboundSend({
      conversationId: args.conversationId,
      bumpTimestamp: args.bumpTimestamp,
      preview: args.preview,
      event: args.event,
      // Controller path: a conversation that vanished mid-send is a no-op (the
      // optimistic bubble's 30s watchdog handles the rare red-but-delivered
      // case). Matches the prior `if (!current) return`.
      onMissing: () => {},
    });
  }

  /**
   * A human agent sending a reply is unambiguous proof they've viewed the
   * thread, so clear team-wide unread on send. This closes the gap where the
   * client's mark-read-on-mount is skipped because its CACHED unread snapshot
   * is stale-low — a client-side chat-switch into a thread whose LRU snapshot
   * predates inbound that arrived since. The agent reads + replies, but the DB
   * unread never zeroes, and a later authoritative frame (e.g. a broadcast
   * republishing the row's true count) then surfaces the stuck-high badge as a
   * sudden "1 -> 3" jump for a thread nobody-thinks-is-unread.
   *
   * Mirrors ConversationsService.markRead's CAS — zero only if unchanged since
   * the read, so a concurrent inbound bump isn't clobbered — and reuses the
   * already-wired `conversation.read` event (every client reducer: list badge,
   * cached snapshot, live thread already handles it), so no client change is
   * needed. Deliberately NOT placed in the shared send-*-internal helpers:
   * workflow auto-replies and external-API sends must NOT mark a thread read
   * (no human viewed it) — only these session-authenticated controller entry
   * points do. Fire-and-forget with a self-contained try/catch: a mark-read
   * failure must never fail or delay the actual send.
   */
  private markReadOnAgentSend(teamId: string, userId: string, conversationId: string): void {
    void (async () => {
      try {
        // Single conditional updateMany — the WHERE predicate IS the gate.
        // `unreadCount > 0` ensures no work when the thread is already
        // zeroed (common: the agent already opened the thread, which
        // marked it read on mount). result.count is 0 when nothing
        // matched → skip the publish. Was 2 round-trips (findFirst then
        // CAS); the CAS itself can also serve as the read.
        const result = await this.db.conversation.updateMany({
          where: { id: conversationId, teamId, unreadCount: { gt: 0 } },
          data: { unreadCount: 0 },
        });
        if (result.count > 0) {
          await this.bus.publish({
            type: "conversation.read",
            teamId,
            conversationId,
            readByUserId: userId,
          });
        }
      } catch (err) {
        this.logger.debug(
          `markReadOnAgentSend failed for ${conversationId}: ${String(err)}`,
        );
      }
    })();
  }

  /**
   * Claim-on-reply + promote-on-reply: when a human agent sends into a
   * conversation, either claim it (if unassigned) and/or promote its status
   * to `open` (if pending/closed). The agent is already chatting — making them
   * click the assignee or status dropdown first is friction; replying IS the
   * claim AND the (re)open.
   *
   * Two branches, gated on current ownership:
   *
   *   A. Already assigned (to anyone — sender or teammate). Skip the claim;
   *      we never steal a thread owned by a teammate. But if the thread is
   *      pending/closed, flip it to `open` and publish
   *      `conversation.status_changed`. This covers the assignee-replying-in-
   *      their-own-pending-thread case (and the teammate-replying case too —
   *      chatting is chatting, regardless of who owns it).
   *
   *   B. Unassigned. Claim the thread for the sender, AND if it was
   *      pending/closed flip it to `open`. Mirrors `ConversationsService.assign`'s
   *      observable behaviour so the result is indistinguishable from a manual
   *      claim:
   *        - publishes `conversation.assigned` (drives socket UI + audit
   *          timeline + on-assigned workflows + outbound webhooks — NOT silent,
   *          per product decision: a reply-claim is a real assignment)
   *        - if the claim moves a pending/closed thread, also publishes
   *          `conversation.status_changed`, exactly like assign().
   *
   * CAS on both branches so a concurrent manual assign / close / racing second
   * reply can't clobber state — the loser's update matches zero rows and is a
   * no-op (no event fired). Deliberately NOT in the shared send-*-internal
   * helpers: workflow auto-replies and external-API sends must NOT claim or
   * (re)open a thread (no human is replying). Fire-and-forget with a
   * self-contained try/catch — a failure here must never fail the send.
   */
  private autoAssignOnAgentSend(teamId: string, userId: string, conversationId: string): void {
    void (async () => {
      try {
        // Read the whole row (not a narrow `select`) so we can build a
        // post-mutation WorkflowConversationSnapshot for the publish without
        // a second round-trip. The conversation snapshot ships on the event
        // payload and feeds workflow-dispatch in lieu of a fresh DB read.
        const convo = await this.db.conversation.findFirst({
          where: { id: conversationId, teamId },
          include: {
            contact: { include: { tags: { select: { id: true } } } },
            team: { select: { aiAutopilotEnabled: true } },
          },
        });
        if (!convo) return;

        // The auto-claim pills (ai_paused → reopened → self-assigned) sort by
        // their audit `at`. To land them DIRECTLY UNDER the just-sent reply on
        // EVERY view — a refreshed page or a teammate's, neither of which has the
        // sender's optimistic group to anchor them — that `at` must be strictly
        // AFTER the message's own (monotonic) timestamp, in a fixed order.
        //
        // reopened + self-assigned are anchored to the COMMITTED message
        // (waitForOutboundAfter below): the worker computes the message ts from a
        // FRESH in-tx read, so a customer inbound that raced into the send (and a
        // future-skewed Meta clock) can push it past `now` — anchoring to the
        // real committed ts is the only way the pills stay under the reply in
        // that case. claimBase is the prediction used as the timeout fallback (a
        // send computes `max(receivedAt, lastMessageAt+1)`, so `max(now,
        // lastMessageAt+1)` clears it whenever no inbound interleaves).
        //
        // The AI-pause stays IMMEDIATE (its mutation must flip the external
        // `ai_enabled` flag before the next inbound's webhook fires), so its pill
        // keeps the prediction-based `at`. That's the least ordering-critical of
        // the three — and AI is off in the common takeover — so the rare-race
        // edge it leaves is cosmetic. (Manual dropdown/toggle paths pass no
        // occurredAt → write-time now(), since there's no message to order against.)
        const lastBeforeSend = convo.lastMessageAt?.getTime() ?? 0;
        const claimBase = Math.max(Date.now(), lastBeforeSend + 1);
        const aiPausedAt = new Date(claimBase + 1).toISOString();

        // Human reply = takeover → pause AI Autopilot so the external AI flow
        // stops auto-replying over the human. Idempotent (no-op if already
        // paused) + independent fire-and-forget so it can't affect the claim
        // or the send. Resume is explicit (inbox toggle) or on close. Gated on
        // the TEAM opt-in (orgs without AI never get pause events / pills) AND
        // the current value (skip the redundant re-read in the common case).
        if (convo.team.aiAutopilotEnabled && convo.aiEnabled) {
          void setConversationAiEnabled({
            db: this.db,
            publish: (e) => this.bus.publish(e),
            teamId,
            conversationId,
            aiEnabled: false,
            changedByUserId: userId,
            occurredAt: aiPausedAt,
          }).catch(() => {});
        }

        // Nothing left to claim or reopen (already assigned AND open) → done;
        // skip the message wait below. The AI-pause above already fired.
        if (convo.assignedUserId !== null && convo.status === "open") return;

        // Anchor reopened/self-assigned to the COMMITTED message ts (see above):
        // wait briefly for this send's outbound row to land, then base the pills
        // on it. Falls back to the prediction if the send never commits.
        const committedMsgTs = await this.waitForOutboundAfter(
          teamId,
          conversationId,
          lastBeforeSend,
        );
        const claimAnchor = committedMsgTs ? committedMsgTs.getTime() : claimBase;
        const reopenedAt = new Date(claimAnchor + 2).toISOString();
        const selfAssignedAt = new Date(claimAnchor + 3).toISOString();

        // Both branches wrap CAS + publish in one transaction via
        // publishInTx — a crash between commit and emit on the prior
        // bare-publish posture lost the realtime frame + audit row + any
        // outbound webhook for the assign/status flip. Same shape as
        // commitOutboundEvent.

        // Branch A: already assigned (to anyone, including this agent).
        // Skip the claim; promote status if not open.
        if (convo.assignedUserId !== null) {
          if (convo.status === "open") return;
          const previousStatus = convo.status;
          const currentAssignee = convo.assignedUserId;
          await this.db.$transaction(async (tx) => {
            const result = await tx.conversation.updateMany({
              where: {
                id: conversationId,
                teamId,
                assignedUserId: currentAssignee, // pin current owner
                status: previousStatus,
              },
              data: { status: "open" },
            });
            if (result.count === 0) return; // lost the CAS race — someone else changed status/assignee first
            const statusSnapshot = workflowConversationSnapshotAfterStatusChange(
              { ...convo, status: "open" },
              { previousStatus, changedByUserId: userId },
            );
            await publishInTx(tx, {
              type: "conversation.status_changed",
              teamId,
              conversationId,
              previousStatus,
              newStatus: "open",
              changedByUserId: userId,
              occurredAt: reopenedAt,
              contact: workflowContactSnapshot(convo.contact),
              conversation: statusSnapshot,
            });
          });
          return;
        }

        // Branch B: unassigned — claim + promote (existing path).
        // Same pending/closed → open flip assign() applies on a claim, so a
        // reply-claim leaves the thread in the identical state as the manual
        // path. (Open stays open.)
        const previousStatus = convo.status;
        const nextStatus = previousStatus !== "open" ? "open" : previousStatus;
        const statusChanged = nextStatus !== previousStatus;

        // Resolve the assignee snapshot BEFORE opening the tx — it's a
        // pure read against the same DB and keeps the tx body short.
        const assignee = await this.db.user.findFirst({
          where: { id: userId, teamId },
          select: {
            id: true,
            teamId: true,
            role: true,
            name: true,
            email: true,
            avatarUrl: true,
            deactivatedAt: true,
          },
        });
        const assignedUser: User | null = assignee
          ? {
              id: assignee.id,
              teamId: assignee.teamId,
              role: assignee.role,
              name: assignee.name,
              email: assignee.email,
              avatarUrl: assignee.avatarUrl ?? undefined,
              isActive: assignee.deactivatedAt === null,
            }
          : null;

        await this.db.$transaction(async (tx) => {
          const result = await tx.conversation.updateMany({
            where: { id: conversationId, teamId, assignedUserId: null, status: previousStatus },
            data: statusChanged
              ? { assignedUserId: userId, status: nextStatus }
              : { assignedUserId: userId },
          });
          if (result.count === 0) return; // lost the CAS race — someone else claimed/closed first

          // Snapshots reflect the row state AFTER the CAS update with
          // predicted analytics writes applied (assignmentsCount++,
          // lastAssignedAt = now, firstAssignedAt set-once). Workflow-dispatch
          // reads from these instead of a fresh DB read.
          const assignedSnapshot = workflowConversationSnapshotAfterAssign(
            {
              ...convo,
              assignedUserId: userId,
              status: nextStatus,
              assignedUser: assignee
                ? { id: assignee.id, name: assignee.name, email: assignee.email }
                : null,
            },
            null,
          );
          await publishInTx(tx, {
            type: "conversation.assigned",
            teamId,
            conversationId,
            assignedUser,
            previousAssignedUserId: null,
            newAssignedUserId: userId,
            changedByUserId: userId,
            occurredAt: selfAssignedAt,
            contact: workflowContactSnapshot(convo.contact),
            conversation: assignedSnapshot,
          });

          if (statusChanged) {
            const statusSnapshot = workflowConversationSnapshotAfterStatusChange(
              { ...convo, status: nextStatus, assignedUserId: userId },
              { previousStatus, changedByUserId: userId },
            );
            await publishInTx(tx, {
              type: "conversation.status_changed",
              teamId,
              conversationId,
              previousStatus,
              newStatus: nextStatus,
              changedByUserId: userId,
              occurredAt: reopenedAt,
              contact: workflowContactSnapshot(convo.contact),
              conversation: statusSnapshot,
            });
          }
        });
      } catch (err) {
        this.logger.debug(
          `autoAssignOnAgentSend failed for ${conversationId}: ${String(err)}`,
        );
      } finally {
        // Auto-claim/status side-effects publish via publishInTx — kick the
        // drainer so the conversation.assigned/status_changed webhooks dispatch
        // instantly too. finally covers both branches + the CAS-race no-op
        // (a kick with nothing to drain is a harmless cheap poll).
        kickOutbox();
      }
    })();
  }

  /**
   * Wait (poll) for the agent's just-sent OUTBOUND message to commit — the
   * latest outbound newer than `afterMs` (the conversation's lastMessageAt read
   * BEFORE the auto-claim ran). Lets the auto-claim pills anchor to the message's
   * real, monotonic, committed timestamp instead of a pre-send prediction, so
   * they sort strictly under the reply on EVERY view (refresh / teammate) even
   * when a customer inbound raced the send and pushed the message ts forward.
   *
   * Returns null on timeout (e.g. the send genuinely failed → no row commits) so
   * the caller falls back to the prediction. Bounded + cheap: the
   * `(conversationId, timestamp)` index covers the query, and ~3s is far longer
   * than a Meta round-trip yet short enough that a never-committing send can't
   * hang this fire-and-forget. Concurrent same-conversation sends only make the
   * latest-outbound ts MORE recent (monotonic), never older, so the anchor stays
   * at-or-after this send's own message.
   */
  private async waitForOutboundAfter(
    teamId: string,
    conversationId: string,
    afterMs: number,
  ): Promise<Date | null> {
    const after = new Date(afterMs);
    for (let i = 0; i < 25; i++) {
      const m = await this.db.message.findFirst({
        where: {
          teamId,
          conversationId,
          direction: "out",
          timestamp: { gt: after },
        },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      });
      if (m) return m.timestamp;
      await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  }

  /**
   * Free-form text send — public HTTP entry point.
   *
   * Two-phase contract introduced in S1 (audit follow-up):
   *
   *   1. Synchronous preflight — light parallel reads to surface 4xx-class
   *      errors inline (conversation not found, contact missing phone,
   *      24-hour window closed, reply target gone, WhatsApp not connected).
   *      The agent sees these in the same response shape as before.
   *
   *   2. Enqueue + return — the actual Meta send (~200-800ms) runs in the
   *      background `message-sends` worker. The HTTP response returns in
   *      ~5ms with `{ ok: true, clientTempId }`. The originating client's
   *      optimistic bubble already paints by clientTempId; the worker's
   *      `message.sent` publish reconciles it. On failure, the worker
   *      publishes `message.send_failed` which fans out as `message:failed`
   *      so the optimistic row flips to error state — mirrors the
   *      pre-queue inline-throw UX.
   *
   * `runWithSendIdempotency` still dedupes double-click / network-retry
   * before the enqueue; BullMQ's jobId on clientTempId is a second layer.
   */
  async sendText(
    teamId: string,
    userId: string,
    input: SendTextInput,
    isRetry = false,
  ): Promise<{ ok: true; clientTempId?: string }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: input.conversationId,
        clientTempId: input.clientTempId,
      },
      async () => {
        const pre = await this.preflightTextSend(teamId, input);
        try {
          await enqueueMessageSend({
            kind: "text",
            teamId,
            userId,
            conversationId: input.conversationId,
            channel: pre.channel,
            phoneNumber: pre.phoneNumber,
            body: input.body,
            replyToMessageId: pre.replyToMessageId,
            replyToExternalId: pre.replyToExternalId,
            clientTempId: input.clientTempId,
            receivedAt: new Date().toISOString(),
            isRetry,
          });
        } catch (err) {
          // Redis/queue down: the enqueue throws an ioredis error (bounded by
          // the connection's connect/command timeouts, so it can't hang).
          // Surface a typed 503 so the client shows "messaging temporarily
          // unavailable, retry" instead of a generic 500 — and so the reply-box
          // treats it as a clean failure. A retry is safe: BullMQ's jobId on
          // clientTempId dedupes if the job had partially landed.
          this.logger.error(
            `message enqueue failed (queue unavailable) for conversation ${input.conversationId}`,
            err instanceof Error ? err.stack : String(err),
          );
          throw new ServiceUnavailableException({
            error: "messaging_unavailable",
            detail: "Messaging is temporarily unavailable. Please retry.",
          });
        }
        // Mark-read + auto-assign are "the agent is engaging this thread" side
        // effects. They fire AFTER the preflight passes (a send REJECTED for
        // e.g. outside_24h_window must not claim/reopen the thread) AND AFTER
        // the enqueue succeeds (if the queue is down and the send can't even be
        // accepted, don't mark-read/assign a message that won't go out). Inside
        // the idempotency callback so a deduped double-click doesn't re-fire
        // them. Fire-and-forget (void); errors self-log.
        this.markReadOnAgentSend(teamId, userId, input.conversationId);
        this.autoAssignOnAgentSend(teamId, userId, input.conversationId);
        return {
          ok: true as const,
          ...(input.clientTempId ? { clientTempId: input.clientTempId } : {}),
        };
      },
    );
  }

  /**
   * Synchronous preflight for sendText. Surfaces deterministic 4xx errors
   * so the agent doesn't see the optimistic bubble paint then collapse to
   * failed 500ms later for cases we can detect up front (window closed,
   * missing phone, reply-target gone, WhatsApp unconfigured).
   *
   * Returns the resolved values the worker needs (phone number + reply
   * target ids) so the worker can skip the DB round-trip entirely —
   * everything we read here is threaded through the BullMQ payload. The
   * worker still verifies conversation existence (catches a deletion in
   * the queue gap) and re-loads Meta config (process-cached after the
   * first call, so steady-state cost is a Map lookup, not a query).
   */
  private async preflightTextSend(
    teamId: string,
    input: SendTextInput,
  ): Promise<{
    channel: Channel;
    phoneNumber: string;
    replyToMessageId: string | null;
    replyToExternalId?: string;
  }> {
    const { conversationId, replyToMessageId: replyToMessageIdRaw } = input;
    const [conversation, replyToRow] = await Promise.all([
      this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: {
          id: true,
          // Channel is conversation-owned — the preflight returns this provider
          // (resolveContactChannel below only supplies the destination address).
          channel: true,
          contact: {
            select: {
              phoneNumber: true,
              identityChannel: true,
              externalContactId: true,
              lastInboundAt: true,
            },
          },
        },
      }),
      replyToMessageIdRaw
        ? this.db.message.findFirst({
            where: { id: replyToMessageIdRaw, conversationId, teamId },
            select: { id: true, externalId: true },
          })
        : Promise.resolve(null),
    ]);
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // Resolve the destination ADDRESS from the contact identity. The PROVIDER
    // is conversation-owned (the row is the source of truth for which channel
    // this thread sends on); equal to the contact's by construction today.
    let channel;
    try {
      channel = resolveContactChannel(conversation.contact);
    } catch (err) {
      if (err instanceof NoChannelDestinationError) {
        throw new BadRequestException({
          error: "contact_has_no_phone",
          detail: "This contact has no reachable address.",
        });
      }
      throw err;
    }
    const provider = conversation.channel;
    const binding = getProviderBinding(provider);

    // Channel text-length cap (WhatsApp 4096, Messenger 2000, Instagram 1000).
    // Meta rejects an over-limit body with an opaque error deep in the worker;
    // fail fast here with an actionable 4xx instead. Capability-driven so a new
    // channel's limit is a data change, not a code branch.
    const tooLong = checkTextCap(input.body, binding.provider.capabilities, provider);
    if (tooLong) {
      throw new UnprocessableEntityException({
        error: "message_too_long",
        detail: tooLong.detail,
        max: tooLong.max,
      });
    }

    // Fail fast on a not-connected provider so the 4xx surfaces in the POST
    // response instead of as a queued job that fails in the worker. (The
    // config can't be prefetched in parallel with the conversation lookup
    // anymore — we need the contact's channel first — but a cached config is
    // a Map read, so the serialization cost is sub-millisecond steady-state.)
    try {
      await binding.getSendConfig(teamId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        // Channel-neutral key — this internal composer route (not /v1, whose
        // `whatsapp_not_connected` stays a contract) fires on any channel; the
        // web toast renders `error: detail`, so a WhatsApp-specific key read
        // wrong on an Instagram/Messenger thread. `err.message` is now
        // channel-aware (ProviderNotConfiguredError).
        throw new ConflictException({
          error: "channel_not_connected",
          detail: err.message,
        });
      }
      throw err;
    }

    // Free-form send window — driven by the provider capability; `null` skips.
    const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
    if (windowMs !== null) {
      const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail: "24-hour window closed — send an approved template to re-engage this contact.",
          lastInboundAt,
        });
      }
    }
    // Resolve the reply target FIRST. A flood of replies pointing at a
    // deleted message id would otherwise drain the per-conversation send
    // budget (30/min) without producing any DB writes or Meta calls —
    // legitimate replies then get false-positive rate-limited.
    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (replyToMessageIdRaw) {
      if (!replyToRow) {
        throw new BadRequestException({
          error: "reply_target_not_found",
          detail: "The message you're replying to no longer exists in this conversation.",
        });
      }
      replyToMessageId = replyToRow.id;
      if (!replyToRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyToRow.externalId;
      }
    }
    // Per-conversation send ceiling. Cheap second-axis bound that catches a
    // partner-driven hot-potato (their automation reacts to its own
    // `message.sent` webhook) inside one thread before the per-key 60/min
    // budget bites — a runaway loop now burns 30 sends/min/thread, not
    // 60/min/key. Throws ConversationSendRateLimitedError on hit; the
    // handler at the controller layer maps it to 429 + Retry-After.
    try {
      consumeConversationSendBudget(teamId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
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
    return {
      channel: provider,
      phoneNumber: channel.to,
      replyToMessageId,
      ...(replyToExternalId ? { replyToExternalId } : {}),
    };
  }

  /**
   * Worker-side executor. The HTTP preflight already verified the
   * conversation, the contact's phone, the 24h window, and the reply
   * target — the values needed at send time are all in the queue payload.
   * The worker's job is therefore narrow:
   *
   *   1. Verify the conversation still exists (catches a deletion between
   *      enqueue and pickup; without this the FK error would fire AFTER
   *      the Meta send and leave a "sent-to-customer-but-no-local-row"
   *      ghost).
   *   2. Resolve Meta credentials (process-cached, ~Map lookup in steady
   *      state — first call per team is one DB hit).
   *   3. Load the reply snapshot (cosmetic — the quote pill payload).
   *   4. Call Meta.
   *   5. Idempotent DB write + bus publish.
   *
   * The 24h-window re-check is gone: if the contact's window closes in
   * the queue gap (sub-second normally, an edge case at exactly
   * 23:59:59 → 00:00:00) Meta itself rejects with `outside_24h_window`,
   * which `normalizeMetaSendError` maps to a non-recoverable failure
   * that `categorizeSendError` flips into a `message.send_failed` event.
   * Same UX as the inline preflight, one less DB round-trip per send.
   *
   * `receivedAt` is stamped at HTTP arrival, not pickup, so the row's
   * `timestamp` and the conversation reorder match send order even when
   * the worker has a brief backlog.
   */
  async executeTextSendJob(
    data: import("./send-queue").SendTextJobData,
    jobId?: string,
  ): Promise<void> {
    const {
      teamId,
      userId,
      conversationId,
      body,
      clientTempId,
      phoneNumber,
      replyToMessageId,
      replyToExternalId,
    } = data;
    const receivedAt = new Date(data.receivedAt);
    // `provider` may be absent on jobs enqueued before the field existed —
    // default to Meta. The binding gives us provider + config loader.
    const channel: Channel = data.channel ?? "whatsapp";
    const binding = getProviderBinding(channel);

    // Cheap indexed existence check (no contact join, no select-all).
    // Conversation row gone → fail non-recoverable BEFORE we hit Meta so
    // we don't strand a customer with a message no agent can see.
    // Pull lastMessageAt for the timestamp-monotonicity guard further down.
    const [exists, configOrErr] = await Promise.all([
      this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: {
          id: true,
          lastMessageAt: true,
          contactId: true,
          // For the social RESPONSE-vs-Human-Agent-tag decision at send time.
          contact: { select: { lastInboundAt: true } },
        },
      }),
      binding.getSendConfig(teamId).catch((err: unknown) => {
        if (err instanceof ProviderNotConfiguredError) return err;
        throw err;
      }),
    ]);
    if (!exists) throw new NotFoundException({ error: "conversation not found" });
    if (configOrErr instanceof ProviderNotConfiguredError) {
      throw new ConflictException({
        error: "channel_not_connected",
        detail: configOrErr.message,
      });
    }
    const config = configOrErr;

    // Reply snapshot loads in parallel with the Meta send — pure cosmetic
    // payload for the quote pill; failure here degrades to a quoteless
    // bubble, never blocks the send.
    const replySnapshotPromise = replyToMessageId
      ? loadReplySnapshotById(teamId, replyToMessageId)
      : Promise.resolve(null);

    // BEFORE-Meta-call idempotency: try to insert an OutboundSendAttempt
    // row keyed by jobId. The first attempt succeeds and proceeds to call
    // Meta. A retry job (same jobId, after worker death) will P2002 on
    // this insert; we then inspect the existing row to decide what to do.
    //
    // If jobId is undefined (server-driven send with no clientTempId, no
    // BullMQ jobId — none today, but defensive) we skip the attempt log
    // entirely. The downstream DB unique constraint on externalId still
    // dedupes; we just don't get the "refuse to retry" protection.
    let attemptCreated = false;
    if (jobId) {
      try {
        await this.db.outboundSendAttempt.create({
          data: { jobId, teamId, conversationId },
        });
        attemptCreated = true;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          // Prior attempt exists. Two sub-cases:
          const prior = await this.db.outboundSendAttempt.findUnique({
            where: { jobId },
          });
          if (prior?.completedAt && prior.externalId) {
            // (a) Prior attempt succeeded — Meta already sent the message
            // and we recorded the wamid. Ensure the Message row exists, then
            // re-publish message.sent so the originating client gets the
            // bubble swap. Idempotent at the socket layer (frontend reducer
            // dedups by externalId).
            let existing = await this.db.message.findFirst({
              where: {
                teamId,
                channel,
                externalId: prior.externalId,
              },
            });
            if (!existing) {
              // No Message row despite a completed attempt: a crash/rollback
              // landed between the (pre-insert) attempt stamp and a committed
              // Message insert. Meta ALREADY delivered this wamid, so we must
              // NOT re-call Meta — re-insert idempotently from the recorded
              // externalId instead. createOutboundMessageIdempotent dedups on
              // (teamId, channel, externalId), so a concurrent recovery is
              // harmless. This closes the ghost+double-send window: pre
              // 2026-07-02 this fell through to `send_in_progress_or_lost`,
              // which surfaced as a Failed bubble and drove the agent to
              // re-send a message Meta had already delivered.
              const recoveredTs =
                exists.lastMessageAt && exists.lastMessageAt >= receivedAt
                  ? new Date(exists.lastMessageAt.getTime() + 1)
                  : receivedAt;
              existing = await createOutboundMessageIdempotent({
                teamId,
                conversationId,
                externalId: prior.externalId,
                senderUserId: userId,
                body,
                direction: "out",
                channel,
                status: "sent",
                rawPayload: {
                  sentVia: "api/messages",
                } as Prisma.InputJsonValue,
                timestamp: recoveredTs,
                ...(replyToMessageId ? { replyToMessageId } : {}),
              });
            }
            {
              const replySnapshot = await replySnapshotPromise;
              const replayed: Message = {
                id: existing.id,
                teamId: existing.teamId,
                conversationId: existing.conversationId,
                externalId: existing.externalId ?? prior.externalId,
                senderUserId: existing.senderUserId,
                body: existing.body,
                direction: existing.direction,
                channel: existing.channel,
                status: existing.status,
                rawPayload: existing.rawPayload as Record<string, unknown>,
                timestamp: existing.timestamp.toISOString(),
                ...(existing.replyToMessageId
                  ? {
                      replyToMessageId: existing.replyToMessageId,
                      replyTo: replySnapshot ?? null,
                    }
                  : {}),
              };
              // publish() (not publishInTx) — this is a recovery re-emit for a
              // client whose first delivery may have been lost. It exists ONLY
              // to re-drive the client bubble, so suppress the side-effecting
              // subscribers: `silent` skips workflow dispatch (no re-trigger on
              // a replay) and `skipOutboundWebhook` skips the partner re-POST
              // (the original send already delivered it). Analytics may still
              // double-count by +1 in this rare crash-race; that's the benign
              // residue (a counter, no external side effect) and not worth a
              // dedicated analytics-suppress path. The audit row may likewise
              // dupe — accepted, because the alternative is the client UI never
              // showing the bubble.
              await publish({
                type: "message.sent",
                teamId,
                conversationId: existing.conversationId,
                contactId: exists.contactId,
                message: replayed,
                preview: existing.body.slice(0, 200),
                senderUserId: userId,
                // This message IS the conversation's latest; an agent send is
                // read (markReadOnAgentSend), so unread is 0. (The pre-existing
                // code omitted both — the `as` cast hid that the realtime list
                // row got undefined lastMessageAt/unreadCount on this path.)
                lastMessageAt: existing.timestamp.toISOString(),
                unreadCount: 0,
                silent: true,
                skipOutboundWebhook: true,
                ...(clientTempId ? { clientTempId } : {}),
              } as DomainEventOf<"message.sent">);
              return;
            }
          }
          // (b) Prior attempt incomplete and AMBIGUOUS — Meta MAY have already
          // sent the message. Reached for the AMBIGUOUS failure classes whose
          // prior catch KEPT the row: a Meta 5xx (Meta may have accepted then
          // errored its response) or a transport error / timeout with
          // `failedAt` stamped, plus a death mid-Meta-fetch (no failedAt, no
          // completedAt). A PROVABLY-NOT-SENT rejection (Meta <500 / rate_limit)
          // DELETED its row in the prior catch, so its retry re-creates the row
          // fresh above and never lands here. Refusing to retry here avoids the
          // rare double-send. Non-recoverable so BullMQ stops retrying; the worker
          // categorizes this `error` field as non-recoverable, publishes
          // message.send_failed, and the client's failed-bubble UI lets
          // the user retry with a new clientTempId.
          throw new UnprocessableEntityException({
            error: "send_in_progress_or_lost",
            message:
              "A previous attempt for this message may have already reached WhatsApp. Refusing to retry to avoid a duplicate send. Re-send to try again.",
            status: 409,
          });
        }
        throw err;
      }
    }

    const useHumanAgentTag = outsideFreeFormWindow(
      binding.provider.capabilities.freeFormWindowMs,
      exists.contact?.lastInboundAt?.toISOString() ?? null,
    );

    let send;
    try {
      send = await binding.provider.sendText(
        {
          to: phoneNumber,
          body,
          useHumanAgentTag,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
      const normalized = normalizeMetaSendError(err);
      // The OutboundSendAttempt row is the double-send guard. How we treat it on
      // failure decides whether a BullMQ retry can SAFELY re-send:
      //
      //  - PROVABLY-NOT-SENT — Meta returned a non-2xx response BELOW 500, or an
      //    explicit rate-limit. The message was definitively not accepted →
      //    DELETE the row so a retry re-creates it and actually re-sends.
      //    (Business 4xx is classified non-recoverable so no retry fires anyway;
      //    `rate_limited` IS recoverable and safe to re-send — Meta never
      //    processed it.) This is what makes a rate-limited send actually retry
      //    instead of dying in branch (b) as `send_in_progress_or_lost`.
      //  - AMBIGUOUS — a Meta 5xx (Meta MAY have accepted the message then
      //    errored its RESPONSE) OR a transport error / timeout (`normalized`
      //    null). KEEP the row + stamp `failedAt` so the P2002 guard's branch (b)
      //    REFUSES the retry. Both classes are `recoverable` per
      //    categorizeSendError, so deleting the row would let the retry re-POST
      //    and DOUBLE-SEND (no idempotency key, no externalId captured yet). A
      //    one-shot failed bubble the agent can re-send beats a duplicate
      //    WhatsApp message.
      const provablyNotSent =
        !!normalized &&
        (normalized.httpStatus < 500 || normalized.code === "rate_limited");
      if (attemptCreated && jobId) {
        if (provablyNotSent) {
          await this.db.outboundSendAttempt
            .delete({ where: { jobId } })
            .catch(() => undefined);
        } else {
          await this.db.outboundSendAttempt
            .update({
              where: { jobId },
              data: {
                failedAt: new Date(),
                failureReason: (err instanceof Error
                  ? err.message
                  : String(err)
                ).slice(0, 500),
              },
            })
            .catch(() => undefined);
        }
      }
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      this.logger.error("sendText failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Timestamp monotonicity guard — outbound must sort strictly after any
    // inbound it might be responding to. Meta's webhook timestamps are
    // second-precision (rounded), so an outbound landing in the same
    // second can otherwise sort BEFORE the inbound. See
    // send-text-internal.ts for the full rationale.
    const messageTimestamp =
      exists.lastMessageAt && exists.lastMessageAt >= receivedAt
        ? new Date(exists.lastMessageAt.getTime() + 1)
        : receivedAt;
    // Stamp completedAt + externalId on the attempt row in its OWN committed
    // write BEFORE the Message insert. This is the load-bearing idempotency
    // fact: once Meta has accepted the send, the wamid must survive even if
    // the insert below fails. With the stamp already committed, a BullMQ
    // retry lands in branch (a) above and RE-INSERTS from the known
    // externalId — it never re-calls Meta and never refuses.
    //
    // Pre-2026-07-02 the stamp lived INSIDE a shared tx with the insert. A
    // transient P2024/P1017 on the insert rolled the stamp back too (the
    // attempt row was created outside the tx, so it survived as incomplete),
    // stranding the retry in the `send_in_progress_or_lost` refuse path →
    // Failed bubble → agent re-send → duplicate WhatsApp message. Splitting
    // the writes + recovering in branch (a) closes that window.
    if (attemptCreated && jobId) {
      // Ignore failures (e.g. attempt row vanished) — the Message insert is
      // the load-bearing write and branch (a) re-inserts if it's ever missing.
      await this.db.outboundSendAttempt
        .update({
          where: { jobId },
          data: { completedAt: new Date(), externalId: send.externalId },
        })
        .catch((err) => {
          this.logger.warn(
            `OutboundSendAttempt completed-stamp failed for jobId=${jobId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
    }
    // No tx: createOutboundMessageIdempotent's internal retry-with-backoff
    // (5 attempts, ~3s) absorbs transient DB errors (Postgres restart / pool
    // blip) instead of bubbling them to a jobId retry that would refuse. A
    // hard crash between the stamp and a committed insert is recovered
    // idempotently by branch (a).
    const [created, replySnapshot] = await Promise.all([
      createOutboundMessageIdempotent({
        teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: userId,
        body,
        direction: "out",
        channel,
        status: "sent",
        rawPayload: { sentVia: "api/messages" } as Prisma.InputJsonValue,
        timestamp: messageTimestamp,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      }),
      replySnapshotPromise,
    ]);

    const preview = body.slice(0, 200);
    const message: Message = {
      id: created.id,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body,
      direction: "out",
      channel,
      status: "sent",
      rawPayload: { sentVia: "api/messages" },
      timestamp: messageTimestamp.toISOString(),
      ...(replyToMessageId
        ? { replyToMessageId, replyTo: replySnapshot ?? null }
        : {}),
    };

    // Conversation bump + `message.sent` outbox row commit atomically.
    // Drainer picks up the row ~100ms after commit and dispatches every
    // subscriber. Trades a few ms of HTTP latency for durable realtime —
    // a crash here loses neither the bump nor the event.
    try {
      await this.commitOutboundEvent({
        conversationId,
        bumpTimestamp: messageTimestamp,
        preview,
        event: {
          type: "message.sent",
          teamId,
          conversationId,
          contactId: exists.contactId,
          message,
          preview,
          senderUserId: userId,
          ...(clientTempId ? { clientTempId } : {}),
        },
      });
    } catch (err) {
      // Message row is durable; only the bump + outbox row failed. Log
      // and continue — the next inbound or cold load will reconcile the
      // conversation summary, and the operator can spot the gap by
      // grepping for this exact log line.
      this.logger.error(
        `sendText commit failed for message=${created.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Outbound media send. Same shape as /api/messages/media POST:
   *
   *   A. Pre-flight: conversation, 24h window, replyTo, send config.
   *   B. PARALLEL: Meta /media upload AND blob-storage upload (both pure
   *      functions of bytes; critical path was sum, now is max).
   *   C. Meta /messages send referencing the uploaded mediaId.
   *   D. Post-send (cannot throw back to agent — a 5xx would prompt a retry
   *      that double-sends to the customer on WhatsApp):
   *      i.   Resolve blob upload — degrade to text-only on blob failure.
   *      ii.  Idempotent DB insert; degrade response if DB hiccups.
   *      iii. Publish `message.sent` and fire-and-forget the conversation
   *           summary bump.
   *
   * Returns `{ messageId, warning? }`. A non-null `warning` means the message
   * landed on WhatsApp but local persistence partially failed — surface to the
   * agent so they know NOT to retry (which would double-send).
   */
  async sendMedia(
    teamId: string,
    userId: string,
    form: SendMediaFormInput,
    file: Express.Multer.File,
  ): Promise<{ messageId: string | null; warning?: string }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: form.conversationId,
        clientTempId: form.clientTempId,
      },
      async () => {
        const result = await this.sendMediaInner(teamId, userId, form, file);
        // After validation+enqueue succeeded — mark-read + auto-assign only on
        // an accepted send, not on one the inner path rejected (window closed,
        // missing phone, etc.). See sendText for the full rationale.
        this.markReadOnAgentSend(teamId, userId, form.conversationId);
        this.autoAssignOnAgentSend(teamId, userId, form.conversationId);
        return result;
      },
    );
  }

  private async sendMediaInner(
    teamId: string,
    userId: string,
    form: SendMediaFormInput,
    file: Express.Multer.File,
  ): Promise<{ messageId: string | null; warning?: string }> {
    try {
      return await this.sendMediaWithTempFile(teamId, userId, form, file);
    } finally {
      // Disk-backed multer wrote the multipart payload to file.path. Whether
      // the send succeeded, threw mid-flight, or the agent disconnected,
      // unlink the temp file so we don't accumulate orphan blobs in /tmp
      // (a steady 100 MB/upload leak over a shift on a small VPS).
      // Best-effort: ENOENT (already-removed) and EACCES are non-fatal here.
      if (file.path) {
        unlink(file.path).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.warn(
              `tempfile cleanup failed for ${file.path}: ${err instanceof Error ? err.message : err}`,
            );
          }
        });
      }
    }
  }

  /**
   * Best-effort outbound video poster. Mirrors the inbound ingest path
   * (meta.controller.ts): extract a JPEG first frame, store it, and stamp
   * `mediaThumbnailUrl` so the gallery + quoted-reply render a lightweight
   * poster instead of pointing an <img> at the raw video. Runs AFTER the send
   * is persisted and is fire-and-forget: it must never block the agent's
   * response nor throw — a post-send throw would bubble as a 5xx the UI
   * retries → a duplicate Meta send. ffmpeg failure / corrupt video simply
   * leaves the field null and the client falls back to the <video> first frame.
   */
  private async storeOutboundVideoPoster(
    messageId: string,
    teamId: string,
    bytes: Uint8Array,
    toPhone: string,
    toName: string | null,
    label: string,
  ): Promise<void> {
    try {
      const poster = await extractVideoPosterFrame(bytes);
      if (!poster || poster.length === 0) return;
      const team = await this.db.team
        .findUnique({ where: { id: teamId }, select: { name: true } })
        .catch(() => null);
      const thumb = await blobStorage.upload({
        bytes: poster,
        mimeType: "image/jpeg",
        kind: "image",
        context: {
          teamId,
          teamSlug: team?.name,
          direction: "out",
          contactPhone: toPhone,
          contactName: toName ?? undefined,
          // Suffix so the dashboard filename is distinct from the video blob.
          externalId: `${label}_thumb`,
          originalFilename: null,
        },
      });
      const updated = await this.db.message.update({
        where: { id: messageId },
        data: { mediaThumbnailUrl: thumb.url, mediaThumbnailKey: thumb.key },
        select: {
          conversationId: true,
          mediaMimeType: true,
          mediaSizeBytes: true,
          mediaCaption: true,
        },
      });
      // Patch the LIVE thread so the just-sent video gains its poster without a
      // page refresh — the same `message:media:ready` frame the inbound 2-phase
      // path uses. Without this the agent's own outbound video sits as a bare
      // bg-black box (preload="none" → no first frame) until they reload, while
      // the customer's inbound video shows a poster: the asymmetry the user
      // reported. `applyMessageMediaReady` (thread-reducers) REPLACES the whole
      // media block, so carry every field the bubble needs PLUS the new
      // thumbnailUrl. Best-effort: a publish failure must never bubble (this
      // runs post-send; a throw here → 5xx → UI retry → duplicate Meta send).
      await this.bus
        .publish({
          type: "message.media_ready",
          teamId,
          conversationId: updated.conversationId,
          messageId,
          media: {
            kind: "video",
            url: `/api/media/${messageId}`,
            thumbnailUrl: `/api/media/${messageId}/thumb`,
            mimeType: updated.mediaMimeType ?? "video/mp4",
            sizeBytes: updated.mediaSizeBytes ?? 0,
            ...(updated.mediaCaption ? { caption: updated.mediaCaption } : {}),
          },
        })
        .catch(() => {});
    } catch (err) {
      this.logger.warn(
        `[${teamId}] outbound video poster generation failed for message ${messageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async sendMediaWithTempFile(
    teamId: string,
    userId: string,
    form: SendMediaFormInput,
    file: Express.Multer.File,
  ): Promise<{ messageId: string | null; warning?: string }> {
    const receivedAt = new Date();
    const { conversationId, caption, clientTempId, replyToMessageId: replyToMessageIdRaw } = form;

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        contactId: true,
        // Channel is conversation-owned — bind + stamp the send from here.
        channel: true,
        // For the timestamp monotonicity guard further down — outbound
        // must sort strictly after any inbound it might be responding to.
        lastMessageAt: true,
        contact: {
          select: {
            phoneNumber: true,
            identityChannel: true,
            externalContactId: true,
            name: true,
            lastInboundAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    let channel;
    try {
      channel = resolveContactChannel(conversation.contact);
    } catch (err) {
      if (err instanceof NoChannelDestinationError) {
        throw new BadRequestException({
          error: "contact_has_no_phone",
          detail: "This contact has no reachable address.",
        });
      }
      throw err;
    }
    const provider = conversation.channel;
    const binding = getProviderBinding(provider);

    // Free-form send window — media (like free-form text) is template-only
    // outside it. Driven by the provider capability; `null` skips the check.
    const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
    if (windowMs !== null) {
      const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail:
            "24-hour window closed — media can't be sent freely. Use an approved template to re-engage.",
          lastInboundAt,
        });
      }
    }

    // Meta social: within the 24h free-form window → RESPONSE; in the 24h–7d
    // support band → Human Agent tag. (WhatsApp ignores the flag.)
    const useHumanAgentTag = outsideFreeFormWindow(
      binding.provider.capabilities.freeFormWindowMs,
      conversation.contact.lastInboundAt?.toISOString() ?? null,
    );

    // Same per-conversation send ceiling as sendText. Catches partner-driven
    // hot-potato loops at the thread level (30/min/thread) before the per-key
    // bucket bites.
    try {
      consumeConversationSendBudget(teamId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
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

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (replyToMessageIdRaw) {
      const replyToRow = await this.db.message.findFirst({
        where: { id: replyToMessageIdRaw, conversationId, teamId },
        select: { id: true, externalId: true },
      });
      if (replyToRow) {
        replyToMessageId = replyToRow.id;
        // Don't forward a placeholder externalId to Meta (would 400 it). The
        // reply snapshot still resolves locally; we just don't quote on the
        // wire when the parent is still pending-send.
        if (!replyToRow.externalId.startsWith("tmp_")) {
          replyToExternalId = replyToRow.externalId;
        }
      }
    }

    // Strip codec parameters (`audio/ogg;codecs=opus` → `audio/ogg`). Meta's
    // `/media` upload reads the `type` form field strictly; the codec suffix
    // that Chrome's MediaRecorder emits is enough to make it reject the
    // payload with a non-obvious error. Blob storage was already tolerant
    // (splits on `;` for its allowlist check) — Meta isn't.
    // `let` so the voice-note transcode below can rewrite it to audio/ogg.
    let mimeType = normalizeMimeType(file.mimetype);
    const kind = kindFromMime(mimeType);
    // Per-channel caps + allow-lists — Messenger/Instagram accept larger files
    // (and a different audio set) than WhatsApp, so reusing WhatsApp's caps
    // would wrongly reject valid social media.
    const policy = mediaPolicyForChannel(provider);
    // Per-channel supported-KIND gate (coarser than size/mime). Instagram DM
    // can't send documents at all, so reject one up front with an actionable
    // error instead of shipping a nameless by-URL "file" Meta rejects with #100.
    if (!channelSupportsMediaKind(provider, kind)) {
      throw new BadRequestException({
        error: "media_kind_unsupported",
        detail: `${policy.label} doesn't support sending ${kind === "document" ? "documents" : `${kind}s`}.`,
      });
    }
    const cap = policy.caps[kind];
    if (file.size > cap) {
      throw new PayloadTooLargeException({
        error: `file too large for ${kind}: ${file.size} bytes > ${cap}`,
        cap,
      });
    }
    // Images: Instagram accepts ONLY png/jpeg (a gif/webp image is rejected by
    // Meta with an opaque #100). WhatsApp/Messenger take the common web set. Gate
    // up front with an actionable error instead of a mystery failure at send.
    if (kind === "image" && !policy.imageMime.has(mimeType)) {
      throw new BadRequestException({
        error: "invalid_image_mime",
        detail:
          `${policy.label} doesn't accept ${mimeType || "this image format"}. ` +
          `Supported: ${[...policy.imageMime].map((m) => m.replace("image/", "")).join(", ")}.`,
      });
    }
    // Stickers: Meta only accepts `image/webp`. Reject other types up front
    // with a clear error instead of letting Meta reject with opaque code 100.
    if (kind === "sticker" && mimeType.toLowerCase() !== "image/webp") {
      throw new BadRequestException({
        error: "invalid_sticker_mime",
        detail: `${policy.label} stickers must be image/webp (got ${mimeType}).`,
      });
    }
    // A genuine recording (`form.voice`) is transcoded to a channel-valid
    // container further down, so its INCOMING mime says nothing about whether we
    // can deliver it. Gating it here rejected Firefox's `audio/ogg` on Instagram
    // before it ever reached the AAC transcode written for exactly that case.
    // Recordings are validated AFTER transcode instead; see below.
    const isRecording = kind === "audio" && form.voice === true;
    // Instagram sends audio by URL and accepts ONLY aac / m4a / wav / mp4. Unlike
    // the other channels we DON'T reject an incompatible IG audio upload (mp3,
    // webm, …) up front — we TRANSCODE it to M4A below so it actually delivers.
    const igAudio =
      kind === "audio" && binding.provider.capabilities.mediaSendByUrl === true;

    // Audio FILES the user picked (not recordings): Meta only accepts a specific
    // mime set per channel. `audio/webm` in particular is a frequent silent
    // failure — uploads succeed, then Meta returns a confusing
    // `provider_rejected` at send time. Block it here with a clear error. The
    // blob-storage allowlist still permits webm (so we can debug-replay), but we
    // won't push it to Meta. Instagram is exempt — its incompatible uploads are
    // transcoded to M4A below rather than rejected.
    if (kind === "audio" && !isRecording && !igAudio && !policy.audioMime.has(mimeType)) {
      throw new BadRequestException({
        error: "invalid_audio_mime",
        detail:
          `${policy.label} doesn't accept ${mimeType || "this audio format"}. ` +
          `Supported: ${[...policy.audioMime].join(", ")}.`,
      });
    }
    // Documents: kindFromMime is a catch-all (anything not image/video/audio
    // lands here), so without an explicit allowlist arbitrary file types would
    // be accepted + stored before Meta rejects them on send. Gate to Meta's
    // supported document set.
    if (kind === "video" && !policy.videoMime.has(mimeType)) {
      throw new BadRequestException({
        error: "unsupported_file_type",
        detail:
          `${policy.label} doesn't accept ${mimeType || "this video format"}. ` +
          `Supported: ${[...policy.videoMime].map((m) => m.replace("video/", "")).join(", ")}.`,
      });
    }
    if (kind === "document" && !policy.documentMime.has(mimeType)) {
      // Instagram accepts only PDF; WhatsApp/Messenger accept the fuller office set.
      const supported = policy.documentMime.has("application/pdf") && policy.documentMime.size === 1
        ? "PDF"
        : "PDF, Word, Excel, PowerPoint, plain text, CSV";
      throw new BadRequestException({
        error: "unsupported_file_type",
        detail:
          `${policy.label} doesn't support ${mimeType || "this file type"} as a document. ` +
          `Supported: ${supported}.`,
      });
    }

    // Read the disk-backed multer temp file ONCE into a single Buffer that
    // both Meta upload + blob-storage upload share. file.buffer is empty
    // under diskStorage; file.path is the temp location set by the
    // controller's diskStorage config. The previous memoryStorage code
    // path pinned ~3x file size in V8 heap during the parallel uploads
    // (multer buffer + Meta Blob copy + blob-storage Blob copy); reading
    // once here + reusing the buffer drops peak to ~1x while the two
    // providers run, since both internal Blobs copy from the same source
    // synchronously per provider but the source itself is shared.
    let bytes = new Uint8Array(await readFile(file.path));
    // `let` so the transcode below can rename the extension to match the new
    // container — Meta keys media type partly off the filename extension, and a
    // `.m4a` name on transcoded ogg bytes makes it reject as octet-stream.
    let filename = file.originalname || "upload";

    // Voice notes must be ogg/opus to DELIVER on WhatsApp. Firefox records that
    // natively; Chrome/Safari can only record audio/mp4, which Meta accepts then
    // fails to DELIVER. Transcode genuine recordings (`form.voice` is the FE's
    // "this is a recording" marker) that aren't already ogg → ogg/opus so they
    // deliver on every browser. We send them as a regular audio clip (NOT a
    // voice note — see the sendMedia call below for why). Uploaded audio FILES
    // (form.voice=false — a user picked an mp3/m4a) are left alone: they deliver
    // fine already. Best-effort: if ffmpeg is missing/fails we log + send original.
    // Voice notes need a per-channel container. Instagram's URL-fetch validator
    // REJECTS ogg/webm AND bare ADTS `.aac` with `#100 attachment format is not
    // supported`, but reliably accepts M4A (AAC in an MP4 container — audio/mp4,
    // in IG's documented aac/m4a/wav/mp4 set); WhatsApp needs ogg/opus to
    // DELIVER (Messenger accepts ogg too, via its upload path). So URL-based
    // channels (Instagram) get M4A, everyone else gets ogg/opus.
    //
    // Instagram: transcode to M4A whenever the source isn't ALREADY an
    // IG-accepted format — i.e. every recording (browser mp4/webm containers are
    // fragmented/unreliable over IG's fetcher) AND any incompatible upload
    // (mp3/webm/…). A real, already-compatible upload (mp4/aac/wav) passes
    // through untouched.
    if (igAudio && (isRecording || !policy.audioMime.has(mimeType))) {
      try {
        bytes = await transcodeToM4a(bytes);
        mimeType = "audio/mp4";
        filename = filename.replace(/\.[^./\\]+$/, "") + ".m4a";
      } catch (err) {
        this.logger.warn(
          `IG audio transcode to M4A failed; sending original ${mimeType}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else if (isRecording && mimeType !== "audio/ogg") {
      try {
        bytes = await transcodeToOggOpus(bytes);
        mimeType = "audio/ogg";
        // Rename the extension to match the new container. Without this the
        // file keeps its recorder extension (e.g. Chrome's `.m4a`) on ogg
        // bytes, and Meta rejects it as application/octet-stream (#131053).
        filename = filename.replace(/\.[^./\\]+$/, "") + ".ogg";
      } catch (err) {
        this.logger.warn(
          `voice transcode to ogg/opus failed; sending original ${mimeType}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Recordings (and IG audio uploads) skipped the up-front mime gate because
    // the transcode above is what makes them deliverable. Now that it has run (or
    // best-effort failed), hold the RESULT to the channel's allow-list —
    // otherwise a failed transcode silently ships a container Meta will reject at
    // send time.
    if ((isRecording || igAudio) && !policy.audioMime.has(mimeType)) {
      throw new BadRequestException({
        error: "invalid_audio_mime",
        detail:
          `This audio couldn't be converted to a format ${policy.label} accepts ` +
          `(got ${mimeType || "an unknown format"}; supported: ${[...policy.audioMime].join(", ")}). ` +
          "Please try again, or attach a different audio file.",
      });
    }
    // VERIFY-IN-PROD breadcrumb (2026-05-26 iOS voice-note fix): make the exact
    // path obvious in journald so a test send is diagnosable at a glance.
    // mono/voip ogg + voice:true is the iOS-playable profile but a past session
    // saw Meta #131053 reject mono/voip on upload — if THAT regresses, the
    // `audio uploadMedia failed` log below carries Meta's raw error; if it
    // uploads but won't deliver, meta.ts logs the status-webhook errors[].
    if (kind === "audio") {
      const willSendAsVoice =
        VOICE_IOS_PROFILE && isRecording && mimeType === "audio/ogg";
      this.logger.log(
        `audio send: recording=${isRecording} mime=${mimeType} iosProfile=${VOICE_IOS_PROFILE} voiceNote=${willSendAsVoice}`,
      );
    }

    const toPhone = channel.to;
    const toName = conversation.contact.name;

    let sendConfig;
    try {
      sendConfig = await binding.getSendConfig(teamId);
    } catch (err) {
      throw new ConflictException({
        error: "WhatsApp is not connected for this team",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Optional methods — a channel without media support raises a typed error.
    const uploadMedia = requireProviderMethod(binding.provider, "uploadMedia", provider);
    const sendMedia = requireProviderMethod(binding.provider, "sendMedia", provider);

    // Parallel: Meta /media upload AND blob-storage upload. Both pure
    // functions of `bytes`. The team lookup that the blob context needs
    // also kicks off concurrently so it doesn't serialize the upload.
    const blobLabelId = clientTempId ?? randomUUID();
    const teamRowPromise = this.db.team
      .findUnique({ where: { id: teamId }, select: { name: true } })
      .catch(() => null);

    const blobUploadPromise = (async () => {
      const teamRow = await teamRowPromise;
      return blobStorage.upload({
        bytes,
        mimeType,
        kind,
        context: {
          teamId,
          teamSlug: teamRow?.name,
          direction: "out",
          contactPhone: toPhone,
          contactName: toName,
          conversationId,
          // No wamid yet — Meta hasn't returned one. Use client temp id (or
          // a generated uuid) so the dashboard filename is still unique and
          // traceable. Not used for retrieval — purely metadata.
          externalId: blobLabelId,
          originalFilename: filename,
        },
      });
    })();

    // 1) Prepare the media reference for the send. Pre-send: throwing is safe.
    //    URL-based channels (Instagram) presign the just-stored object so Meta
    //    fetches it directly — the reusable attachment_id path errors on IG.
    //    Upload-based channels (WhatsApp / Messenger) push the bytes to Meta.
    const byUrl = binding.provider.capabilities.mediaSendByUrl === true;
    let mediaId = "";
    let mediaUrl: string | undefined;
    if (byUrl) {
      try {
        const blob = await blobUploadPromise;
        // Meta fetches the URL asynchronously and may retry over minutes; give it
        // a generous 1h window so a slow/retried fetch can't expire mid-flight.
        // For DOCUMENTS, attach the real filename via Content-Disposition — Meta
        // reads it when fetching the URL and shows it to the recipient. Without
        // this the recipient sees the hashy R2 key name (`<id>-document.pdf`).
        mediaUrl = await blobStorage.presignGetUrl(blob.key, {
          ttlSeconds: 3600,
          ...(kind === "document" ? { downloadFilename: filename } : {}),
        });
      } catch (err) {
        throw new UnprocessableEntityException({
          error: "media_url_unavailable",
          message: "Couldn't prepare the media for sending. Please retry.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      try {
        const uploaded = await uploadMedia({ bytes, mimeType, filename }, sendConfig);
        mediaId = uploaded.mediaId;
      } catch (err) {
        // Don't let the parallel blob upload leak as an unhandledRejection on
        // the early-return path.
        blobUploadPromise.catch(() => {});
        // Audio is the format-fragile path (MediaRecorder containers, codec
        // params, voice-note encoding rules). Log the raw Meta error verbatim
        // so a failed voice note is diagnosable from journald instead of the
        // generic normalized code the agent sees.
        if (kind === "audio") {
          this.logger.error(
            `audio uploadMedia failed: mime=${mimeType} size=${file.size} voice=${form.voice} :: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const normalized = normalizeMetaSendError(err);
        if (normalized) {
          throw new UnprocessableEntityException({
            error: normalized.code,
            message: normalized.message,
            status: normalized.httpStatus,
            detail: normalized.detail,
          });
        }
        throw err;
      }
    }

    // Whether Meta accepts this caption INLINE on the media (WhatsApp
    // image/video/document only). When it doesn't — WhatsApp audio/sticker, ALL
    // Messenger/Instagram media — the file is sent ON ITS OWN: no caption
    // ride-along, and no separate follow-up text (which echoed back as a corrupt
    // "via app" duplicate on social). Text with a file is a separate agent send.
    const inlineCaption = supportsInlineCaption(provider, kind);

    // 2) Send the message referencing that mediaId. Same logic — throwing
    //    pre-send is fine.
    let send;
    try {
      send = await sendMedia(
        {
          to: toPhone,
          kind,
          mediaId,
          ...(mediaUrl ? { mediaUrl } : {}),
          useHumanAgentTag,
          caption: inlineCaption ? caption || undefined : undefined,
          filename: kind === "document" ? filename : undefined,
          ...(replyToExternalId ? { replyToExternalId } : {}),
          // VOICE NOTE flag — GATED behind WHATSAPP_VOICE_IOS_PROFILE (off by
          // default). When on, genuine ogg recordings send as a WhatsApp voice
          // note, which (with the mono/voip transcode profile) is what iOS
          // needs to PLAY them — a plain clip plays on Android/Mac but iOS shows
          // "This audio is no longer available" (2026-05-26 bug). Off by
          // default because a past session saw voice:true give intermittent
          // delivery (3/5) and Meta reject mono/voip uploads (#131053); UNTESTED
          // since the metadata-strip fix. See VOICE_IOS_PROFILE doc in
          // audio-transcode.ts for the test+promote plan.
          //
          // Guard: ONLY flag voice when the bytes are actually audio/ogg —
          // voice:true on audio/mp4 is itself a Meta reject, so a failed
          // transcode falls back to a plain clip, never a guaranteed failure.
          voice:
            VOICE_IOS_PROFILE && isRecording && mimeType === "audio/ogg"
              ? true
              : undefined,
        },
        sendConfig,
      );
    } catch (err) {
      blobUploadPromise.catch(() => {});
      if (kind === "audio") {
        this.logger.error(
          `audio sendMedia failed: mime=${mimeType} mediaId=${mediaId} voice=${form.voice} :: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      // Un-normalized (e.g. a social Graph error) — surface Meta's actual
      // message instead of a bare 500, so the agent sees WHY (and it's
      // diagnosable). Pre-send: safe to throw, nothing went out.
      this.logger.warn(
        `media send failed (channel=${provider}): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnprocessableEntityException({
        error: "media_send_failed",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 400),
      });
    }

    // ── Post-send: Meta has accepted. From here NOTHING is allowed to throw
    // back to the agent. A 5xx would trigger a UI retry → second Meta send →
    // duplicate on the customer's WhatsApp. Degrade silently instead.

    let saved: { key: string; url: string; sizeBytes: number } | null = null;
    try {
      saved = await blobUploadPromise;
    } catch (err) {
      this.logger.error(
        `blob upload failed AFTER successful Meta send (wamid=${send.externalId}); persisting row without local media to avoid duplicate retry`,
        err,
      );
    }

    // The media row carries a caption only when Meta inlines it (see
    // `inlineCaption` above); otherwise the file was sent on its own and the row
    // has no caption body.
    const mediaBody = inlineCaption ? caption : "";
    const previewBody = (mediaBody || mediaPreview(kind)).slice(0, 200);

    // Timestamp monotonicity guard — see send-text-internal.ts for full
    // rationale. Outbound must sort strictly after any inbound in the
    // same second.
    const messageTimestamp =
      conversation.lastMessageAt && conversation.lastMessageAt >= receivedAt
        ? new Date(conversation.lastMessageAt.getTime() + 1)
        : receivedAt;

    const created = await createOutboundMessageIdempotent({
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body: mediaBody,
      direction: "out",
      channel: provider,
      status: "sent",
      rawPayload: {
        sentVia: "api/messages/media",
        mediaId,
        ...(saved ? {} : { blobUploadFailed: true }),
      } as Prisma.InputJsonValue,
      timestamp: messageTimestamp,
      // Persist media columns only when the blob upload succeeded. The
      // mapMessage path (lib/queries/_shared.ts) treats `mediaKind &&
      // !mediaUrl` as "still downloading" — writing them unconditionally
      // when blob failed would leave a stuck "Downloading photo…" spinner
      // forever (outbound has no background-download path to clear it).
      ...(saved
        ? {
            mediaKind: kind,
            mediaMimeType: mimeType,
            mediaCaption: mediaBody || null,
            mediaFilename: kind === "document" ? filename : null,
            mediaKey: saved.key,
            mediaUrl: saved.url,
            mediaSizeBytes: saved.sizeBytes,
            // The agent recorded a voice message → flag it so our own bubble
            // shows the mic / "Voice message" affordance (Meta still receives a
            // regular audio clip — see the transcode note above).
            mediaVoice: isRecording || null,
          }
        : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }).catch((err): null => {
      this.logger.error(
        `DB persist failed AFTER successful Meta send (wamid=${send.externalId})`,
        err,
      );
      return null;
    });

    if (!created) {
      // Still 200 — the message went out; agent must NOT retry.
      return {
        messageId: null,
        warning: "message sent but local persistence failed",
      };
    }
    const createdId = created.id;

    // Outbound video poster (parity with inbound ingest): the gallery + quoted
    // reply render a lightweight JPEG from `mediaThumbnailUrl`. Outbound sends
    // never set it, so without this the gallery falls back to the raw <video>
    // first frame. Generate + store async — NEVER block the agent's response
    // nor throw (post-send a throw bubbles as a 5xx → UI retry → duplicate Meta
    // send). The poster lands on the row for the next gallery load; the live
    // view already renders the <video> first frame meanwhile.
    if (kind === "video" && saved) {
      void this.storeOutboundVideoPoster(
        createdId,
        teamId,
        bytes,
        toPhone,
        toName,
        blobLabelId,
      );
    }

    const media: MediaAttachment | undefined = saved
      ? {
          kind,
          url: `/api/media/${createdId}`,
          mimeType,
          sizeBytes: saved.sizeBytes,
          ...(mediaBody ? { caption: mediaBody } : {}),
          ...(kind === "document" ? { filename } : {}),
          // Carry the voice-note flag on the LIVE message.sent frame (it's
          // persisted to mediaVoice above). Without it the agent's own voice
          // note reconciles to a generic audio bubble — losing the mic glyph +
          // waveform the optimistic bubble showed — and other agents' tabs never
          // get the affordance until a refetch. The SSR/refetch path already
          // emits it (lib/queries/_shared.ts).
          ...(isRecording ? { voice: true } : {}),
        }
      : undefined;

    const replySnapshot = replyToMessageId
      ? await loadReplySnapshotById(teamId, replyToMessageId).catch(() => null)
      : null;

    const message: Message = {
      id: createdId,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body: mediaBody,
      direction: "out",
      channel: provider,
      status: "sent",
      rawPayload: {
        sentVia: "api/messages/media",
        mediaId,
        ...(saved ? {} : { blobUploadFailed: true }),
      },
      timestamp: messageTimestamp.toISOString(),
      ...(media ? { media } : {}),
      ...(replyToMessageId
        ? { replyToMessageId, replyTo: replySnapshot ?? null }
        : {}),
    };

    // Conversation bump + `message.sent` outbox row commit atomically.
    // Drainer dispatches subscribers after commit, closing the
    // "Meta-accepted but realtime-lost on crash" gap. Media sends count
    // as outbound messages for analytics, so they route through the
    // same path as text.
    try {
      await this.commitOutboundEvent({
        conversationId,
        bumpTimestamp: messageTimestamp,
        preview: previewBody,
        event: {
          type: "message.sent",
          teamId,
          conversationId,
          contactId: conversation.contactId,
          message,
          preview: previewBody,
          senderUserId: userId,
          ...(clientTempId ? { clientTempId } : {}),
        },
      });
    } catch (err) {
      this.logger.error(
        `sendMedia commit failed for message=${createdId}: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      messageId: createdId,
      ...(saved
        ? {}
        : { warning: "message sent but media file could not be archived locally" }),
    };
  }

  /**
   * Forward N existing messages to M contacts. Sequential — each Meta send
   * is ~300ms; bounded by the schema at messages*contacts ≤ 40 to stay
   * under the reverse-proxy idle timeout. Past that, agents use broadcasts.
   *
   * Per contact:
   *   1. Skip non-phone contacts (Instagram/Telegram identities) with an
   *      explicit failure.
   *   2. Reuse the contact's single conversation (one-contact-one-thread
   *      invariant); closed threads reopen to `pending` with `silent: true`
   *      on the publish so `conversation_opened` workflows don't trigger
   *      for every forward (audit + analytics DO run — there should be a
   *      "Reopened by forward" timeline row).
   *   3. Replay source messages oldest-first. On a 24h-window-closed (Meta
   *      error 131047), break THIS contact's loop — every later send would
   *      fail the same way.
   *
   * Forwards flow through the analytics subscriber, so each forwarded
   * message counts toward outgoingMessagesCount + stamps firstResponseAt
   * when prior inbound exists — matches text-send semantics.
   *
   * Per-send error scopes:
   *   - PRE-send (Meta upload + Meta send): throw → recipient failed.
   *   - POST-send (blob upload + DB row + emit): NEVER throws back. The
   *     customer already has the message; a 5xx here would lie to the
   *     agent AND tempt a UI retry → duplicate send.
   */
  /**
   * I-1: forward was the ONLY outbound send path with no idempotency guard, so a
   * transport retry or a re-confirmed picker re-delivered up to 40 irreversible
   * messages to customers (the externalId dedupe can't catch it — each re-send
   * gets a fresh Meta wamid). Wrap it like every other send path. Forward fans
   * out across many contacts/conversations, so there's no single conversationId
   * to key on — use a stable scope tag; the client-unique clientTempId provides
   * the dedup identity. A same-key retry returns the original results without
   * re-hitting Meta.
   */
  async forward(
    teamId: string,
    userId: string,
    input: ForwardMessagesInput,
  ): Promise<{ results: ForwardResult[] }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: "forward",
        clientTempId: input.clientTempId,
      },
      () => this.forwardImpl(teamId, userId, input),
    );
  }

  private async forwardImpl(
    teamId: string,
    userId: string,
    input: ForwardMessagesInput,
  ): Promise<{ results: ForwardResult[] }> {
    // De-dupe input lists — Zod doesn't strip dupes; preserves prior behavior.
    const messageIds = [...new Set(input.messageIds)];
    const contactIds = [...new Set(input.contactIds)];

    // Source messages, team-scoped, oldest-first so order is preserved at
    // the destination. Drop failed rows (no real wamid / never delivered).
    // `omit: rawPayload` because forward only needs body + media metadata;
    // pulling the full Meta webhook payload (5-20 KB each) for N×M forward
    // wastes a lot of wire bytes.
    const sourceRows = await this.db.message.findMany({
      where: { id: { in: messageIds }, teamId, status: { not: "failed" } },
      orderBy: { timestamp: "asc" },
      omit: { rawPayload: true },
    });
    if (sourceRows.length === 0) {
      throw new BadRequestException({
        error: "none of those messages can be forwarded",
      });
    }

    // Config + provider are resolved PER target contact below — each contact
    // can be on its own channel. (Was a single pre-loop Meta fetch + 409 when
    // unconnected; now an unconnected provider surfaces as a per-contact
    // failure in the results, consistent with the existing per-contact
    // "no phone number" failure path.)
    const contacts = await this.db.contact.findMany({
      where: { id: { in: contactIds }, teamId, deletedAt: null },
      include: { tags: { select: { id: true } } },
    });
    if (contacts.length === 0) {
      throw new NotFoundException({ error: "no such contacts" });
    }

    // Cache source-media bytes across recipients. Stored as a Promise so
    // parallel contact processors coalesce on a single in-flight fetch —
    // without that, forwarding 1 media message to 5 contacts would download
    // the source bytes 5× in parallel. `null` is cached too — a
    // missing/unreadable file shouldn't be retried per-recipient.
    type MediaBytes = {
      bytes: Uint8Array;
      mime: string;
      filename: string | null;
      kind: MediaKind;
    };
    const mediaCache = new Map<string, Promise<MediaBytes | null>>();
    const loadMediaBytes = (
      m: (typeof sourceRows)[number],
    ): Promise<MediaBytes | null> => {
      const existing = mediaCache.get(m.id);
      if (existing) return existing;
      const promise = (async (): Promise<MediaBytes | null> => {
        // Prefer mediaUrl (CDN URL — single hop). Fall back to mediaKey for
        // rows that predate the URL column. Same provider either way.
        const handle = m.mediaUrl ?? m.mediaKey;
        if (!handle || !m.mediaKind) return null;
        try {
          const fetched = await blobStorage.fetch(handle);
          return {
            bytes: fetched.bytes,
            mime: m.mediaMimeType ?? fetched.mimeType,
            filename: m.mediaFilename ?? null,
            kind: m.mediaKind as MediaKind,
          };
        } catch {
          return null;
        }
      })();
      mediaCache.set(m.id, promise);
      return promise;
    };

    const teamRow = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    // Per-contact worker. Each contact is an independent destination (its
    // own conversation row, its own Meta send sequence) so they can run
    // concurrently. Within a contact the message loop stays serial to
    // preserve the original send order at the destination.
    const processContact = async (
      contact: (typeof contacts)[number],
    ): Promise<ForwardResult> => {
      let channel;
      try {
        channel = resolveContactChannel(contact);
      } catch {
        return {
          contactId: contact.id,
          contactName: contact.name,
          ok: false,
          sent: 0,
          failed: sourceRows.length,
          error: "contact has no reachable address",
        };
      }
      const binding = getProviderBinding(channel.channel);
      let sendConfig;
      try {
        sendConfig = await binding.getSendConfig(teamId);
      } catch (err) {
        return {
          contactId: contact.id,
          contactName: contact.name,
          ok: false,
          sent: 0,
          failed: sourceRows.length,
          error:
            err instanceof ProviderNotConfiguredError
              ? "channel not connected"
              : err instanceof Error
                ? err.message
                : "send config error",
        };
      }
      const contactPhone = channel.to;

      // Window band for this contact — drives the Meta social messaging_type
      // (RESPONSE inside the free-form window, HUMAN_AGENT tag outside it). Same
      // rule as sendText/sendMedia; ignored by channels with no window model.
      const useHumanAgentTag = outsideFreeFormWindow(
        binding.provider.capabilities.freeFormWindowMs,
        contact.lastInboundAt?.toISOString() ?? null,
      );

      // One-contact-one-conversation invariant. Closed → pending (same
      // semantics as webhook ingest + broadcast runner reopen-on-send).
      const existing = await this.db.conversation.findFirst({
        where: { teamId, contactId: contact.id },
        orderBy: { lastMessageAt: "desc" },
      });
      let conversation;
      if (!existing) {
        try {
          conversation = await this.db.conversation.create({
            data: {
              teamId,
              contactId: contact.id,
              // Thread channel = the channel resolved for this send.
              channel: channel.channel,
              status: "pending",
              lastMessagePreview: "",
            },
          });
        } catch (err) {
          // Lost the race for this contact's single conversation (unique
          // [teamId, contactId]) to a concurrent inbound — reuse the winner.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            conversation = await this.db.conversation.findFirstOrThrow({
              where: { teamId, contactId: contact.id },
              orderBy: { lastMessageAt: "desc" },
            });
          } else throw err;
        }
      } else if (existing.status === "closed") {
        conversation = await this.db.conversation.update({
          where: { id: existing.id },
          data: { status: "pending" },
        });
      } else {
        conversation = existing;
      }
      // Reopen broadcast — see method docstring for the `silent: true`
      // rationale (workflow chain-trigger avoidance; audit + analytics
      // still fire). The snapshot is still required on the event type even
      // though workflow-dispatch will short-circuit on `silent: true`.
      if (existing?.status === "closed") {
        const reopenSnapshot = workflowConversationSnapshotAfterStatusChange(
          { ...conversation, status: "pending" },
          { previousStatus: "closed", changedByUserId: userId },
        );
        await this.bus.publish({
          type: "conversation.status_changed",
          teamId,
          conversationId: conversation.id,
          previousStatus: "closed",
          newStatus: "pending",
          changedByUserId: userId,
          contact: workflowContactSnapshot(contact),
          conversation: reopenSnapshot,
          silent: true,
        });
      }
      const conversationIsNew = !existing;
      let emittedForConversation = false;

      // First emit per new conversation carries the full ConversationWithRefs
      // so inbox lists can splice the row in without a refetch. Routes
      // through commitOutboundEvent so the conversation bump + outbox row
      // commit atomically (drainer dispatches after commit). Same shape as
      // sendText / sendMedia — no fire-and-forget gap that loses the
      // realtime emit on a mid-publish crash.
      const emitForwarded = async (
        message: Message,
        preview: string,
        bumpTimestamp: Date,
      ): Promise<void> => {
        let newConversation: ConversationWithRefs | undefined;
        if (conversationIsNew && !emittedForConversation) {
          const refs = await getConversationWithRefs(teamId, conversation.id, {
            messageLimit: 1,
          });
          if (refs) newConversation = refs.data;
        }
        emittedForConversation = true;
        await this.commitOutboundEvent({
          conversationId: conversation.id,
          bumpTimestamp,
          preview,
          event: {
            type: "message.sent",
            teamId,
            conversationId: conversation.id,
            contactId: contact.id,
            message,
            preview,
            senderUserId: userId,
            ...(newConversation ? { newConversation } : {}),
          },
        });
      };

      let sent = 0;
      let failed = 0;
      let firstError: string | undefined;

      for (const src of sourceRows) {
        try {
          if (src.mediaKind) {
            // Required lazily (inside the per-message try) so a channel without
            // media support fails just THIS media message, not the whole
            // forward — text messages in the same batch still go through.
            const sendMedia = requireProviderMethod(
              binding.provider,
              "sendMedia",
              channel.channel,
            );
            // URL-based channels (Instagram) presign the just-stored blob so
            // Meta fetches it directly — the upload/attachment_id path errors on
            // IG. Only require + call uploadMedia on upload-based channels
            // (WhatsApp/Messenger), mirroring the composer's sendMediaWithTempFile.
            const byUrl = binding.provider.capabilities.mediaSendByUrl === true;
            const uploadMedia = byUrl
              ? null
              : requireProviderMethod(binding.provider, "uploadMedia", channel.channel);
            const mb = await loadMediaBytes(src);
            if (!mb) {
              failed++;
              firstError ??= "a media file is no longer available";
              continue;
            }
            const caption =
              (src.mediaCaption ?? src.body ?? "").trim() || undefined;
            const filename = mb.filename ?? "upload";
            const withCaption = captionable(mb.kind) ? caption : undefined;

            // URL-based channels (Instagram) reject ogg/opus and other non-m4a
            // audio at their URL fetcher. Transcode to M4A exactly like the
            // composer's igAudio branch so a forwarded voice note is deliverable
            // instead of a generic Meta rejection. Best-effort: a failed
            // transcode falls through and Meta surfaces its own error.
            let sendBytes = mb.bytes;
            let sendMime = mb.mime;
            let sendFilename = filename;
            if (byUrl && mb.kind === "audio") {
              try {
                sendBytes = await transcodeToM4a(mb.bytes);
                sendMime = "audio/mp4";
                sendFilename = filename.replace(/\.[^./\\]+$/, "") + ".m4a";
              } catch (err) {
                this.logger.warn(
                  `[forward] IG audio transcode to M4A failed; sending original ${mb.mime}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }

            // Pre-send. Run the Meta media upload and our own blob-storage
            // upload in parallel — both consume the (possibly transcoded) bytes
            // and neither depends on the other. Saves ~200-500ms per forwarded media
            // message vs. the previous strict serial order.
            //
            // The blob upload's `externalId` context field gets a
            // placeholder (it only shapes the R2 object key + label); the
            // canonical link to Meta lives on the Message row via
            // `externalId` after the send completes.
            const [uploaded, saved] = await Promise.all([
              uploadMedia
                ? uploadMedia(
                    { bytes: sendBytes, mimeType: sendMime, filename: sendFilename },
                    sendConfig,
                  )
                : Promise.resolve(null),
              blobStorage
                .upload({
                  bytes: sendBytes,
                  mimeType: sendMime,
                  kind: mb.kind,
                  context: {
                    teamId,
                    teamSlug: teamRow?.name,
                    direction: "out",
                    contactPhone,
                    contactName: contact.name,
                    conversationId: conversation.id,
                    // MUST be unique per upload: the R2 provider derives the
                    // object KEY deterministically from externalId (+kind+ext),
                    // so a constant here would make every forwarded file of the
                    // same kind in the same month collide onto ONE key and
                    // overwrite each other (both bubbles then show the last
                    // file). The old UploadThing provider minted its own unique
                    // key so a constant was harmless; R2 does not.
                    externalId: `fwd-${src.id}-${randomUUID()}`,
                    originalFilename: filename,
                  },
                })
                .catch((err) => {
                  this.logger.error(
                    `[forward] blob upload failed (pre-Meta-send)`,
                    err,
                  );
                  return null;
                }),
            ]);
            // URL-based channels: presign the stored object (with the real
            // filename for documents, like the composer) so Meta fetches it. A
            // failed blob upload means there's nothing to point Meta at — fail
            // just this media message.
            let mediaUrl: string | undefined;
            if (byUrl) {
              if (!saved) {
                failed++;
                firstError ??= "couldn't prepare the media for sending";
                continue;
              }
              mediaUrl = await blobStorage.presignGetUrl(saved.key, {
                ttlSeconds: 3600,
                ...(mb.kind === "document" ? { downloadFilename: filename } : {}),
              });
            }
            const send = await sendMedia(
              {
                to: contactPhone,
                kind: mb.kind,
                mediaId: uploaded?.mediaId ?? "",
                ...(mediaUrl ? { mediaUrl } : {}),
                caption: withCaption,
                filename: mb.kind === "document" ? filename : undefined,
                useHumanAgentTag,
              },
              sendConfig,
            );
            const previewBody = (withCaption || mediaPreview(mb.kind)).slice(
              0,
              200,
            );

            // Monotonicity guard — same fix as text/template/media sends.
            const fwdMediaTs =
              conversation.lastMessageAt && conversation.lastMessageAt >= send.timestamp
                ? new Date(conversation.lastMessageAt.getTime() + 1)
                : send.timestamp;

            const created = await createOutboundMessageIdempotent({
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body: withCaption ?? "",
              direction: "out",
              channel: channel.channel,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
                // null on URL-based channels (Instagram) — no Meta upload id,
                // Meta fetched the presigned blob URL instead.
                mediaId: uploaded?.mediaId ?? null,
                ...(saved ? {} : { blobUploadFailed: true }),
              } as Prisma.InputJsonValue,
              timestamp: fwdMediaTs,
              // Persist media columns only when the blob upload succeeded —
              // mirror the sendMedia degrade (mapMessage reads `mediaKind &&
              // !mediaUrl` as "still downloading"; writing them when the blob
              // failed leaves a permanently broken bubble with no recovery path,
              // since outbound rows get no re-download sweeper). A blob failure
              // degrades to a caption-only text row (rawPayload flags it).
              ...(saved
                ? {
                    mediaKind: mb.kind,
                    mediaKey: saved.key,
                    mediaUrl: saved.url,
                    mediaSizeBytes: saved.sizeBytes,
                    // sendMime/sendFilename reflect the transcoded bytes actually
                    // stored + sent (IG audio → audio/mp4), so the bubble renders
                    // the real stored object, not the pre-transcode mime.
                    mediaMimeType: sendMime,
                    mediaCaption: withCaption ?? null,
                    mediaFilename: mb.kind === "document" ? sendFilename : null,
                  }
                : {}),
            }).catch((err): null => {
              this.logger.error(
                `[forward] DB persist failed after Meta send (wamid=${send.externalId})`,
                err,
              );
              return null;
            });

            // Even if local persistence broke, count the recipient as sent —
            // Meta confirmed delivery. Skip emit + bump; the inbox catches
            // up on next refresh.
            if (!created) {
              sent++;
              continue;
            }

            const media: MediaAttachment | undefined = saved
              ? {
                  kind: mb.kind,
                  url: `/api/media/${created.id}`,
                  mimeType: mb.mime,
                  sizeBytes: saved.sizeBytes,
                  ...(withCaption ? { caption: withCaption } : {}),
                  ...(mb.kind === "document" ? { filename } : {}),
                }
              : undefined;
            const message: Message = {
              id: created.id,
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body: withCaption ?? "",
              direction: "out",
              channel: channel.channel,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              },
              timestamp: fwdMediaTs.toISOString(),
              ...(media ? { media } : {}),
            };
            await emitForwarded(message, previewBody, fwdMediaTs).catch(
              (err) =>
                this.logger.error(
                  `[forward] emit failed (already sent): ${err instanceof Error ? err.message : err}`,
                ),
            );
          } else {
            const body = (src.body ?? "").trim();
            if (!body) continue; // nothing to forward (shouldn't happen)

            // Pre-send. sendText is a required provider method (always present).
            const send = await binding.provider.sendText(
              { to: contactPhone, body, useHumanAgentTag },
              sendConfig,
            );

            // Post-send. Monotonicity guard — see send-text-internal.ts.
            const fwdTextTs =
              conversation.lastMessageAt && conversation.lastMessageAt >= send.timestamp
                ? new Date(conversation.lastMessageAt.getTime() + 1)
                : send.timestamp;
            const created = await createOutboundMessageIdempotent({
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body,
              direction: "out",
              channel: channel.channel,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              } as Prisma.InputJsonValue,
              timestamp: fwdTextTs,
            }).catch((err): null => {
              this.logger.error(
                `[forward] DB persist failed after Meta send (wamid=${send.externalId})`,
                err,
              );
              return null;
            });

            if (!created) {
              sent++;
              continue;
            }

            const preview = body.slice(0, 200);
            const message: Message = {
              id: created.id,
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body,
              direction: "out",
              channel: channel.channel,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              },
              timestamp: fwdTextTs.toISOString(),
            };
            await emitForwarded(message, preview, fwdTextTs).catch(
              (err) =>
                this.logger.error(
                  `[forward] emit failed (already sent): ${err instanceof Error ? err.message : err}`,
                ),
            );
          }
          sent++;
        } catch (err) {
          failed++;
          firstError ??= describeSendError(err);
          if (!(err instanceof MetaSendError)) {
            this.logger.error("[forward] send failed", err);
          }
          // Any error that fails every remaining send identically (24h
          // window closed / rate limited / auth expired) → bail the
          // per-contact loop so the agent sees the cause once.
          if (isBlockingSendError(err)) break;
        }
      }

      return {
        contactId: contact.id,
        contactName: contact.name,
        ok: failed === 0 && sent > 0,
        sent,
        failed,
        ...(firstError ? { error: firstError } : {}),
      };
    };

    // Bounded fanout. 5 concurrent contacts trades raw wall-time for
    // staying well under Meta's per-phone-number-id send budget on big
    // forwards (e.g. selecting 30 contacts from the picker). Each contact
    // still does 1-3 Meta calls serially internally, so the actual peak
    // request rate is ~5×1 = 5 in-flight to Meta at any moment.
    const FORWARD_CONTACT_CONCURRENCY = 5;
    const results: ForwardResult[] = [];
    for (let i = 0; i < contacts.length; i += FORWARD_CONTACT_CONCURRENCY) {
      const batch = contacts.slice(i, i + FORWARD_CONTACT_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(processContact));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j]!;
        const c = batch[j]!;
        if (r.status === "fulfilled") {
          results.push(r.value);
        } else {
          // Defensive: processContact catches its own send errors and
          // returns a structured result. A rejection here means something
          // outside that loop threw (DB transaction, refs fetch, etc.).
          this.logger.error(
            `[forward] contact ${c.id} crashed: ${
              r.reason instanceof Error ? r.reason.message : String(r.reason)
            }`,
            r.reason instanceof Error ? r.reason : undefined,
          );
          results.push({
            contactId: c.id,
            contactName: c.name,
            ok: false,
            sent: 0,
            failed: sourceRows.length,
            error: "internal error",
          });
        }
      }
    }

    return { results };
  }

  /**
   * Upload a media file for an IMAGE/VIDEO/DOCUMENT template header and return
   * its STABLE R2 object link. Templates with a media header need the actual
   * media supplied at SEND time as a `link` Meta fetches — the send path
   * presigns this stable link fresh (send-template-internal.ts). A stored key
   * is reusable across recipients (broadcasts) and across the 24h gap, unlike
   * Meta's single-use upload-media id. The returned link is passed back as
   * `variables.headerMedia.link` on the template send.
   */
  async uploadTemplateHeaderMedia(
    teamId: string,
    file: Express.Multer.File,
  ): Promise<{ link: string; kind: "image" | "video" | "document"; filename?: string }> {
    // Normalize the mime the same way sendMedia does (strip codec params,
    // lowercase) before mapping to a kind — Meta keys header media strictly.
    const mimeType = normalizeMimeType(file.mimetype);
    const kind = templateHeaderKindFromMime(mimeType);
    if (!kind) {
      throw new BadRequestException({
        error: "unsupported_media_type",
        detail: "A template header accepts an image, video, or document.",
      });
    }
    // Per-kind size cap + mime allowlist — parity with the sendMedia path
    // (MEDIA_SIZE_CAPS + META_DOCUMENT_MIME_ALLOWED). Without these an
    // oversized/unsupported header stages fine and only fails later at Meta
    // fetch time, on every send and every broadcast recipient. Fail fast here
    // so the agent gets an immediate, actionable error at staging time.
    const cap = MEDIA_SIZE_CAPS[kind];
    if (file.size > cap) {
      throw new PayloadTooLargeException({
        error: `file too large for ${kind} header: ${file.size} bytes > ${cap}`,
        cap,
      });
    }
    if (!TEMPLATE_HEADER_MIME_ALLOWED[kind].has(mimeType)) {
      throw new BadRequestException({
        error: "unsupported_media_type",
        detail: TEMPLATE_HEADER_MIME_HINT[kind],
      });
    }
    const bytes = new Uint8Array(await readFile(file.path));
    const result = await blobStorage.upload({
      bytes,
      mimeType,
      kind,
      context: {
        teamId,
        direction: "out",
        externalId: `tpl-hdr-${randomUUID()}`,
        originalFilename: file.originalname,
      },
    });
    return {
      link: result.url,
      kind,
      ...(kind === "document" ? { filename: file.originalname } : {}),
    };
  }

  /**
   * Template send. Delegates to lib/messaging/send-template-internal which
   * is also called by the `send_template` workflow step — the route and
   * the workflow path produce identical message rows.
   */
  async sendTemplate(
    teamId: string,
    userId: string,
    input: SendTemplateInput,
  ): Promise<{ messageId: string }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: input.conversationId,
        clientTempId: input.clientTempId,
      },
      async () => {
        // Per-thread send ceiling, INSIDE the idempotency lock — bounds
        // partner-driven hot-potato loops at the conversation level (30/min).
        // Previously consumed BEFORE the lock, so a deduped double-click / retry
        // (same clientTempId) double-charged the budget before the cache
        // short-circuited the actual send.
        try {
          consumeConversationSendBudget(teamId, input.conversationId);
        } catch (err) {
          if (err instanceof ConversationSendRateLimitedError) {
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
        const result = await this.sendTemplateInner(teamId, userId, input);
        // Engagement side effects only after the send is accepted (see sendText).
        this.markReadOnAgentSend(teamId, userId, input.conversationId);
        this.autoAssignOnAgentSend(teamId, userId, input.conversationId);
        return result;
      },
    );
  }

  private async sendTemplateInner(
    teamId: string,
    userId: string,
    input: SendTemplateInput,
  ): Promise<{ messageId: string }> {
    try {
      const result = await sendTemplateInternal({
        teamId,
        conversationId: input.conversationId,
        templateId: input.templateId,
        variables: input.variables,
        senderUserId: userId,
        sentVia: "api/messages/template",
      });
      return { messageId: result.messageId };
    } catch (err) {
      if (err instanceof SendTemplateValidationError) {
        throw new HttpException(
          { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
          TEMPLATE_ERROR_STATUS[err.code],
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      this.logger.error("template send failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Agent-side interactive send. Synchronous (no BullMQ queue) — interactive
   * sends are rare admin moves vs. high-volume text replies, so the latency
   * extra of an inline Meta call (~300ms) doesn't justify the queue
   * scaffolding overhead. Reuses sendInteractiveInternal which already
   * handles the 24h-window gate, conversation bump, and `message.sent`
   * outbox publish.
   *
   * `senderUserId` is captured on the message row so attribution works
   * the same way as for text replies — the inbox shows "Agent name" on
   * the outbound bubble.
   */
  async sendInteractive(
    teamId: string,
    userId: string,
    input: import("./messages.schemas").SendInteractiveInput,
  ): Promise<{ messageId: string }> {
    // Pre-Meta idempotency lock (same as sendText/Media/Template). A double-
    // click / network-retry that re-POSTs the same clientTempId returns the
    // first result instead of consuming budget + sending a second interactive
    // message to Meta. No-ops when clientTempId is absent.
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: input.conversationId,
        clientTempId: input.clientTempId,
      },
      async () => {
        const result = await this.sendInteractiveInner(teamId, userId, input);
        // Mark-read + auto-assign only after the inner path accepted the send
        // (see sendText) — a rejected interactive send must not claim/reopen.
        this.markReadOnAgentSend(teamId, userId, input.conversationId);
        this.autoAssignOnAgentSend(teamId, userId, input.conversationId);
        return result;
      },
    );
  }

  private async sendInteractiveInner(
    teamId: string,
    userId: string,
    input: import("./messages.schemas").SendInteractiveInput,
  ): Promise<{ messageId: string }> {
    // Per-thread send ceiling, same as sendText/sendMedia/sendTemplate.
    try {
      consumeConversationSendBudget(teamId, input.conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
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
        teamId,
        conversationId: input.conversationId,
        bodyText: input.body,
        kind: input.kind,
        options: input.options,
        ...(input.listCtaLabel ? { listCtaLabel: input.listCtaLabel } : {}),
        ...(input.contactShare?.length ? { contactShare: input.contactShare } : {}),
        senderUserId: userId,
        sentVia: "api/messages/interactive",
      });
      return { messageId: result.messageId };
    } catch (err) {
      if (err instanceof SendTextValidationError) {
        const status =
          err.code === "outside_24h_window"
            ? 422
            : err.code === "provider_not_configured"
              ? 422
              : // The channel simply has no such interactive type (WhatsApp has
                // no phone/email consent chip) — a semantic, not syntactic, error.
                err.code === "contact_share_not_supported"
                ? 422
                : err.code === "conversation_not_found"
                  ? 404
                  : 400;
        throw new HttpException(
          { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
          status,
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      this.logger.error("interactive send failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Outbound location share — persists as a `structured` location that renders
   *  the same map-pin card an inbound location does. */
  async sendLocation(
    teamId: string,
    userId: string,
    input: import("./messages.schemas").SendLocationInput,
  ): Promise<{ messageId: string }> {
    // Pre-Meta idempotency lock (parity with text/media/template/interactive) —
    // a double-tap / network-retry re-POSTing the same clientTempId returns the
    // first result instead of sending a SECOND map pin to the customer. No-ops
    // when clientTempId is absent.
    return runWithSendIdempotency(
      { teamId, userId, conversationId: input.conversationId, clientTempId: input.clientTempId },
      async () => {
        try {
          const r = await sendStructuredInternal({
            teamId,
            conversationId: input.conversationId,
            kind: "location",
            latitude: input.latitude,
            longitude: input.longitude,
            ...(input.name ? { name: input.name } : {}),
            ...(input.address ? { address: input.address } : {}),
            senderUserId: userId,
            sentVia: "api/messages/location",
          });
          this.markReadOnAgentSend(teamId, userId, input.conversationId);
          this.autoAssignOnAgentSend(teamId, userId, input.conversationId);
          return { messageId: r.messageId };
        } catch (err) {
          this.throwStructuredSendError(err, "location");
        }
      },
    );
  }

  /** Outbound contact share — persists as a `structured` contacts card. */
  async sendContacts(
    teamId: string,
    userId: string,
    input: import("./messages.schemas").SendContactsInput,
  ): Promise<{ messageId: string }> {
    return runWithSendIdempotency(
      { teamId, userId, conversationId: input.conversationId, clientTempId: input.clientTempId },
      async () => {
        try {
          const r = await sendStructuredInternal({
            teamId,
            conversationId: input.conversationId,
            kind: "contacts",
            contacts: input.contacts,
            senderUserId: userId,
            sentVia: "api/messages/contact",
          });
          this.markReadOnAgentSend(teamId, userId, input.conversationId);
          this.autoAssignOnAgentSend(teamId, userId, input.conversationId);
          return { messageId: r.messageId };
        } catch (err) {
          this.throwStructuredSendError(err, "contact");
        }
      },
    );
  }

  /** Outbound emoji reaction to a customer message — mutates the target's
   *  reaction (no new row) and fans out via message.reaction_changed. */
  async reactToMessage(
    teamId: string,
    userId: string,
    input: import("./messages.schemas").SendReactionInput,
  ): Promise<{ ok: true }> {
    try {
      await sendReactionInternal({
        teamId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        emoji: input.emoji,
        senderUserId: userId,
      });
      return { ok: true };
    } catch (err) {
      this.throwStructuredSendError(err, "reaction");
    }
  }

  /**
   * DISMISS a stuck CUSTOMER reaction locally. Instagram never sends a reaction-
   * removal webhook (verified against live traffic: only the `react` add arrives,
   * never an `unreact`), so a customer who removes their reaction leaves it stuck
   * in our inbox forever. WhatsApp/Messenger clear via their removal webhooks and
   * never need this. This is a LOCAL cleanup — no Meta call (we can't un-react on
   * the customer's behalf) — it just clears our stored `reaction` and fans out
   * `message.reaction_changed` (customer side) so every agent sees it cleared.
   */
  async dismissReaction(teamId: string, messageId: string): Promise<{ ok: true }> {
    const target = await this.db.message.findFirst({
      where: { id: messageId, teamId },
      select: { id: true, conversationId: true, reaction: true },
    });
    if (!target) {
      throw new NotFoundException({ error: "message_not_found" });
    }
    if (target.reaction === null) return { ok: true }; // already clear — idempotent
    await this.db.message.update({ where: { id: target.id }, data: { reaction: null } });
    await publish({
      type: "message.reaction_changed",
      teamId,
      conversationId: target.conversationId,
      messageId: target.id,
      actor: "customer",
      emoji: null,
    });
    return { ok: true };
  }

  /** Shared SendTextValidationError / Meta-error → HTTP mapping for the
   *  structured (location / contact / reaction) sends. Mirrors the interactive path. */
  private throwStructuredSendError(err: unknown, kind: string): never {
    if (err instanceof SendTextValidationError) {
      const status =
        err.code === "outside_24h_window" || err.code === "provider_not_configured"
          ? 422
          : err.code === "conversation_not_found" || err.code === "message_not_found"
            ? 404
            : 400;
      throw new HttpException(
        { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
        status,
      );
    }
    const normalized = normalizeMetaSendError(err);
    if (normalized) {
      throw new UnprocessableEntityException({
        error: normalized.code,
        message: normalized.message,
        status: normalized.httpStatus,
        detail: normalized.detail,
      });
    }
    this.logger.error(`${kind} send failed`, err);
    throw new BadGatewayException({
      error: "send_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function describeSendError(err: unknown): string {
  const normalized = normalizeMetaSendError(err);
  if (normalized) return normalized.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Errors that fail every subsequent send IDENTICALLY for the same contact:
 * the 24h-window is closed, Meta's rate-limit gate has tripped, or the team's
 * access token has expired. Hammering Meta with more requests just turns the
 * forward into a wall of identical failures (and may burn quality rating).
 * Bail on the per-contact loop so the agent sees the real cause once instead
 * of N times.
 */
function isBlockingSendError(err: unknown): boolean {
  const code = normalizeMetaSendError(err)?.code;
  return (
    code === "outside_24h_window" ||
    code === "rate_limited" ||
    code === "auth_expired"
  );
}

function captionable(kind: MediaKind): boolean {
  return kind === "image" || kind === "video" || kind === "document";
}

const TEMPLATE_ERROR_STATUS: Record<SendTemplateValidationError["code"], number> = {
  conversation_not_found: 404,
  template_not_found: 404,
  template_not_approved: 409,
  wrong_body_var_count: 400,
  named_body_vars_required: 400,
  button_params_required: 400,
  header_var_required: 400,
  header_media_required: 400,
  header_media_unsupported: 422,
  contact_has_no_phone: 400,
  provider_not_configured: 409,
  provider_no_template_support: 501,
};
