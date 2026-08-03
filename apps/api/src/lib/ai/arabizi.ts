import { canonicalizeArabizi } from "./lebanese";

/**
 * Deterministic Arabic-script → Lebanese Arabizi transliteration.
 *
 * The model CANNOT spell Arabizi (free-generating it yields gibberish), but it
 * writes coherent Lebanese in ARABIC SCRIPT perfectly. So the reply prompt makes
 * it write Arabic script + set replyScript="latin" when the customer used
 * Arabizi, and we convert here — coherent Lebanese, in the Latin/Arabizi the
 * customer used.
 *
 * TWO STAGES, and the split is the point:
 *
 *   1. Transliterate. Consonant-accurate. Short vowels are approximate, because
 *      Arabic script does not write them — this stage can only guess, and its
 *      guesses are what made the output look machine-made ("bddi", "7lwa").
 *   2. Canonicalise against the Lebanese corpus (`./lebanese`), which supplies
 *      the real spelling for those consonants ("badde", "7elwe"). Exactly the
 *      part stage 1 had to invent, replaced by the part the corpus knows.
 *
 * Stage 2 runs ONLY on text stage 1 produced. Anything the model wrote in Latin
 * already — the English and French loanwords Lebanese speakers mix in ("menu",
 * "delivery", "merci"), prices, times, URLs — is passed through untouched, so
 * it is never "corrected" into a Lebanese word that happens to share its
 * consonants. That is why the input is split into Arabic and non-Arabic runs
 * instead of being transliterated as one string.
 *
 * Non-Arabic characters (spaces, punctuation, Latin, emoji) pass through
 * untouched.
 */

const MAP: Record<string, string> = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ٱ": "a",
  "ء": "2", "ؤ": "2", "ئ": "2",
  "ب": "b", "ت": "t", "ث": "t", "ج": "j", "ح": "7", "خ": "kh",
  "د": "d", "ذ": "z", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
  "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "3", "غ": "gh",
  "ف": "f", "ق": "2", "ك": "k", "ل": "l", "م": "m", "ن": "n",
  "ه": "h", "ة": "a", "ى": "a",
  // Harakat. A speaker writing Lebanese never types these; when the model does,
  // it is decorating Modern Standard Arabic, and the decoration must not become
  // letters. Tanween especially: مرحبًا rendered "mr7bana" in production because
  // ً expanded to "an" INSIDE the word. It marks case on a word we are about to
  // strip vowels from anyway, so it contributes nothing and is dropped.
  "َ": "", "ُ": "", "ِ": "", "ً": "", "ٌ": "", "ٍ": "", "ْ": "",
  // Arabic-indic digits → ASCII
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  // Arabic punctuation → Latin; tatweel/kashida is decorative → drop it.
  "؟": "?", "،": ",", "؛": ";", "ـ": "", "٪": "%",
};

const SHADDA = "ّ";
/**
 * Arabic block + supplement + presentation forms — everything MAP covers.
 *
 * Escapes, not literal characters: the presentation-forms range ends at U+FEFF,
 * which IS a zero-width no-break space, so writing it literally puts invisible
 * whitespace in the source (lint catches it, and nobody reading the line could
 * have seen it). Escapes also make the four ranges legible as ranges.
 */
const ARABIC_CHAR = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
/**
 * Characters that belong to whichever run they land in. Whitespace and ASCII
 * punctuation carry no script of their own, and splitting a run on them would
 * hand the canonicaliser one word at a time — losing the preceding word, which
 * is exactly what its sequence tie-break needs.
 */
const NEUTRAL_CHAR = /[\s.,!?;:()"'–—…-]/;

/** Convert Arabic-script text to (approximate) Lebanese Arabizi. */
export function arabicToArabizi(input: string): string {
  let out = "";
  let run = "";
  let runIsArabic = false;
  let runClassified = false;

  let prevRunWasArabic: boolean | null = null;

  const flush = () => {
    if (!run) return;
    const text = runIsArabic ? canonicalizeArabizi(transliterateRun(run)) : run;
    // A script change with no whitespace across it was two words in the model's
    // Arabic — الpricing, والfeatures, الdelivery — that would otherwise be
    // welded into one unreadable token ("elpricing"). Arabic and Latin never
    // share a word, so a boundary here is always a word boundary.
    // Both sides must be WORD characters. An Arabic comma is in the Arabic
    // block, so "booking، online" changes script at the punctuation and would
    // otherwise gain a space before the comma ("booking , online").
    if (
      prevRunWasArabic !== null &&
      prevRunWasArabic !== runIsArabic &&
      /[\p{L}\p{N}]$/u.test(out) &&
      /^[\p{L}\p{N}]/u.test(text)
    ) {
      out += " ";
    }
    out += text;
    prevRunWasArabic = runIsArabic;
    run = "";
    runClassified = false;
  };

  for (const c of input) {
    if (NEUTRAL_CHAR.test(c)) {
      run += c;
      continue;
    }
    const isArabic = ARABIC_CHAR.test(c);
    if (runClassified && isArabic !== runIsArabic) flush();
    runIsArabic = isArabic;
    runClassified = true;
    run += c;
  }
  flush();
  return out;
}

/**
 * `ي` and `و` are each two different sounds, and which one it is decides
 * whether the word survives canonicalisation as itself.
 *
 * They are CONSONANTS (y/w) at a word start, next to an alif or ta-marbuta on
 * EITHER side — حلوة is 7elwe not 7eloa, أول is awal not oul — and LONG VOWELS
 * (i/o) everywhere else, where a real consonant precedes them: روح is rou7.
 *
 * Getting it wrong is not cosmetic, because the canonicaliser then matches the
 * wrong word and rewrites it with confidence: حلوة ("pretty") took the skeleton
 * of حالة ("case"), and أول ("first") took the skeleton of قول and shipped as
 * "oul ma nefta7" instead of "awal ma nefta7".
 */
const ALIF_FAMILY = new Set(["ا", "أ", "إ", "آ", "ٱ", "ة", "ى"]);
const WORD_BREAK = /[\s\p{P}]/u;

/**
 * The definite article, split off its noun BEFORE transliterating.
 *
 * Arabic glues ال onto the noun; Lebanese writes it as a separate "el" — the
 * single most common token in the corpus. Splitting it first (rather than
 * patching the Latin afterwards) matters twice over: the noun becomes its own
 * word, so the canonicaliser can fix it at all, and its first letter becomes
 * word-INITIAL, so اليوم reads as "el yom" instead of "el iom".
 *
 * Skipped before a second ل, where the letters are not an article: الله, اللي.
 */
const ARTICLE = /(^|[\s\p{P}])ال(?!ل)(?=[ء-ي]{2,})/gu;

/** Stage 1 on one all-Arabic run. */
function transliterateRun(run: string): string {
  const input = run.replace(ARTICLE, "$1ال ");
  const chars = [...input];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === SHADDA) {
      // Shadda doubles the previously emitted letter.
      const last = out[out.length - 1];
      if (last) out += last;
      continue;
    }
    if (c === "ي" || c === "و") {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const atWordStart = prev === undefined || WORD_BREAK.test(prev);
      const isConsonant =
        atWordStart ||
        (next !== undefined && ALIF_FAMILY.has(next)) ||
        (prev !== undefined && ALIF_FAMILY.has(prev));
      out += c === "ي" ? (isConsonant ? "y" : "i") : (isConsonant ? "w" : "o");
      continue;
    }
    const m = MAP[c];
    out += m !== undefined ? m : c;
  }
  // ال now stands alone (see ARTICLE) — or arrived alone as الـ, the way the
  // model writes it before a Latin loanword.
  return out.replace(/\bal\b/g, "el");
}
