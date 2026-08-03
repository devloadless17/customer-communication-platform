import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { sendTextInternal, SendTextValidationError } from "@/lib/messaging/send-text-internal";
import {
  pauseByAgent,
  resumeByAgent,
  takeOverByAgent,
} from "@/lib/ai/conversation-state";
import { getConversationHallucinationSummary, HALLUCINATION_FLAG_THRESHOLD } from "@/lib/ai/hallucination";
import { getInboundText, loadReplyContext } from "@/lib/ai/reply-context";
import { generateReply } from "@/lib/ai/reply-service";
import { configEnabled, loadAiConfig } from "@/lib/ai/runtime-config";
import { summarizeRange } from "@/lib/ai/summary-job";
import { persistSuggestion } from "@/lib/ai/suggestion-store";
import {
  renderDraftAudio,
  sendSuggestionAsVoice,
  wantsVoiceDraft,
} from "@/lib/ai/voice-delivery";
import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";

import {
  conversationRelationWhere,
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import type { StateActionInput } from "./ai-inbox.schemas";

/**
 * Agent-facing AI operations from the inbox (no aiAssistant:manage capability —
 * any team member operating a conversation can use these). Every method is
 * workspaceId-scoped.
 */
@Injectable()
export class AiInboxService {
  constructor(private readonly db: DbService) {}

  private async assertConversation(
    workspaceId: string,
    conversationId: string,
    viewer?: ConversationViewer,
  ) {
    const c = await this.db.conversation.findFirst({
      // Visibility boundary — the AI panel exposes suggestion + summary text
      // for the thread, so it needs the same gate as the thread itself.
      where: {
        id: conversationId,
        workspaceId,
        ...(viewer ? visibilityWhere(viewer) : {}),
      },
      select: { id: true, contactId: true },
    });
    if (!c) throw new NotFoundException({ error: "conversation_not_found" });
    return c;
  }

  /** One call to hydrate the inbox AI surfaces for a conversation. */
  async overview(workspaceId: string, conversationId: string, viewer?: ConversationViewer) {
    const conv = await this.assertConversation(workspaceId, conversationId, viewer);
    const contact = await this.db.contact.findUnique({
      where: { id: conv.contactId },
      select: { customerId: true },
    });
    const [cfg, state, suggestion, summary, memory, hallucination] = await Promise.all([
      loadAiConfig(workspaceId),
      this.db.aiConversationState.findUnique({ where: { conversationId } }),
      this.db.aiReplySuggestion.findFirst({
        where: { workspaceId, conversationId, state: "pending" },
        orderBy: { createdAt: "desc" },
      }),
      this.db.conversationSessionSummary.findFirst({
        where: { workspaceId, conversationId },
        orderBy: { sessionStartAt: "desc" },
      }),
      contact?.customerId
        ? this.db.aiCustomerMemory.findMany({
            where: { workspaceId, customerId: contact.customerId, status: { in: ["confirmed", "candidate"] } },
            // Most-recent first so the panel can show the freshest interests.
            orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
            take: 50,
          })
        : Promise.resolve([]),
      getConversationHallucinationSummary(workspaceId, conversationId),
    ]);
    return {
      // The per-conversation state machine defaults to ai_active, but that is
      // only meaningful when the WORKSPACE's assistant is actually enabled.
      // Without this gate every thread in an AI-less workspace rendered an
      // "AI Active" badge and an assignee reading "Handled by the AI Agent" —
      // pure fiction (the reply subscriber checks configEnabled and never
      // fires there). "disabled" makes the web hide the AI chrome entirely.
      state: configEnabled(cfg) ? (state?.state ?? "ai_active") : "disabled",
      suggestion,
      summary,
      memory,
      customerId: contact?.customerId ?? null,
      hallucination,
    };
  }

  /** On-demand summary for an agent-selected date range — see summary-job.ts. */
  async rangeSummary(workspaceId: string, conversationId: string, from: Date, to: Date) {
    await this.assertConversation(workspaceId, conversationId);
    const summary = await summarizeRange(workspaceId, conversationId, from, to);
    return { summary };
  }

  /**
   * Visibility boundary for a query keyed by messageId on a table that has no
   * direct `conversation` relation of its own (AiMessageMetadata,
   * AiMessageTranscription — both only carry a scalar `messageId`). Resolve
   * visibility against `Message` instead, which DOES have the relation
   * `conversationRelationWhere` expects, then query the side table by plain
   * messageId — never nest the relation filter under a relation that doesn't
   * exist on the target model (Prisma throws on an unknown relation key).
   */
  private async assertMessageVisible(
    workspaceId: string,
    messageId: string,
    viewer?: ConversationViewer,
  ): Promise<boolean> {
    if (!viewer) return true;
    const row = await this.db.message.findFirst({
      where: { id: messageId, workspaceId, ...conversationRelationWhere(viewer) },
      select: { id: true },
    });
    return !!row;
  }

  /** Single-message hallucination flag, for the thread bubble badge. */
  async getMessageFlag(workspaceId: string, messageId: string, viewer?: ConversationViewer) {
    if (!(await this.assertMessageVisible(workspaceId, messageId, viewer))) return { flag: null };
    const row = await this.db.aiMessageMetadata.findFirst({
      where: { workspaceId, messageId, aiGenerated: true },
      select: { hallucinationRisk: true, hallucinationNotes: true },
    });
    const risk = row?.hallucinationRisk ?? null;
    if (risk === null || risk < HALLUCINATION_FLAG_THRESHOLD) return { flag: null };
    return { flag: { risk, notes: row?.hallucinationNotes ?? null } };
  }

  async setState(
    workspaceId: string,
    conversationId: string,
    userId: string,
    action: StateActionInput["action"],
    viewer?: ConversationViewer,
  ) {
    await this.assertConversation(workspaceId, conversationId, viewer);
    switch (action) {
      case "pause":
        return pauseByAgent(workspaceId, conversationId, userId);
      case "resume":
        return resumeByAgent(workspaceId, conversationId);
      case "takeover":
        return takeOverByAgent(workspaceId, conversationId, userId);
      default:
        throw new BadRequestException({ error: "invalid_action" });
    }
  }

  /** Accept (optionally edited) or reject a persisted draft. */
  async decideSuggestion(
    workspaceId: string,
    userId: string,
    id: string,
    action: "accept" | "reject",
    editedText?: string,
    sendAs: "text" | "voice" = "text",
    viewer?: ConversationViewer,
  ) {
    const s = await this.db.aiReplySuggestion.findFirst({ where: { id, workspaceId } });
    if (!s) throw new NotFoundException({ error: "suggestion_not_found" });
    // Visibility boundary: keyed by suggestionId, so a restricted agent must not
    // read the draft, regenerate it, or SEND it on a colleague's conversation.
    await this.assertConversation(workspaceId, s.conversationId, viewer);
    if (s.state !== "pending") {
      throw new ConflictException({ error: "suggestion_already_decided", state: s.state });
    }

    if (action === "reject") {
      const rejected = await this.db.aiReplySuggestion.update({
        where: { id },
        data: { state: "rejected", decidedByUserId: userId, decidedAt: new Date() },
      });
      void publish({
        type: "ai.suggestion_changed",
        workspaceId,
        conversationId: s.conversationId,
        suggestionId: id,
        state: "rejected",
      }).catch(() => {});
      return rejected;
    }

    const edited = (editedText ?? "").trim();
    const body = edited || s.text;
    const targetState = edited ? "edited" : "accepted";

    // Load the voice config BEFORE the CAS claim. loadAiConfig can throw a raw
    // (non-SendTextValidationError) transient error, and the post-claim catch
    // only reverts on typed pre-send validation codes — so a config-load blip
    // AFTER claiming would strand the suggestion in accepted/edited with nothing
    // sent and the agent locked out (state != pending). Acquiring it first keeps
    // the row `pending` and retryable on that failure. (Text path has no such
    // pre-claim acquisition; its internal raw throws stay keep-the-claim, which
    // is the safe side of the ambiguity — a raw throw there could be a Meta
    // network error that already billed, so we must not re-arm and double-send.)
    const voiceConfig = sendAs === "voice" ? await loadAiConfig(workspaceId) : null;

    // CLAIM before sending, with a CAS on state=pending. This is the only
    // customer-visible send path that was read-then-act: two concurrent accepts
    // both saw state=pending above and both sent, double-billing the customer.
    // updateMany returns count=0 for the loser (or a re-submit after decision),
    // so exactly one request proceeds to the send. We move straight to the
    // terminal state (accepted/edited) as the claim and revert ONLY on a
    // provably-pre-send validation error below, so a send that may have reached
    // Meta is never re-attempted.
    const claim = await this.db.aiReplySuggestion.updateMany({
      where: { id, workspaceId, state: "pending" },
      data: {
        state: targetState,
        editedText: edited || null,
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      const cur = await this.db.aiReplySuggestion.findFirst({
        where: { id, workspaceId },
        select: { state: true },
      });
      throw new ConflictException({
        error: "suggestion_already_decided",
        state: cur?.state ?? "unknown",
      });
    }

    let messageId: string;
    try {
      if (sendAs === "voice") {
        const config = voiceConfig!;
        const out = await sendSuggestionAsVoice({
          workspaceId,
          conversationId: s.conversationId,
          inboundMessageId: s.inboundMessageId,
          text: body,
          audioR2Key: s.audioR2Key,
          reuseAudio: !edited, // reuse the pre-rendered draft only when unchanged
          config,
        });
        messageId = out.messageId;
      } else {
        const result = await sendTextInternal({
          workspaceId,
          conversationId: s.conversationId,
          body,
          sentVia: "ai-assistant/suggestion",
        });
        messageId = result.messageId;
      }
    } catch (err) {
      // Release the claim back to pending ONLY on a PROVABLY pre-send validation
      // error, so the agent can retry. `conversation_not_found` is deliberately
      // EXCLUDED: send-text-internal throws that same code from commitOutboundSend's
      // onMissing AFTER the Meta send already billed (conversation deleted/merged
      // mid-send), so reverting on it would re-arm the suggestion and a retry would
      // double-send + double-bill — the exact class this CAS guards against. On
      // that (rare) post-send case we keep the claim; the reply may or may not have
      // landed, but we never risk a duplicate. All other codes below are raised
      // before any provider call.
      const preSendRevertCodes = new Set([
        "empty_body",
        "message_too_long",
        "contact_has_no_phone",
        "provider_not_configured",
        "outside_24h_window",
        "contact_share_not_supported",
        "message_not_found",
      ]);
      if (err instanceof SendTextValidationError && preSendRevertCodes.has(err.code)) {
        await this.db.aiReplySuggestion.updateMany({
          where: { id, workspaceId, state: targetState },
          data: { state: "pending", decidedByUserId: null, decidedAt: null, editedText: null },
        });
      }
      throw err;
    }

    await this.db.aiMessageMetadata
      .create({ data: { workspaceId, messageId, aiGenerated: true } })
      .catch(() => {});

    const accepted = await this.db.aiReplySuggestion.findFirst({
      where: { id, workspaceId },
    });
    void publish({
      type: "ai.suggestion_changed",
      workspaceId,
      conversationId: s.conversationId,
      suggestionId: id,
      state: edited ? "edited" : "accepted",
    }).catch(() => {});
    return accepted;
  }

  /**
   * Regenerate (P4): supersede the current pending draft and produce a fresh
   * attempt on the same inbound message + context. persistSuggestion bumps the
   * deterministic `attempt` number and keeps the prior draft as history. Never
   * auto-sends — the new draft is `pending` and still requires an explicit send.
   */
  async regenerateSuggestion(
    workspaceId: string,
    _userId: string,
    suggestionId: string,
    viewer?: ConversationViewer,
  ) {
    const s = await this.db.aiReplySuggestion.findFirst({ where: { id: suggestionId, workspaceId } });
    if (!s) throw new NotFoundException({ error: "suggestion_not_found" });
    // Visibility boundary — see decideSuggestion.
    await this.assertConversation(workspaceId, s.conversationId, viewer);

    const config = await loadAiConfig(workspaceId);
    if (!configEnabled(config)) throw new BadRequestException({ error: "ai_disabled" });

    const inbound = await getInboundText(s.inboundMessageId);
    if (!inbound || !inbound.text) throw new BadRequestException({ error: "no_inbound_text" });

    const { memory, recentMessages, details } = await loadReplyContext(
      workspaceId,
      s.conversationId,
    );
    const generated = await generateReply({
      config,
      latestText: inbound.text,
      isVoice: inbound.isVoice,
      memory,
      recentMessages,
      details,
    });

    const audioR2Key = wantsVoiceDraft(config.replyChannelMode, inbound.isVoice)
      ? await renderDraftAudio(workspaceId, s.inboundMessageId, generated.payload, config)
      : null;

    const suggestion = await persistSuggestion({
      workspaceId,
      conversationId: s.conversationId,
      inboundMessageId: s.inboundMessageId,
      payload: generated.payload,
      usedChunkIds: generated.usedChunkIds,
      channelMode: config.replyChannelMode,
      audioR2Key,
    });

    await this.db.aiAssistantInteraction.create({
      data: {
        workspaceId,
        conversationId: s.conversationId,
        inboundMessageId: s.inboundMessageId,
        configVersion: config.configVersion,
        decision: "suggested",
        suggestionId: suggestion.id,
        model: generated.model,
        language: generated.payload.replyLanguage,
        intent: generated.payload.intent,
        confidence: generated.payload.confidence,
        selectedChunkIds: { chunks: generated.usedChunkIds, documents: generated.usedDocumentIds },
      },
    });

    return suggestion;
  }

  async listMemory(workspaceId: string, customerId: string) {
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, workspaceId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException({ error: "customer_not_found" });
    return this.db.aiCustomerMemory.findMany({
      where: { workspaceId, customerId },
      orderBy: [{ status: "asc" }, { confidence: "desc" }],
    });
  }

  async patchMemory(
    workspaceId: string,
    userId: string,
    id: string,
    patch: { status?: "confirmed" | "rejected" | "candidate"; value?: string },
  ) {
    const row = await this.db.aiCustomerMemory.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException({ error: "memory_not_found" });
    return this.db.aiCustomerMemory.update({
      where: { id },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.value !== undefined
          ? { value: patch.value.trim().slice(0, 500), source: "agent", createdByUserId: userId }
          : {}),
      },
    });
  }

  async deleteMemory(workspaceId: string, id: string) {
    const row = await this.db.aiCustomerMemory.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException({ error: "memory_not_found" });
    await this.db.aiCustomerMemory.delete({ where: { id } });
    return { ok: true };
  }

  async getTranscription(workspaceId: string, messageId: string, viewer?: ConversationViewer) {
    if (!(await this.assertMessageVisible(workspaceId, messageId, viewer))) return null;
    return this.db.aiMessageTranscription.findFirst({ where: { messageId, workspaceId } });
  }

  async correctTranscription(
    workspaceId: string,
    userId: string,
    messageId: string,
    correctedText: string,
    viewer?: ConversationViewer,
  ) {
    if (!(await this.assertMessageVisible(workspaceId, messageId, viewer))) {
      throw new NotFoundException({ error: "transcription_not_found" });
    }
    const row = await this.db.aiMessageTranscription.findFirst({
      where: { messageId, workspaceId },
    });
    if (!row) throw new NotFoundException({ error: "transcription_not_found" });
    return this.db.aiMessageTranscription.update({
      where: { messageId },
      data: { correctedText: correctedText.trim().slice(0, 20000), correctedByUserId: userId },
    });
  }

  /** Stream a draft suggestion's pre-rendered voice preview (workspaceId-scoped). */
  async getSuggestionAudio(workspaceId: string, id: string, viewer?: ConversationViewer) {
    const s = await this.db.aiReplySuggestion.findFirst({
      where: { id, workspaceId },
      select: { audioR2Key: true, conversationId: true },
    });
    if (!s) return null;
    // Visibility boundary — a restricted agent must not stream the voice audio
    // of a draft on a colleague's conversation.
    await this.assertConversation(workspaceId, s.conversationId, viewer);
    if (!s.audioR2Key) return null;
    return blobStorage.getObject(s.audioR2Key);
  }
}
