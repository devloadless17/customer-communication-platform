import { anthropicConfigured, chatJsonAnthropic } from "./anthropic-client";
import { anthropicReplyModel } from "./models";

/**
 * Repair a Lebanese call transcript's dialect spelling.
 *
 * WHY: the speech model is trained overwhelmingly on Modern Standard Arabic,
 * so Lebanese comes back as near-miss forms that are almost words — measured
 * on a real call, "كيف فيني ساعدك" arrived as "كفيه سادك", "هلق" as the
 * Egyptian "دلوقتي", "ليش" as "ديش". The words are recoverable from context by
 * a model that actually knows the dialect, which this codebase already relies
 * on Claude for (see `replyTextProvider`).
 *
 * WHY IT IS DANGEROUS, and what bounds it: a model asked to "fix" text will
 * also fix things that were never broken. The same measured run rewrote the
 * unintelligible "الشلام" as "المعلومة" — a plausible invention presented as
 * fact, which is the exact failure this whole pipeline has been fighting. So
 * the repair is accepted ONLY if it stayed close to the original:
 *
 *   - it must retain most of the original words (a rewrite is not a repair);
 *   - it must not change length materially (added or dropped content);
 *   - any failure, timeout or missing key keeps the RAW text.
 *
 * The raw text is stored alongside the repaired one regardless, so nothing is
 * lost and a suspicious line can always be checked against what was heard.
 */

/** Below this share of original words retained, it rewrote rather than repaired. */
const MIN_WORD_RETENTION = 0.6;
/** Outside this length band, content was added or dropped. */
const MIN_LENGTH_RATIO = 0.75;
const MAX_LENGTH_RATIO = 1.25;
/** Too short to carry the context a dialect repair needs. */
const MIN_CHARS = 25;

const SYSTEM = [
  "You repair speech-to-text output of LEBANESE ARABIC phone calls.",
  "The transcript came from a model trained mainly on Modern Standard Arabic, so Lebanese words arrive as near-miss forms.",
  "",
  "RULES — absolute:",
  "- Correct ONLY words that are clearly mis-transcribed Lebanese, rewriting them as Lebanese speakers actually say them.",
  "- If a word is unintelligible or you are not sure what was said, LEAVE IT EXACTLY AS IS. Never replace it with a plausible guess.",
  "- NEVER add information, sentences, names, numbers or pleasantries that are not already present.",
  "- NEVER remove content. Keep every utterance, including fillers and repetitions.",
  "- Keep English words in Latin script exactly as they appear — Lebanese speakers code-switch and that is not an error.",
  "- Keep the same order and roughly the same length.",
  "- Egyptian or MSA forms a Lebanese speaker would not use are the typical error (دلوقتي is Egyptian; Lebanese says هلق).",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    corrected: {
      type: "string",
      description: "The repaired transcript. Same content, Lebanese spelling.",
    },
  },
  required: ["corrected"],
} as const;

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/**
 * Returns the repaired text, or null to keep the original. Never throws —
 * a transcript that exists beats a repair that failed.
 */
export async function repairLebaneseTranscript(opts: {
  text: string;
  /** Detected language; repair only runs on Arabic. */
  language?: string;
  /** Proper nouns the model should recognise rather than re-spell. */
  businessContext?: string | null;
}): Promise<string | null> {
  const raw = opts.text.trim();
  if (raw.length < MIN_CHARS) return null;
  if (!anthropicConfigured()) return null;
  const lang = (opts.language ?? "").toLowerCase();
  if (lang && !lang.startsWith("ar") && lang !== "arabic") return null;

  let corrected: string;
  try {
    const res = await chatJsonAnthropic<{ corrected: string }>({
      model: anthropicReplyModel(),
      system: SYSTEM,
      user:
        (opts.businessContext
          ? `Proper nouns that may appear: ${opts.businessContext}\n\n`
          : "") + `Transcript to repair:\n${raw}`,
      schemaName: "repaired_transcript",
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2000,
    });
    corrected = (res.data?.corrected ?? "").trim();
  } catch (err) {
    console.warn(
      `[call-transcript] dialect repair failed: ${
        err instanceof Error ? err.message : err
      } — keeping the raw transcript`,
    );
    return null;
  }
  if (!corrected) return null;

  // ── The guard. A repair that strayed is discarded, not stored. ──────────
  const ratio = corrected.length / raw.length;
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
    console.warn(
      `[call-transcript] dialect repair changed length ${raw.length}→${corrected.length} ` +
        "— rejected as a rewrite, keeping the raw transcript",
    );
    return null;
  }
  const before = wordSet(raw);
  const after = wordSet(corrected);
  if (before.size > 0) {
    let shared = 0;
    for (const w of before) if (after.has(w)) shared++;
    const retention = shared / before.size;
    if (retention < MIN_WORD_RETENTION) {
      console.warn(
        `[call-transcript] dialect repair retained only ${Math.round(retention * 100)}% ` +
          "of the original words — rejected as a rewrite, keeping the raw transcript",
      );
      return null;
    }
  }
  return corrected === raw ? null : corrected;
}
