import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { sendTextInternal } from "@/lib/messaging/send-text-internal";
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

  private async assertConversation(teamId: string, conversationId: string) {
    const c = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true, contactId: true },
    });
    if (!c) throw new NotFoundException({ error: "conversation_not_found" });
    return c;
  }

  /** One call to hydrate the inbox AI surfaces for a conversation. */
  async overview(teamId: string, conversationId: string) {
    const conv = await this.assertConversation(teamId, conversationId);
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
  ) {
    await this.assertConversation(teamId, conversationId);
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

    let messageId: string;
    if (sendAs === "voice") {
      const config = await loadAiConfig(teamId);
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

    await this.db.aiMessageMetadata
      .create({ data: { teamId, messageId, aiGenerated: true } })
      .catch(() => {});

    const accepted = await this.db.aiReplySuggestion.update({
      where: { id },
      data: {
        state: edited ? "edited" : "accepted",
        editedText: edited || null,
        decidedByUserId: userId,
        decidedAt: new Date(),
      },
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
