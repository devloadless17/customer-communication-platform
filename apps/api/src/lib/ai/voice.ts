import { sttModel, ttsModel } from "./models";
import { speak, transcribe } from "./openai-client";

/**
 * Voice adapters (OpenAI). STT for inbound voice notes, TTS for voice replies.
 * Both are thin over the openai-client facade; the orchestrator owns storage +
 * the text-fallback decision (correction #12: on any TTS/media failure the
 * assistant sends text instead).
 */

export interface TranscriptionResult {
  text: string;
  language?: string;
  provider: "openai";
  model: string;
}

export async function transcribeInboundAudio(opts: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  language?: string;
}): Promise<TranscriptionResult> {
  const model = sttModel();
  const res = await transcribe({
    model,
    bytes: opts.bytes,
    filename: opts.filename,
    mimeType: opts.mimeType,
    language: opts.language,
  });
  return { text: res.text, language: res.language, provider: "openai", model };
}

/**
 * Render TTS from the Arabic-script `ttsText`. Throws on failure so the caller
 * falls back to a plain text reply. `voiceId` is the configured, tested OpenAI
 * voice name (no accent guarantee — correction #12).
 */
export async function renderTts(opts: {
  text: string;
  voiceId?: string | null;
  speed?: number;
  /** Delivery steering to humanize the voice (see speak()). */
  instructions?: string;
}): Promise<{ bytes: Uint8Array; contentType: string; model: string; voice: string }> {
  const model = ttsModel();
  const voice = opts.voiceId?.trim() || "alloy";
  const out = await speak({
    model,
    voice,
    text: opts.text,
    speed: opts.speed,
    format: "mp3",
    instructions: opts.instructions,
  });
  return { ...out, model, voice };
}
