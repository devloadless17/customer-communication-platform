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
  setDisabled,
  takeOverByAgent,
} from "@/lib/ai/conversation-state";
import { getInboundText, loadReplyContext } from "@/lib/ai/reply-context";
import { generateReply } from "@/lib/ai/reply-service";
import { configEnabled, loadAiConfig } from "@/lib/ai/runtime-config";
import { persistSuggestion } from "@/lib/ai/suggestion-store";
import {
  renderDraftAudio,
  sendSuggestionAsVoice,
  wantsVoiceDraft,
} from "@/lib/ai/voice-delivery";
import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";

import {
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import type { StateActionInput } from "./ai-inbox.schemas";

/**
 * Agent-facing AI operations from the inbox (no aiAssistant:manage capability —
 * any team member operating a conversation can use these). Every method is
 * teamId-scoped.
 */
@Injectable()
export class AiInboxService {
  constructor(private readonly db: DbService) {}

  private async assertConversation(
    teamId: string,
    conversationId: string,
    viewer?: ConversationViewer,
  ) {
    const c = await this.db.conversation.findFirst({
      // Visibility boundary — the AI panel exposes suggestion + summary text
      // for the thread, so it needs the same gate as the thread itself.
      where: {
        id: conversationId,
        teamId,
        ...(viewer ? visibilityWhere(viewer) : {}),
      },
      select: { id: true, contactId: true },
    });
    if (!c) throw new NotFoundException({ error: "conversation_not_found" });
    return c;
  }

  /** One call to hydrate the inbox AI surfaces for a conversation. */
  async overview(teamId: string, conversationId: string, viewer?: ConversationViewer) {
    const conv = await this.assertConversation(teamId, conversationId, viewer);
    const contact = await this.db.contact.findUnique({
      where: { id: conv.contactId },
      select: { customerId: true },
    });
    const [state, suggestion, summary, memory] = await Promise.all([
      this.db.aiConversationState.findUnique({ where: { conversationId } }),
      this.db.aiReplySuggestion.findFirst({
        where: { teamId, conversationId, state: "pending" },
        orderBy: { createdAt: "desc" },
      }),
      this.db.conversationSessionSummary.findFirst({
        where: { teamId, conversationId },
        orderBy: { sessionStartAt: "desc" },
      }),
      contact?.customerId
        ? this.db.aiCustomerMemory.findMany({
            where: { teamId, customerId: contact.customerId, status: { in: ["confirmed", "candidate"] } },
            // Most-recent first so the panel can show the freshest interests.
            orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
            take: 50,
          })
        : Promise.resolve([]),
    ]);
    return {
      state: state?.state ?? "ai_active",
      suggestion,
      summary,
      memory,
      customerId: contact?.customerId ?? null,
    };
  }

  async setState(
    teamId: string,
    conversationId: string,
    userId: string,
    action: StateActionInput["action"],
    viewer?: ConversationViewer,
  ) {
    await this.assertConversation(teamId, conversationId, viewer);
    switch (action) {
      case "pause":
        return pauseByAgent(teamId, conversationId, userId);
      case "resume":
        return resumeByAgent(teamId, conversationId);
      case "takeover":
        return takeOverByAgent(teamId, conversationId, userId);
      case "disable":
        return setDisabled(teamId, conversationId, true);
      case "enable":
        return setDisabled(teamId, conversationId, false);
      default:
        throw new BadRequestException({ error: "invalid_action" });
    }
  }

  /** Accept (optionally edited) or reject a persisted draft. */
  async decideSuggestion(
    teamId: string,
    userId: string,
    id: string,
    action: "accept" | "reject",
    editedText?: string,
    sendAs: "text" | "voice" = "text",
  ) {
    const s = await this.db.aiReplySuggestion.findFirst({ where: { id, teamId } });
    if (!s) throw new NotFoundException({ error: "suggestion_not_found" });
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
        teamId,
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
    const voiceConfig = sendAs === "voice" ? await loadAiConfig(teamId) : null;

    // CLAIM before sending, with a CAS on state=pending. This is the only
    // customer-visible send path that was read-then-act: two concurrent accepts
    // both saw state=pending above and both sent, double-billing the customer.
    // updateMany returns count=0 for the loser (or a re-submit after decision),
    // so exactly one request proceeds to the send. We move straight to the
    // terminal state (accepted/edited) as the claim and revert ONLY on a
    // provably-pre-send validation error below, so a send that may have reached
    // Meta is never re-attempted.
    const claim = await this.db.aiReplySuggestion.updateMany({
      where: { id, teamId, state: "pending" },
      data: {
        state: targetState,
        editedText: edited || null,
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      const cur = await this.db.aiReplySuggestion.findFirst({
        where: { id, teamId },
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
          teamId,
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
          teamId,
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
          where: { id, teamId, state: targetState },
          data: { state: "pending", decidedByUserId: null, decidedAt: null, editedText: null },
        });
      }
      throw err;
    }

    await this.db.aiMessageMetadata
      .create({ data: { teamId, messageId, aiGenerated: true } })
      .catch(() => {});

    const accepted = await this.db.aiReplySuggestion.findFirst({
      where: { id, teamId },
    });
    void publish({
      type: "ai.suggestion_changed",
      teamId,
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
  async regenerateSuggestion(teamId: string, _userId: string, suggestionId: string) {
    const s = await this.db.aiReplySuggestion.findFirst({ where: { id: suggestionId, teamId } });
    if (!s) throw new NotFoundException({ error: "suggestion_not_found" });

    const config = await loadAiConfig(teamId);
    if (!configEnabled(config)) throw new BadRequestException({ error: "ai_disabled" });

    const inbound = await getInboundText(s.inboundMessageId);
    if (!inbound || !inbound.text) throw new BadRequestException({ error: "no_inbound_text" });

    const { memory, recentMessages } = await loadReplyContext(teamId, s.conversationId);
    const generated = await generateReply({
      config,
      latestText: inbound.text,
      isVoice: inbound.isVoice,
      memory,
      recentMessages,
    });

    const audioR2Key = wantsVoiceDraft(config.replyChannelMode, inbound.isVoice)
      ? await renderDraftAudio(teamId, s.inboundMessageId, generated.payload, config)
      : null;

    const suggestion = await persistSuggestion({
      teamId,
      conversationId: s.conversationId,
      inboundMessageId: s.inboundMessageId,
      payload: generated.payload,
      usedChunkIds: generated.usedChunkIds,
      channelMode: config.replyChannelMode,
      audioR2Key,
    });

    await this.db.aiAssistantInteraction.create({
      data: {
        teamId,
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

  async listMemory(teamId: string, customerId: string) {
    const customer = await this.db.customer.findFirst({
      where: { id: customerId, teamId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException({ error: "customer_not_found" });
    return this.db.aiCustomerMemory.findMany({
      where: { teamId, customerId },
      orderBy: [{ status: "asc" }, { confidence: "desc" }],
    });
  }

  async patchMemory(
    teamId: string,
    userId: string,
    id: string,
    patch: { status?: "confirmed" | "rejected" | "candidate"; value?: string },
  ) {
    const row = await this.db.aiCustomerMemory.findFirst({ where: { id, teamId } });
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

  async deleteMemory(teamId: string, id: string) {
    const row = await this.db.aiCustomerMemory.findFirst({ where: { id, teamId } });
    if (!row) throw new NotFoundException({ error: "memory_not_found" });
    await this.db.aiCustomerMemory.delete({ where: { id } });
    return { ok: true };
  }

  async getTranscription(teamId: string, messageId: string) {
    return this.db.aiMessageTranscription.findFirst({ where: { messageId, teamId } });
  }

  async correctTranscription(teamId: string, userId: string, messageId: string, correctedText: string) {
    const row = await this.db.aiMessageTranscription.findFirst({ where: { messageId, teamId } });
    if (!row) throw new NotFoundException({ error: "transcription_not_found" });
    return this.db.aiMessageTranscription.update({
      where: { messageId },
      data: { correctedText: correctedText.trim().slice(0, 20000), correctedByUserId: userId },
    });
  }

  /** Stream a draft suggestion's pre-rendered voice preview (teamId-scoped). */
  async getSuggestionAudio(teamId: string, id: string) {
    const s = await this.db.aiReplySuggestion.findFirst({
      where: { id, teamId },
      select: { audioR2Key: true },
    });
    if (!s?.audioR2Key) return null;
    return blobStorage.getObject(s.audioR2Key);
  }
}
