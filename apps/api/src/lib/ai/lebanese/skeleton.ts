/**
 * The key that links a mechanically transliterated word to the way a Lebanese
 * person actually spells it. Shared by the corpus BUILD script and the runtime
 * canonicaliser — both sides must compute it identically or nothing matches.
 *
 * The idea: Arabic script writes long vowels (ا و ي) and omits short ones. So
 * `arabicToArabizi` KNOWS the long vowels and GUESSES the short ones, and the
 * guesses are what look foreign ("bddi" for بدّي, "7lwa" for حلوة). Reducing a
 * word to its consonants plus its long vowels therefore keeps everything the
 * transliterator got right and discards exactly what it got wrong — and the
 * corpus supplies the missing part from real usage.
 *
 * Every rule below exists because dropping the distinction merged two different
 * words, which is a meaning error rather than a spelling one:
 *
 *   medial o/i are KEPT   ra7 (رح, "will") vs rou7 (روح, "go") — both reduce to
 *                         "r7" without this, and rewriting one into the other
 *                         changes what the sentence says. Same for ktir (كتير,
 *                         "a lot") vs aktar (أكتر, "more").
 *   final vowels CLASSED  A final ي is written "e" in Lebanese far more often
 *                         than "i" (badde, ya3ne, 3ande) — so a final vowel
 *                         cannot be significant. But it cannot be dropped
 *                         either: shi (شي, "thing") and shou (شو, "what") differ
 *                         ONLY in that vowel. Keeping its FRONT/BACK class
 *                         merges the spelling variants and keeps the two words
 *                         apart.
 *   a/e are DROPPED       These are the short vowels Arabic script omits, i.e.
 *                         precisely the ones the transliterator invented.
 */

/** `u` normalises to `o` and `ee` to `i`, so only these four remain. */
const VOWELS = new Set(["a", "e", "i", "o"]);

/** Front-class final vowel (a/e/i/y) vs back-class (o/u). */
type FinalClass = "F" | "B" | "";

export function skeleton(word: string): string {
  let w = word
    .toLowerCase()
    .replace(/[^a-z0-9']/g, "")
    // Spelling preferences for the SAME sound, not different words:
    // chou/shou, 2addesh/qaddesh.
    .replace(/ch/g, "sh")
    .replace(/q/g, "2")
    // Vowel digraphs -> one canonical letter per class.
    .replace(/ou/g, "o")
    .replace(/oo/g, "o")
    .replace(/uu/g, "o")
    .replace(/u/g, "o")
    .replace(/ee/g, "i")
    .replace(/ii/g, "i")
    // A non-initial y is the same ي the transliterator renders as "i" —
    // hayda/hidi are one word spelled two ways. Word-INITIAL y is a real
    // consonant (yalla) and stays, or it would collide with words starting in a
    // vowel.
    .replace(/(.)y/g, "$1i");
  if (!w) return "";

  // A leading vowel is a marker, not a sound we can trust: it separates el
  // (ال) from l without pretending to know which vowel it was.
  const lead = VOWELS.has(w[0]!) ? "V" : "";

  let final: FinalClass = "";
  const last = w[w.length - 1]!;
  if (VOWELS.has(last) || last === "y") {
    final = last === "o" ? "B" : "F";
    // Strip the whole trailing vowel cluster, not just one character.
    w = w.replace(/[aeioy]+$/, "");
  }

  let core = "";
  for (const c of w) {
    if (c === "a" || c === "e") continue; // the short vowels script omits
    if (c === core[core.length - 1]) continue; // shadda writes a letter twice
    core += c;
  }
  if (!core) return "";
  return `${lead}${core}${final}`;
}
