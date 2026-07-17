/**
 * Deterministic Arabic-script → Lebanese Arabizi transliteration.
 *
 * The model CANNOT spell Arabizi (free-generating it yields gibberish), but it
 * writes coherent Lebanese in ARABIC SCRIPT perfectly. So the reply prompt makes
 * it write Arabic script + set replyScript="latin" when the customer used
 * Arabizi, and we convert here — coherent Lebanese, in the Latin/Arabizi the
 * customer used.
 *
 * Consonant-accurate; short vowels are approximate (Arabic script omits them),
 * which reads fine for Arabizi users. `ي`/`و` are treated as consonants at a
 * word start and as long vowels elsewhere. Non-Arabic characters (spaces,
 * punctuation, Latin, emoji) pass through untouched.
 */

const MAP: Record<string, string> = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ٱ": "a",
  "ء": "2", "ؤ": "2", "ئ": "2",
  "ب": "b", "ت": "t", "ث": "t", "ج": "j", "ح": "7", "خ": "kh",
  "د": "d", "ذ": "z", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
  "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "3", "غ": "gh",
  "ف": "f", "ق": "2", "ك": "k", "ل": "l", "م": "m", "ن": "n",
  "ه": "h", "ة": "a", "ى": "a",
  // harakat (short vowels / shadda handled separately)
  "َ": "a", "ُ": "o", "ِ": "i", "ً": "an", "ٌ": "on", "ٍ": "in", "ْ": "",
  // Arabic-indic digits → ASCII
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  // Arabic punctuation → Latin; tatweel/kashida is decorative → drop it.
  "؟": "?", "،": ",", "؛": ";", "ـ": "", "٪": "%",
};

const SHADDA = "ّ";

/** Convert Arabic-script text to (approximate) Lebanese Arabizi. */
export function arabicToArabizi(input: string): string {
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
      const atWordStart = i === 0 || prev === " " || prev === "\n" || prev === undefined;
      out += c === "ي" ? (atWordStart ? "y" : "i") : (atWordStart ? "w" : "o");
      continue;
    }
    const m = MAP[c];
    out += m !== undefined ? m : c;
  }
  return out;
}
