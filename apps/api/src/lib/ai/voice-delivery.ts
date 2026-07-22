import { blobStorage } from "@/lib/blob-storage";
import { sendMediaInternal } from "@/lib/messaging/send-media-internal";
import { sendTextInternal } from "@/lib/messaging/send-text-internal";

import type { ReplyPayload } from "./reply-schema";
import type { AiConfigRow } from "./runtime-config";
import { renderTts } from "./voice";

/**
 * Outbound delivery for a reply, honoring the 4 channel modes and always
 * preserving the canonical TEXT. Voice is synthesized from `ttsText` (Arabic
 * script for Lebanese) and delivered via sendMediaInternal; ANY TTS/media
 * failure falls back to sending the text (correction #12).
 *
 * Dedup: the voice blob uses a DETERMINISTIC key (one per inbound message), so
 * a retry overwrites rather than orphaning; the orchestrator's automation claim
 * already prevents the reply job from running (and thus sending) twice.
 */

export interface DeliverArgs {
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  payload: ReplyPayload;
  config: AiConfigRow;
  inboundWasVoice: boolean;
}

export interface DeliverResult {
  textMessageId?: string;
  voiceMessageId?: string;
  usedVoice: boolean;
  voiceFellBackToText: boolean;
}

function channelPlan(
  mode: AiConfigRow["replyChannelMode"],
  inboundWasVoice: boolean,
): { text: boolean; voice: boolean } {
  switch (mode) {
    case "voice":
      return { text: false, voice: true };
    case "text_and_voice":
      return { text: true, voice: true };
    case "match_customer":
      return inboundWasVoice ? { text: false, voice: true } : { text: true, voice: false };
    case "text":
    default:
      return { text: true, voice: false };
  }
}

export function draftAudioKey(workspaceId: string, inboundMessageId: string): string {
  return `ai-voice-draft/${workspaceId}/${inboundMessageId}.mp3`;
}
function replyAudioKey(workspaceId: string, inboundMessageId: string): string {
  return `ai-voice/${workspaceId}/${inboundMessageId}.mp3`;
}

/**
 * Natural-language delivery steering for gpt-4o-mini-tts so the voice note
 * sounds like a real person, not a robot. Tone comes from config; defaults keep
 * it warm + Lebanese when the caller only has a partial config.
 */
function voiceInstructions(
  config: { tone?: string | null; lebaneseDialect?: boolean | null } | null,
): string {
  const tone = (config?.tone || "friendly").trim();
  const lebanese = config?.lebaneseDialect ?? true;
  if (lebanese) {
    return `Speak with an AUTHENTIC LEBANESE accent — the everyday Beirut dialect a young Lebanese customer-service rep uses on the phone. Do NOT sound Syrian, Egyptian, Gulf, or Modern Standard Arabic: use Lebanese pronunciation, Lebanese vowel sounds (e.g. the soft 'é'/'a' endings), and Lebanese intonation and rhythm. Warm, ${tone}, and personable, with relaxed conversational pacing, natural melody, light emphasis, and small human pauses and breaths — like a real person chatting, never robotic, monotone, flat, or reading a script.`;
  }
  return `Speak like a real, warm human agent — ${tone}, conversational pacing, natural intonation and small human pauses. Never robotic, monotone, or scripted.`;
}

export async function deliverReply(args: DeliverArgs): Promise<DeliverResult> {
  const { workspaceId, conversationId, inboundMessageId, payload, config } = args;
  const plan = channelPlan(config.replyChannelMode, args.inboundWasVoice);
  const result: DeliverResult = { usedVoice: false, voiceFellBackToText: false };

  if (plan.voice) {
    try {
      const rendered = await renderTts({
        text: payload.ttsText || payload.replyText,
        voiceId: config.voiceId,
        speed: config.voiceSpeed,
        instructions: voiceInstructions(config),
      });
      const sent = await sendMediaInternal({
        workspaceId,
        conversationId,
        bytes: rendered.bytes,
        mimeType: rendered.contentType,
        filename: "voice.mp3",
        voice: true,
        blobKey: replyAudioKey(workspaceId, inboundMessageId),
        sentVia: "ai-assistant/voice",
      });
      result.voiceMessageId = sent.messageId;
      result.usedVoice = true;
    } catch {
      // TTS or media send failed → guarantee a text reply instead.
      result.voiceFellBackToText = true;
      plan.text = true;
    }
  }

  // Send text when the mode wants it, on voice fallback, or if nothing else went.
  if (plan.text || (!result.usedVoice && !plan.voice)) {
    const sent = await sendTextInternal({
      workspaceId,
      conversationId,
      body: payload.replyText,
      sentVia: "ai-assistant/reply",
    });
    result.textMessageId = sent.messageId;
  }

  return result;
}

/**
 * Render + store a DRAFT voice preview (draft mode). Returns the R2 key, or null
 * on any TTS/storage failure (the draft still ships as text). Deterministic key
 * so a Regenerate overwrites the preview.
 */
export async function renderDraftAudio(
  workspaceId: string,
  inboundMessageId: string,
  payload: ReplyPayload,
  config: AiConfigRow,
): Promise<string | null> {
  try {
    const rendered = await renderTts({
      text: payload.ttsText || payload.replyText,
      voiceId: config.voiceId,
      speed: config.voiceSpeed,
      instructions: voiceInstructions(config),
    });
    const key = draftAudioKey(workspaceId, inboundMessageId);
    await blobStorage.putObject({ key, bytes: rendered.bytes, contentType: rendered.contentType });
    return key;
  } catch {
    return null;
  }
}

/** Whether the config wants a voice draft preview for this inbound. */
export function wantsVoiceDraft(
  mode: AiConfigRow["replyChannelMode"],
  inboundWasVoice: boolean,
): boolean {
  const plan = channelPlan(mode, inboundWasVoice);
  return plan.voice;
}

/**
 * "Send as Voice" for a draft (agent action). Reuses the pre-rendered draft
 * audio when the text wasn't edited; re-renders otherwise. Falls back to a text
 * send on any TTS/media failure.
 */
export async function sendSuggestionAsVoice(args: {
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  text: string;
  audioR2Key: string | null;
  reuseAudio: boolean;
  config: Pick<AiConfigRow, "voiceId" | "voiceSpeed" | "tone" | "lebaneseDialect"> | null;
}): Promise<{ messageId: string; usedVoice: boolean }> {
  try {
    let bytes: Uint8Array;
    let contentType = "audio/mpeg";
    if (args.reuseAudio && args.audioR2Key) {
      const f = await blobStorage.fetch(args.audioR2Key);
      bytes = f.bytes;
      contentType = f.mimeType || "audio/mpeg";
    } else {
      const r = await renderTts({
        text: args.text,
        voiceId: args.config?.voiceId ?? null,
        speed: args.config?.voiceSpeed,
        instructions: voiceInstructions(args.config),
      });
      bytes = r.bytes;
      contentType = r.contentType;
    }
    const sent = await sendMediaInternal({
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      bytes,
      mimeType: contentType,
      filename: "voice.mp3",
      voice: true,
      blobKey: replyAudioKey(args.workspaceId, args.inboundMessageId),
      sentVia: "ai-assistant/voice",
    });
    return { messageId: sent.messageId, usedVoice: true };
  } catch {
    const sent = await sendTextInternal({
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      body: args.text,
      sentVia: "ai-assistant/suggestion",
    });
    return { messageId: sent.messageId, usedVoice: false };
  }
}
