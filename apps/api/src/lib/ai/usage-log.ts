import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only ledger of every model call the product pays for.
 *
 * WHY A FILE AND NOT A TABLE. `AiAssistantInteraction` already records tokens,
 * but only for the REPLY — the memory job, the session summary, call transcript
 * repair, the composer's Translate/Refine, STT and TTS all spend money and land
 * nowhere. This sits at the one seam every paid call passes through
 * (`openai-client`, plus `azure-tts` for the other vendor), so it cannot drift
 * out of date as call sites are added: a new caller is billed and logged by the
 * same function.
 *
 * Deliberately NOT surfaced in the app. No route, no page, no realtime frame —
 * it is an operator artifact, read with `scripts/ai-usage-report.ts` or any
 * `jq` one-liner.
 *
 * WHAT IS RECORDED, and the split that matters: TOKENS are the measurement and
 * COST is a convenience. Prices change and the table below goes stale; token
 * counts do not. Every line carries the raw counts so any past period can be
 * re-priced later, and an unknown model logs `costUsd: null` rather than a
 * plausible guess.
 *
 * Off unless `AI_USAGE_LOG` names a path. Writes are fire-and-forget and
 * swallow their own errors — a full disk or a bad path must never fail a
 * customer's reply for the sake of bookkeeping.
 */

export type UsageOp =
  | "reply"
  | "reply_regenerate"
  | "memory"
  | "summary"
  | "transcript_repair"
  | "translate"
  | "refine"
  | "stt"
  | "stt_call"
  | "tts";

/** Optional attribution a caller can pass down; absent is fine. */
export interface UsageContext {
  op: UsageOp;
  workspaceId?: string | null;
}

interface UsageRecord extends UsageContext {
  model: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  /** Audio duration for STT/TTS, where billing is per minute rather than token. */
  audioSeconds?: number;
  latencyMs?: number;
  ok: boolean;
  error?: string;
}

/**
 * USD per 1M tokens, from the OpenAI pricing page on 2026-08-06
 * (https://developers.openai.com/api/docs/pricing). A model absent from this
 * map is logged with a null cost — see the note above about why guessing is
 * worse than admitting ignorance.
 *
 * Re-check when a model default changes in `models.ts`; the two files are
 * expected to move together.
 */
const TOKEN_PRICES: Record<string, { in: number; cached: number; out: number }> = {
  "gpt-5.6-luna": { in: 0.2, cached: 0.02, out: 1.2 },
  "gpt-5.6-terra": { in: 2.0, cached: 0.2, out: 12 },
  "gpt-5.6-sol": { in: 5.0, cached: 0.5, out: 30 },
  "gpt-5.5": { in: 5.0, cached: 0.5, out: 30 },
  "gpt-5.4": { in: 2.5, cached: 0.25, out: 15 },
  "gpt-5.4-mini": { in: 0.75, cached: 0.075, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, cached: 0.02, out: 1.25 },
  "gpt-5-mini": { in: 0.25, cached: 0.025, out: 2.0 },
  "gpt-5-nano": { in: 0.05, cached: 0.005, out: 0.4 },
  "gpt-4o": { in: 2.5, cached: 1.25, out: 10 },
  "gpt-4o-mini": { in: 0.15, cached: 0.075, out: 0.6 },
};

/** USD per MINUTE of audio, same source and same staleness caveat. */
const AUDIO_PRICES: Record<string, number> = {
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003,
  "whisper-1": 0.006,
};

/**
 * TTS is deliberately absent from both tables. `gpt-4o-mini-tts` bills audio
 * OUTPUT tokens ($12/1M), the API returns no usage for them, and OpenAI
 * publishes no per-minute equivalent — so the duration is recorded and the cost
 * left null rather than invented. Reconcile TTS against the real invoice.
 */

/**
 * The API answers with the dated SNAPSHOT id it actually served —
 * `gpt-4o-mini-2024-07-18`, not `gpt-4o-mini` — so pricing on the raw string
 * silently marked every 4o-mini call unpriced. Snapshots are the family plus a
 * trailing date, and they are billed at the family's rate, so strip it.
 * The unmodified id stays in the log line; only the price lookup normalises.
 */
function priceKey(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function priceOf(r: UsageRecord): number | null {
  const key = priceKey(r.model);
  const tok = TOKEN_PRICES[r.model] ?? TOKEN_PRICES[key];
  if (tok) {
    const cached = r.cachedTokens ?? 0;
    const uncached = Math.max(0, (r.inputTokens ?? 0) - cached);
    return (
      (uncached * tok.in + cached * tok.cached + (r.outputTokens ?? 0) * tok.out) / 1e6
    );
  }
  const perMinute = AUDIO_PRICES[r.model] ?? AUDIO_PRICES[key];
  if (perMinute !== undefined && r.audioSeconds !== undefined) {
    return (r.audioSeconds / 60) * perMinute;
  }
  return null;
}

function logPath(): string | null {
  return process.env.AI_USAGE_LOG?.trim() || null;
}

let dirReady: Promise<void> | null = null;

/**
 * Record one paid call. Never throws, never awaits the caller's critical path —
 * call it with `void`.
 */
export async function recordUsage(r: UsageRecord): Promise<void> {
  const path = logPath();
  if (!path) return;
  try {
    dirReady ??= mkdir(dirname(path), { recursive: true }).then(() => undefined);
    await dirReady;
    const cost = priceOf(r);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      op: r.op,
      model: r.model,
      workspaceId: r.workspaceId ?? null,
      inputTokens: r.inputTokens ?? null,
      cachedTokens: r.cachedTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      audioSeconds: r.audioSeconds ?? null,
      // Rounded to a millionth of a dollar: a single luna reply costs ~$0.0005,
      // so fewer digits would round most of the ledger to zero.
      costUsd: cost === null ? null : Number(cost.toFixed(6)),
      latencyMs: r.latencyMs ?? null,
      ok: r.ok,
      ...(r.error ? { error: r.error.slice(0, 200) } : {}),
    });
    await appendFile(path, line + "\n", "utf8");
  } catch {
    // Bookkeeping must never break a reply. A lost line is a lost line.
    dirReady = null; // let a transient mkdir failure be retried next call
  }
}
