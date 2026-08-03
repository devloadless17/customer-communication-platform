import { LEBANESE_CORPUS } from "./corpus.generated";
import { skeleton } from "./skeleton";

/**
 * The Lebanese dialect layer: everything the assistant knows about how Lebanese
 * is actually written, mined from a corpus of real Lebanese sentences (see
 * `scripts/build-lebanese-corpus.ts`).
 *
 * Two consumers, deliberately separate:
 *
 *   canonicalizeArabizi   Applied AFTER `arabicToArabizi`, on the text that goes
 *                         to the customer. Fixes the short vowels the
 *                         transliterator had to guess.
 *   lebanesePhraseAnchor  Injected into the system prompt so the model reaches
 *                         for Lebanese constructions rather than the Modern
 *                         Standard Arabic it defaults to.
 *
 * Both are pure and synchronous. The corpus is a module-level constant — no
 * file I/O, no lazy load, nothing to fail at request time.
 */

const BIGRAMS = new Set(LEBANESE_CORPUS.bigrams);

/**
 * Kill switch, read per call so it can be flipped in /opt/ccp/.env.local and
 * take effect on restart without a deploy. "0" disables the corpus lookup and
 * leaves the mechanical transliteration exactly as it comes out.
 *
 * This exists because the corpus shipped a live defect that put wrong WORDS in
 * front of customers, and the only lever at the time was a redeploy. A layer
 * that rewrites outbound text needs an off switch that does not require CI.
 */
function corpusEnabled(): boolean {
  return process.env.AI_LEBANESE_CORPUS !== "0";
}

/**
 * Swap each mechanically transliterated word for the spelling the corpus
 * actually uses. Only the SPELLING changes: a candidate always shares the
 * input's skeleton, i.e. its consonants and long vowels.
 *
 * `sequence` is what the second half of the tie-break is for — when a skeleton
 * has several attested spellings, a pairing the corpus has actually seen
 * ("halla2 bshouf" over "hal2 bshouf") wins over raw frequency. Ties are broken
 * against the word ALREADY EMITTED, so the choice reads left to right the way
 * the sentence does.
 *
 * Input is expected to be Arabizi produced by `arabicToArabizi` — never mixed
 * with pass-through Latin, which the caller keeps out (an English loanword the
 * model wrote has no skeleton worth matching and must survive untouched).
 */
export function canonicalizeArabizi(text: string): string {
  if (!corpusEnabled()) return text;
  let prev = "";
  return text.replace(/[a-z0-9']+/gi, (token) => {
    // A bare number is a price or a time, not a word.
    if (/^\d+$/.test(token)) {
      prev = "";
      return token;
    }
    const candidates = LEBANESE_CORPUS.forms[skeleton(token)];
    if (!candidates || candidates.length === 0) {
      prev = token.toLowerCase();
      return token;
    }
    const attested = prev ? candidates.find((c) => BIGRAMS.has(`${prev} ${c}`)) : undefined;
    const chosen = attested ?? candidates[0]!;
    prev = chosen;
    return chosen;
  });
}

/**
 * The dialect anchor for the system prompt: real Lebanese expressions, in the
 * Arabizi they were collected in.
 *
 * Written for a model that must OUTPUT Arabic script — so the instruction has
 * to be explicit that these are about phrasing and word choice, not about
 * spelling, or it starts typing Arabizi back (which it cannot do; that is the
 * whole reason `arabicToArabizi` exists).
 *
 * Lives in the system prompt rather than the user turn because it never varies:
 * it belongs to the stable, auto-cached prefix, so it costs input tokens once
 * per config change rather than once per message.
 */
export function lebanesePhraseAnchor(): string {
  const phrases = LEBANESE_CORPUS.phrases;
  if (!phrases.length) return "";
  return (
    "- HOW LEBANESE ACTUALLY SOUNDS. These are real phrases from Lebanese " +
    "conversations, written in Arabizi: " +
    phrases.join(" · ") +
    ". Copy their PHRASING, word choice, and sentence shape — this is the " +
    "register to write in. Do NOT copy their spelling and do NOT type Arabizi " +
    "yourself: you still write Arabic script. Do not reuse their subject " +
    "matter either; they are a style sample, not company knowledge."
  );
}
