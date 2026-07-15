import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

import { configEnabled, loadAiConfig } from "./runtime-config";
import { transcribeInboundAudio } from "./voice";

/**
 * Transcribe an inbound voice note once, idempotently (correction #5). The
 * AiMessageTranscription row (unique on messageId) is the gate: a `pending`
 * insert claims the work, so a redelivered media_ready cannot transcribe twice.
 * Returns the transcript text to feed the reply (even when saveTranscript is
 * off, in which case the text is returned but not persisted).
 */
export async function ensureTranscription(
  teamId: string,
  messageId: string,
): Promise<string | null> {
  const existing = await db.aiMessageTranscription.findUnique({ where: { messageId } });
  if (existing) {
    if (existing.status === "ready") return existing.correctedText || existing.transcript || null;
    return null; // pending (another worker) or failed
  }

  const msg = await db.message.findUnique({
    where: { id: messageId },
    select: {
      conversationId: true,
      direction: true,
      mediaKind: true,
      mediaKey: true,
      mediaMimeType: true,
      mediaFilename: true,
    },
  });
  if (!msg || msg.direction !== "in" || msg.mediaKind !== "audio" || !msg.mediaKey) return null;

  const config = await loadAiConfig(teamId);
  if (!configEnabled(config) || !config.incomingTranscription) return null;

  // Claim the work with a unique pending row.
  try {
    await db.aiMessageTranscription.create({
      data: { teamId, messageId, status: "pending", provider: "openai" },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return null; // lost the race
    throw err;
  }

  try {
    const fetched = await blobStorage.fetch(msg.mediaKey);
    const { text, language, provider, model } = await transcribeInboundAudio({
      bytes: fetched.bytes,
      filename: msg.mediaFilename || `voice-${messageId}.ogg`,
      mimeType: msg.mediaMimeType || fetched.mimeType || "audio/ogg",
      language: config.voiceLanguage,
    });
    const transcript = (text || "").trim();
    await db.aiMessageTranscription.update({
      where: { messageId },
      data: {
        status: "ready",
        // saveTranscript=false: keep the row (audit that we transcribed) but
        // don't persist the text.
        transcript: config.saveTranscript ? transcript : null,
        language,
        provider,
        model,
      },
    });
    void publish({
      type: "ai.transcription_changed",
      teamId,
      conversationId: msg.conversationId,
      messageId,
      status: "ready",
    }).catch(() => {});
    return transcript || null;
  } catch (err) {
    await db.aiMessageTranscription
      .update({
        where: { messageId },
        data: { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
      })
      .catch(() => {});
    void publish({
      type: "ai.transcription_changed",
      teamId,
      conversationId: msg.conversationId,
      messageId,
      status: "failed",
    }).catch(() => {});
    return null;
  }
}
