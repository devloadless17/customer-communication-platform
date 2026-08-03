/**
 * Builds the Lebanese dialect asset the assistant speaks from.
 *
 *   pnpm --filter @ccp/api exec tsx scripts/build-lebanese-corpus.ts \
 *     [inputPath=data/raw_sentences.txt]
 *
 * Input is a plain text file, ONE Lebanese sentence per line, written in
 * Arabizi (Latin letters + the 2/3/5/7/9 digit-consonants). Output is
 * `src/lib/ai/lebanese/corpus.generated.ts`, which IS committed — the raw
 * corpus is not part of the deploy artifact, and re-mining 12k lines on every
 * boot would be silly for a file that changes when someone adds transcripts.
 *
 * Three things come out of the corpus, each solving a different problem:
 *
 *   forms    Spelling. `arabicToArabizi` is consonant-accurate but guesses the
 *            short vowels Arabic script doesn't write, so it emits "bddi" where
 *            a Lebanese person types "badde", and "7lwa" where they type
 *            "7elwe". Keying real spellings by their CONSONANT SKELETON lets the
 *            transliterator's output be swapped for the spelling customers
 *            actually use — the vowels are exactly the part it got wrong and the
 *            corpus got right.
 *
 *   bigrams  Sequence. When a skeleton has several attested spellings, the word
 *            BEFORE it breaks the tie in favour of a pairing the corpus has
 *            actually seen.
 *
 *   phrases  Phrasing. The most common multi-word expressions, injected into the
 *            system prompt so the model reaches for Lebanese constructions
 *            instead of the Modern Standard Arabic it defaults to.
 *
 * The skeleton itself lives in `src/lib/ai/lebanese/skeleton.ts` and is imported
 * here rather than reimplemented: the build side and the runtime side must
 * compute the same key or the lookup silently misses, and two copies of a rule
 * this fiddly would drift on the first edit.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { skeleton } from "../src/lib/ai/lebanese/skeleton";

// --- tuning ---------------------------------------------------------------

/** A spelling must appear at least this often to be a canonical candidate. */
const MIN_FORM_COUNT = 2;
/** Candidates kept per skeleton (most frequent first). */
const MAX_FORMS_PER_SKELETON = 3;
/**
 * A skeleton's top form must hold at least this share to be trusted.
 *
 * Low on purpose. Now that the skeleton keeps long vowels, a bucket's members
 * are overwhelmingly SPELLINGS OF ONE WORD rather than different words, and a
 * near-tie between two of them (badde 240 / bade 212) is a coin-flip about
 * spelling, not evidence of ambiguity. A high bar threw those buckets away —
 * which meant the most common word in the corpus got no canonical form at all.
 */
const MIN_TOP_SHARE = 0.35;
/** Word pairs kept for the sequence tie-break. */
const MAX_BIGRAMS = 6000;
/** Phrases shown to the model in the system prompt. */
const MAX_PHRASES = 80;
/**
 * Phrase words must come from this many top-frequency words. Restricting to the
 * frequent core keeps proper nouns, names and one-off topic words OUT of the
 * prompt: the anchor is about how Lebanese sentences are BUILT, and a corpus of
 * real conversations is full of people and places that have no business being
 * quoted back at a customer.
 */
const PHRASE_VOCAB_TOP = 800;

function tokenize(line: string): string[] {
  return line.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function main(): void {
  const repoRoot = resolve(__dirname, "../../..");
  const inputPath = resolve(repoRoot, process.argv[2] ?? "data/raw_sentences.txt");
  const outPath = resolve(__dirname, "../src/lib/ai/lebanese/corpus.generated.ts");

  const raw = readFileSync(inputPath, "utf8");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, number>();
  const trigrams = new Map<string, number>();
  let tokenCount = 0;

  for (const line of lines) {
    // A digit-only token is a number, never a word — it would pollute both the
    // skeleton map and the phrase anchor.
    const toks = tokenize(line).filter((t) => !/^\d+$/.test(t));
    tokenCount += toks.length;
    for (let i = 0; i < toks.length; i++) {
      bump(unigrams, toks[i]!);
      if (i > 0) bump(bigrams, `${toks[i - 1]} ${toks[i]}`);
      if (i > 1) bump(trigrams, `${toks[i - 2]} ${toks[i - 1]} ${toks[i]}`);
    }
  }

  // --- forms: skeleton -> candidate spellings, most frequent first ---
  const bySkeleton = new Map<string, Array<[string, number]>>();
  for (const [word, count] of unigrams) {
    if (count < MIN_FORM_COUNT) continue;
    const sk = skeleton(word);
    if (!sk) continue;
    const list = bySkeleton.get(sk) ?? [];
    list.push([word, count]);
    bySkeleton.set(sk, list);
  }

  const forms: Record<string, string[]> = {};
  for (const [sk, list] of bySkeleton) {
    list.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = list.reduce((s, [, c]) => s + c, 0);
    // An ambiguous skeleton (no clear winner) is left out entirely rather than
    // guessed at — silence beats rewriting a word into a different one.
    if (list[0]![1] / total < MIN_TOP_SHARE) continue;
    forms[sk] = list.slice(0, MAX_FORMS_PER_SKELETON).map(([w]) => w);
  }

  // --- bigrams: only pairs whose BOTH words survived into `forms` ---
  const kept = new Set(Object.values(forms).flat());
  const pairs = [...bigrams.entries()]
    .filter(([pair, c]) => {
      if (c < 2) return false;
      const [a, b] = pair.split(" ");
      return kept.has(a!) && kept.has(b!);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_BIGRAMS)
    .map(([pair]) => pair);

  // --- phrases: the prompt anchor ---
  const core = new Set(
    [...unigrams.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PHRASE_VOCAB_TOP)
      .map(([w]) => w),
  );
  const isCore = (p: string) => p.split(" ").every((w) => core.has(w) && w.length > 1);
  // Trigrams first — a three-word phrase carries far more structure than a pair
  // ("ma fi shi" teaches negation; "ma fi" teaches half of it).
  const phrases = [
    ...[...trigrams.entries()].filter(([p, c]) => c >= 3 && isCore(p)).sort((a, b) => b[1] - a[1]),
    ...[...bigrams.entries()].filter(([p, c]) => c >= 8 && isCore(p)).sort((a, b) => b[1] - a[1]),
  ]
    .map(([p]) => p)
    .slice(0, MAX_PHRASES);

  const body = `/**
 * GENERATED — do not edit by hand.
 *
 * Rebuild with:
 *   pnpm --filter @ccp/api exec tsx scripts/build-lebanese-corpus.ts
 *
 * Source: ${lines.length} Lebanese Arabizi sentences (${tokenCount} tokens,
 * ${unigrams.size} distinct spellings). See scripts/build-lebanese-corpus.ts for
 * what each field is for and why the skeleton keeps its edge-vowel markers.
 */

export interface LebaneseCorpus {
  /** Consonant skeleton -> real spellings, most frequent first. */
  forms: Record<string, string[]>;
  /** Attested "word word" pairs, for the sequence tie-break. */
  bigrams: string[];
  /** Common Lebanese expressions, for the system-prompt dialect anchor. */
  phrases: string[];
}

export const LEBANESE_CORPUS: LebaneseCorpus = {
  forms: ${JSON.stringify(forms)},
  bigrams: ${JSON.stringify(pairs)},
  phrases: ${JSON.stringify(phrases)},
};
`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, "utf8");

  console.log(`sentences      ${lines.length}`);
  console.log(`tokens         ${tokenCount}`);
  console.log(`distinct       ${unigrams.size}`);
  console.log(`skeletons      ${Object.keys(forms).length}`);
  console.log(`bigrams        ${pairs.length}`);
  console.log(`phrases        ${phrases.length}`);
  console.log(`wrote          ${outPath} (${Math.round(body.length / 1024)} KB)`);
}

main();
