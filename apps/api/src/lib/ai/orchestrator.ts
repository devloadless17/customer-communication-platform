import { assignConversation } from "@/lib/conversations/mutations";
import { pickRoundRobinAssignee } from "@/lib/conversations/round-robin";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

import { arabicToArabizi } from "./arabizi";
import { claimInbound, legacyAutopilotOwnsTeam } from "./automation-claim";
import { getState, handoffToHuman, incrementAutoReply, onCustomerInbound } from "./conversation-state";
import { decideMode } from "./decide-mode";
import { HALLUCINATION_FLAG_THRESHOLD } from "./hallucination";
import { aiGloballyEnabled } from "./models";
import { openaiConfigured } from "./openai-client";
import { openingStatus } from "./prompt-builder";
import { enqueueAiPost } from "./queue";
import { loadReplyContext } from "./reply-context";
import { generateReply } from "./reply-service";
import { configEnabled, loadAiConfig } from "./runtime-config";
import { persistSuggestion } from "./suggestion-store";
import { deliverReply, renderDraftAudio, wantsVoiceDraft } from "./voice-delivery";

/**
 * The reply orchestrator. Runs on the `ai-replies` worker for a `reply` job.
 *
 * Order is load-bearing:
 *   global/config/openai/autopilot gates -> auto-resume + state gate ->
 *   max-auto-replies -> ATOMIC CLAIM (dedup + exclusion) -> generate ->
 *   PRE-SEND RE-CHECK on fresh state (cancel if a human replied mid-generation,
 *   correction #4) -> send or suggest -> audit -> enqueue post jobs.
 *
 * Never sends via HTTP: uses sendTextInternal (senderUserId=null, provenance
 * `ai-assistant/reply`). The reply message is tagged aiGenerated so it can never
 * retrigger the assistant (correction #15, last case) — though structurally an
 * outbound message never fires message.received anyway.
 */

export interface AiReplyJob {
  teamId: string;
  conversationId: string;
  inboundMessageId: string;
  text: string;
  isVoice: boolean;
}

export async function runAiReply(job: AiReplyJob): Promise<void> {
  const { teamId, conversationId, inboundMessageId } = job;
  if (!aiGloballyEnabled() || !openaiConfigured()) return;

  const config = await loadAiConfig(teamId);
  if (!configEnabled(config)) return;
  if (await legacyAutopilotOwnsTeam(teamId)) return; // mutual exclusion with n8n autopilot

  // Auto-resume (human_active -> ai_active on the next customer inbound), then
  // gate. paused / disabled stop here.
  const state = await onCustomerInbound(teamId, conversationId);
  if (state.state !== "ai_active") {
    await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
      decision: "skipped",
      skipReason: `state_${state.state}`,
    });
    return;
  }

  if (
    config.maxAutoRepliesPerConv > 0 &&
    state.autoReplyCount >= config.maxAutoRepliesPerConv
  ) {
    await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
      decision: "skipped",
      skipReason: "max_auto_replies",
    });
    return;
  }

  // Atomic claim — first writer wins; a redelivery or the autopilot loses here.
  const won = await claimInbound(teamId, conversationId, inboundMessageId, "native_ai");
  if (!won) return; // already claimed → no double reply

  const startedAt = Date.now();
  const { memory, recentMessages: recent } = await loadReplyContext(teamId, conversationId);

  let generated;
  try {
    generated = await generateReply({
      config,
      latestText: job.text,
      isVoice: job.isVoice,
      memory,
      recentMessages: recent,
    });
  } catch (err) {
    await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
      decision: "failed",
      error: errText(err),
      latencyMs: Date.now() - startedAt,
    });
    return;
  }

  // PRE-SEND RE-CHECK on FRESH state (correction #4). If a human replied while
  // the model was generating, onHumanReply moved us to human_active — abort.
  const fresh = await getState(conversationId);
  if (!fresh || fresh.state !== "ai_active") {
    await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
      decision: "cancelled",
      skipReason: `human_active_midflight:${fresh?.state ?? "missing"}`,
      model: generated.model,
      latencyMs: Date.now() - startedAt,
      ...usageFields(generated.usage),
    });
    return;
  }

  const payload = generated.payload;
  // The model writes Arabic SCRIPT even when the customer used Arabizi (it can't
  // spell Arabizi coherently). Transliterate the SENT text to Arabizi here;
  // ttsText stays Arabic script for correct voice pronunciation.
  if (payload.replyScript === "latin" && /^ar/i.test(payload.replyLanguage)) {
    payload.replyText = arabicToArabizi(payload.replyText);
  }
  const openNow = openingStatus(config, new Date()).open;
  const mode = decideMode(config, payload, openNow, job.isVoice);

  const usage = usageFields(generated.usage);
  const auditBase = {
    model: generated.model,
    language: payload.replyLanguage,
    intent: payload.intent,
    confidence: payload.confidence,
    selectedChunkIds: { chunks: generated.usedChunkIds, documents: generated.usedDocumentIds },
    latencyMs: Date.now() - startedAt,
    ...usage,
  };

  if (mode === "send" || mode === "escalate") {
    // deliverReply honors the channel mode (text/voice/both/match) and always
    // guarantees the canonical text on any TTS/media failure. On escalate the
    // payload.replyText is the brief hand-off line ("connecting you to an
    // agent") — we SEND it (not draft) before assigning.
    let delivery;
    try {
      delivery = await deliverReply({
        teamId,
        conversationId,
        inboundMessageId,
        payload,
        config,
        inboundWasVoice: job.isVoice,
      });
    } catch (err) {
      await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
        ...auditBase,
        decision: "failed",
        error: errText(err),
      });
      return;
    }
    const outIds = [delivery.textMessageId, delivery.voiceMessageId].filter(
      (x): x is string => typeof x === "string",
    );
    for (const mid of outIds) {
      // Mark each AI-authored outbound (loop guard). Unique on messageId; a
      // benign dup is swallowed.
      await db.aiMessageMetadata
        .create({
          data: {
            teamId,
            messageId: mid,
            aiGenerated: true,
            model: generated.model,
            language: payload.replyLanguage,
            script: payload.replyScript,
            intent: payload.intent,
            confidence: payload.confidence,
            hallucinationRisk: payload.hallucinationRisk,
            hallucinationNotes: payload.hallucinationNotes || null,
          },
        })
        .catch(() => {});
      // Surface to the agent for a later check (correction: flag, don't
      // block send — the reply already went out under the team's configured
      // auto-send/draft mode; this is a review signal, not a gate).
      if (payload.hallucinationRisk >= HALLUCINATION_FLAG_THRESHOLD) {
        void publish({
          type: "ai.message_flagged",
          teamId,
          conversationId,
          messageId: mid,
          risk: payload.hallucinationRisk,
          notes: payload.hallucinationNotes || null,
        }).catch(() => {});
      }
    }

    if (mode === "escalate") {
      // Support hand-off: after SENDING the acknowledgment, auto-assign to an
      // available agent (round-robin: online + available tiers) and hand the
      // thread off — a STICKY pause so the assistant won't resume on the next
      // inbound. Best-effort: a failure here must not lose the sent reply/audit.
      try {
        const agentId = await pickRoundRobinAssignee({ db, teamId });
        if (agentId) {
          await assignConversation({
            db,
            publish,
            teamId,
            conversationId,
            targetUserId: agentId,
            changedByUserId: null,
            silent: true,
          });
        }
        await handoffToHuman(teamId, conversationId, agentId);
      } catch {
        // The agent can still take over manually.
      }
      await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
        ...auditBase,
        decision: "escalated",
        outboundMessageId: delivery.voiceMessageId ?? delivery.textMessageId,
      });
    } else {
      await incrementAutoReply(conversationId);
      await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
        ...auditBase,
        decision: "replied",
        outboundMessageId: delivery.voiceMessageId ?? delivery.textMessageId,
      });
    }
  } else {
    // Draft (suggest): pre-render a voice preview when the mode wants voice
    // (null on any TTS failure — the draft still ships as text).
    const audioR2Key = wantsVoiceDraft(config.replyChannelMode, job.isVoice)
      ? await renderDraftAudio(teamId, inboundMessageId, payload, config)
      : null;
    const suggestion = await persistSuggestion({
      teamId,
      conversationId,
      inboundMessageId,
      payload,
      usedChunkIds: generated.usedChunkIds,
      channelMode: config.replyChannelMode,
      audioR2Key,
    });
    await audit(teamId, conversationId, inboundMessageId, config.configVersion, {
      ...auditBase,
      decision: "suggested",
      suggestionId: suggestion.id,
    });
  }

  // Post-reply jobs — separate + idempotent, must never block the reply (#14).
  await enqueueAiPost(conversationId, inboundMessageId).catch(() => {});
}

interface AuditExtra {
  decision: "replied" | "suggested" | "skipped" | "escalated" | "cancelled" | "failed";
  outboundMessageId?: string;
  suggestionId?: string;
  model?: string;
  language?: string;
  intent?: string;
  confidence?: number;
  skipReason?: string;
  selectedChunkIds?: { chunks: string[]; documents: string[] };
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  latencyMs?: number;
  error?: string;
}

async function audit(
  teamId: string,
  conversationId: string,
  inboundMessageId: string,
  configVersion: number,
  extra: AuditExtra,
): Promise<void> {
  try {
    await db.aiAssistantInteraction.create({
      data: {
        teamId,
        conversationId,
        inboundMessageId,
        configVersion,
        decision: extra.decision,
        outboundMessageId: extra.outboundMessageId ?? null,
        suggestionId: extra.suggestionId ?? null,
        model: extra.model ?? null,
        language: extra.language ?? null,
        intent: extra.intent ?? null,
        confidence: extra.confidence ?? null,
        skipReason: extra.skipReason ?? null,
        selectedChunkIds: extra.selectedChunkIds ?? [],
        inputTokens: extra.inputTokens ?? null,
        outputTokens: extra.outputTokens ?? null,
        cacheReadTokens: extra.cacheReadTokens ?? null,
        latencyMs: extra.latencyMs ?? null,
        error: extra.error ?? null,
      },
    });
  } catch {
    // Audit is best-effort — never let it fail the reply path.
  }
}

function usageFields(u: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }) {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cachedTokens,
  };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
