import { aiGloballyEnabled, openaiApiKey } from "./models";

/**
 * Thin facade over the official OpenAI SDK — the ONLY place the assistant talks
 * to OpenAI (reasoning, STT, TTS). Loaded via a guarded dynamic import so the
 * api keeps building/booting before `openai` is installed: a missing dep or key
 * surfaces as `OpenAiUnavailableError`, which the orchestrator treats as "skip"
 * (the feature is opt-in).
 *
 * Structured output uses response_format json_schema (strict) so the reply
 * comes back as validated JSON. Prompt caching is automatic on OpenAI (it
 * caches long stable prefixes), so the prompt-builder puts stable content first
 * and needs no explicit cache markers.
 */

export class OpenAiUnavailableError extends Error {
  constructor(reason: string) {
    super(`openai_unavailable: ${reason}`);
    this.name = "OpenAiUnavailableError";
  }
}

/**
 * One `verbose_json` segment. The three probability fields are the quality
 * signals a call transcript is filtered on — see `callSttModel()` for the
 * measurements behind the thresholds.
 */
export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  /** P(this segment is NOT speech). ≈0.9 on silence, ≈0.01 on real speech. */
  no_speech_prob: number;
  /** Mean token log-probability — the model's confidence in what it heard. */
  avg_logprob: number;
  /** Text/compressed size. >2.4 means a repetition loop, a hallucination mode. */
  compression_ratio: number;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiClientLike {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
        usage?: ChatUsage;
        model?: string;
      }>;
    };
  };
  audio: {
    transcriptions: {
      create(params: Record<string, unknown>): Promise<{
        text?: string;
        language?: string;
        segments?: TranscriptionSegment[];
      }>;
    };
    speech: {
      create(params: Record<string, unknown>): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    };
  };
}

type ToFile = (
  value: Uint8Array | Buffer,
  filename?: string,
  opts?: { type?: string },
) => Promise<unknown>;

let clientPromise: Promise<{ client: OpenAiClientLike; toFile: ToFile }> | null = null;

async function getClient(): Promise<{ client: OpenAiClientLike; toFile: ToFile }> {
  if (!aiGloballyEnabled()) throw new OpenAiUnavailableError("globally_disabled");
  const key = openaiApiKey();
  if (!key) throw new OpenAiUnavailableError("missing_OPENAI_API_KEY");
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    let mod: Record<string, unknown>;
    try {
      mod = (await import("openai" as string)) as Record<string, unknown>;
    } catch {
      clientPromise = null;
      throw new OpenAiUnavailableError("sdk_not_installed");
    }
    const Ctor = (mod.default ?? mod) as new (opts: { apiKey: string }) => OpenAiClientLike;
    const toFile = mod.toFile as ToFile;
    return { client: new Ctor({ apiKey: key }), toFile };
  })();
  return clientPromise;
}

export function openaiConfigured(): boolean {
  return aiGloballyEnabled() && !!openaiApiKey();
}

export interface ChatJsonResult<T> {
  data: T | null;
  rawContent: string;
  model?: string;
  usage?: ChatUsage;
}

/**
 * Chat completion constrained to a JSON schema (strict structured output).
 * Returns parsed `data` (null if the model produced unparseable output) plus
 * the raw content + usage for auditing.
 */
export async function chatJson<T>(opts: {
  model: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<ChatJsonResult<T>> {
  const { client } = await getClient();
  const res = await client.chat.completions.create({
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1500,
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
    },
  });
  const rawContent = res.choices?.[0]?.message?.content ?? "";
  let data: T | null = null;
  try {
    data = rawContent ? (JSON.parse(rawContent) as T) : null;
  } catch {
    data = null;
  }
  return { data, rawContent, model: res.model, usage: res.usage };
}

/** Transcribe audio bytes (STT). */
export async function transcribe(opts: {
  model: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  language?: string;
  /**
   * Ask for `verbose_json` — per-segment timestamps AND the quality signals
   * (`no_speech_prob`, `avg_logprob`, `compression_ratio`) that make it
   * possible to tell a real transcription from a confident hallucination.
   * Supported by `whisper-1` only; the gpt-4o transcribe models accept `json`
   * alone and silently ignore the rest, so callers that need segments must
   * pick a model that returns them (see `callSttModel`).
   */
  segments?: boolean;
  /** Decoding temperature; used to break a repetition loop on a re-decode. */
  temperature?: number;
}): Promise<{ text: string; language?: string; segments?: TranscriptionSegment[] }> {
  const { client, toFile } = await getClient();
  const file = await toFile(Buffer.from(opts.bytes), opts.filename, { type: opts.mimeType });
  const res = await client.audio.transcriptions.create({
    model: opts.model,
    file,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.segments
      ? { response_format: "verbose_json", timestamp_granularities: ["segment"] }
      : {}),
  });
  return {
    text: res.text ?? "",
    language: res.language,
    ...(res.segments ? { segments: res.segments } : {}),
  };
}

/** Text-to-speech (TTS) -> mp3 bytes. */
export async function speak(opts: {
  model: string;
  voice: string;
  text: string;
  speed?: number;
  format?: "mp3" | "opus" | "aac" | "flac";
  /** Natural-language delivery steering (gpt-4o-mini-tts) — tone, pacing,
   *  emotion — to make the voice sound human rather than robotic. */
  instructions?: string;
}): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { client } = await getClient();
  const format = opts.format ?? "mp3";
  const res = await client.audio.speech.create({
    model: opts.model,
    voice: opts.voice,
    input: opts.text,
    response_format: format,
    ...(opts.speed ? { speed: opts.speed } : {}),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const contentType =
    format === "mp3"
      ? "audio/mpeg"
      : format === "opus"
        ? "audio/ogg"
        : format === "aac"
          ? "audio/aac"
          : "audio/flac";
  return { bytes: buf, contentType };
}
