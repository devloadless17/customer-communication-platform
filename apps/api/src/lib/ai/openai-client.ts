import { aiGloballyEnabled, openaiApiKey, reasoningEffort } from "./models";
import { recordUsage, type UsageContext } from "./usage-log";

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
  /** Attribution for the usage ledger. Omit and the call is still recorded. */
  usage?: UsageContext;
}): Promise<ChatJsonResult<T>> {
  const { client } = await getClient();
  const started = Date.now();
  const res = await client.chat.completions.create({
    model: opts.model,
    messages: opts.messages,
    // `max_completion_tokens`, NOT `max_tokens`. Every gpt-5.x model REJECTS
    // `max_tokens` outright ("Unsupported parameter"), while gpt-4o and
    // gpt-4o-mini accept both — verified against the live API on all four. So
    // the new name is the only one that works everywhere, which is what lets
    // the model be an env change rather than a code change.
    max_completion_tokens: opts.maxTokens ?? 1500,
    // Only for models that have it — the 4o family rejects the argument.
    ...(reasoningEffort(opts.model) ? { reasoning_effort: reasoningEffort(opts.model) } : {}),
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
    },
  });
  void recordUsage({
    op: opts.usage?.op ?? "reply",
    workspaceId: opts.usage?.workspaceId,
    model: res.model ?? opts.model,
    inputTokens: res.usage?.prompt_tokens,
    cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens,
    outputTokens: res.usage?.completion_tokens,
    latencyMs: Date.now() - started,
    ok: true,
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

/**
 * Plain (unstructured) chat completion — one string in, one string out.
 *
 * For the composer tools (Translate / Refine), where the whole answer IS the
 * text and wrapping it in a JSON schema would only add a parse step and tokens.
 * Callers get "" when the model returns nothing and decide what that means.
 */
export async function chatText(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  usage?: UsageContext;
}): Promise<string> {
  const { client } = await getClient();
  const started = Date.now();
  const res = await client.chat.completions.create({
    model: opts.model,
    max_completion_tokens: opts.maxTokens ?? 1500, // see chatJson
    ...(reasoningEffort(opts.model) ? { reasoning_effort: reasoningEffort(opts.model) } : {}),
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
  void recordUsage({
    op: opts.usage?.op ?? "refine",
    workspaceId: opts.usage?.workspaceId,
    model: res.model ?? opts.model,
    inputTokens: res.usage?.prompt_tokens,
    cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens,
    outputTokens: res.usage?.completion_tokens,
    latencyMs: Date.now() - started,
    ok: true,
  });
  return (res.choices?.[0]?.message?.content ?? "").trim();
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
  /**
   * Vocabulary/style bias. Not an instruction — the model treats it as if it
   * were the transcript of the moment BEFORE this audio, which is what makes
   * it steer spelling and word choice. The documented lever for dialect and
   * for proper nouns the model would otherwise guess at.
   */
  prompt?: string;
  usage?: UsageContext;
}): Promise<{ text: string; language?: string; segments?: TranscriptionSegment[] }> {
  const { client, toFile } = await getClient();
  const file = await toFile(Buffer.from(opts.bytes), opts.filename, { type: opts.mimeType });
  const started = Date.now();
  const res = await client.audio.transcriptions.create({
    model: opts.model,
    file,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.segments
      ? { response_format: "verbose_json", timestamp_granularities: ["segment"] }
      : {}),
  });
  // STT bills per MINUTE, so duration is the billable quantity, not tokens.
  // `verbose_json` gives it exactly (last segment end); otherwise it is unknown
  // and left null rather than guessed from the byte count, which varies with
  // codec and bitrate.
  const segs = res.segments;
  void recordUsage({
    op: opts.usage?.op ?? "stt",
    workspaceId: opts.usage?.workspaceId,
    model: opts.model,
    audioSeconds: segs?.length ? segs[segs.length - 1]!.end : undefined,
    latencyMs: Date.now() - started,
    ok: true,
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
  usage?: UsageContext;
}): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { client } = await getClient();
  const started = Date.now();
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

  // TTS bills audio OUTPUT tokens, which this endpoint does not report, so the
  // ledger records the call and its input size and leaves cost null — see the
  // note in usage-log.ts. Reconcile TTS against the invoice.
  void recordUsage({
    op: opts.usage?.op ?? "tts",
    workspaceId: opts.usage?.workspaceId,
    model: opts.model,
    inputTokens: undefined,
    latencyMs: Date.now() - started,
    ok: true,
  });

  return { bytes: buf, contentType };
}
