/**
 * Blank out the parts of a source file that are PROSE, not code.
 *
 * ## Why this is shared
 *
 * Every checker in `scripts/` matches a regex over source text, and every one of
 * them eventually meets the same failure: the pattern it hunts for also appears
 * in a docblock explaining the very rule it enforces. It has now bitten three
 * times —
 *
 *   - `check-channel-account` reported `getSendConfig(workspaceId)` written
 *     inside a comment (fixed at the time with a local copy of this function);
 *   - `check-error-keys` reported a docblock reading *"…fails with an opaque
 *     Graph error: \"Maximum questions: 4 per configuration\""*;
 *   - `check-double-assertions` counted the phrase `as unknown as` in a comment
 *     documenting why a cast had just been REMOVED — so the ratchet punished the
 *     fix it exists to encourage.
 *
 * A checker that cries wolf gets ignored, and an ignored checker is worse than
 * no checker: it still passes CI while nobody reads it. So the lexer lives once,
 * here, instead of being re-derived on each next occurrence.
 *
 * ## Contract
 *
 * Both functions preserve OFFSETS and NEWLINES exactly — blanked regions become
 * spaces, never deletions — so a caller can keep using `.index` and line counts
 * against the returned text and still report true positions in the real file.
 */

/**
 * Blank comments AND string/template literal CONTENTS (quotes are kept).
 *
 * Use when the thing being matched is a code construct — an identifier, a call,
 * a cast — that must not be found inside prose OR inside a quoted example.
 */
export function stripNonCode(src) {
  return lex(src, { blankStrings: true });
}

/**
 * Blank comments only; string literals are preserved verbatim.
 *
 * Use when the string literal IS the subject (e.g. checking `error: "…"` keys).
 * Literals are skipped as whole tokens, so a `//` inside one — `"https://…"` —
 * cannot open a phantom comment that swallows the rest of the line.
 */
export function stripComments(src) {
  return lex(src, { blankStrings: false });
}

function lex(src, { blankStrings }) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === quote) break;
        else j++;
      }
      if (blankStrings) blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}
