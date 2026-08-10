import { isAzureVoice, speakAzure } from "./azure-tts";
import { callSttModel, sttModel, sttSupportsSegments, ttsModel } from "./models";
import { speak, transcribe, type TranscriptionSegment } from "./openai-client";

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

export interface CallChannelTranscription {
  text: string;
  language?: string;
  segments: TranscriptionSegment[];
  model: string;
}

/**
 * Transcribe ONE channel of a call recording (one speaker), returning the
 * per-segment timings and quality signals the caller filters on.
 *
 * Separate from `transcribeInboundAudio` on purpose: voice notes are a single
 * known speaker on a clean leg and want the best raw text model, while call
 * audio needs hallucination detection, confidence and timestamps — see
 * `callSttModel()`. `language` pins the decode when the caller has already
 * established what is being spoken (the other channel agreed), which is the
 * retry for a channel whose language was mis-detected.
 */
export async function transcribeCallChannel(opts: {
  bytes: Uint8Array;
  filename: string;
  /** Wire type of `bytes`. Isolated channels are always mono WAV; the
   *  whole-file fallback passes the recording's own container. Must match the
   *  bytes — the API reads it to pick a decoder. */
  mimeType?: string;
  language?: string;
  /**
   * Decoding temperature. 0 is the right default, but it is also what makes a
   * model fall into a REPETITION LOOP on hard audio — emitting one phrase over
   * and over. Re-decoding the same audio at a higher temperature is the
   * documented escape, so the caller retries up the ladder when it detects one.
   */
  temperature?: number;
  /** Vocabulary/style bias — dialect spellings and the business's own proper
   *  nouns, which a speech model otherwise guesses at. */
  prompt?: string;
  /** Ledger attribution — which workspace this paid call bills against. */
  workspaceId?: string;
}): Promise<CallChannelTranscription> {
  const model = callSttModel();
  // Asking a gpt-4o transcribe model for verbose_json is rejected outright, so
  // the request shape follows the model's actual capability rather than a
  // hopeful default. Callers must cope with an empty `segments`.
  const wantSegments = sttSupportsSegments(model);
  const res = await transcribe({
    model,
    bytes: opts.bytes,
    filename: opts.filename,
    mimeType: opts.mimeType ?? "audio/wav",
    language: opts.language,
    temperature: opts.temperature,
    prompt: opts.prompt,
    segments: wantSegments,
    // Call recordings are minutes of audio where a voice note is seconds, so
    // they are worth separating in the ledger rather than pooling under "stt".
    usage: { op: "stt_call", workspaceId: opts.workspaceId },
  });
  return {
    text: res.text,
    language: res.language,
    segments: res.segments ?? [],
    model,
  };
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
  const voice = opts.voiceId?.trim() || "alloy";

  // Azure neural voice (e.g. ar-LB-LaylaNeural) → authentic Lebanese. OpenAI's
  // `instructions` steering doesn't apply; Azure voices carry the accent
  // natively. Same mp3 output shape, so everything downstream is unchanged.
  if (isAzureVoice(voice)) {
    const out = await speakAzure({ voice, text: opts.text, speed: opts.speed });
    return { ...out, model: "azure-tts", voice };
  }

  const model = ttsModel();
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
