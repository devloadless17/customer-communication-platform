/**
 * E.164-ish phone normalization. We don't pull in libphonenumber for MVP —
 * Meta itself doesn't validate against a country DB at the API layer; it
 * accepts a leading-`+`-then-digits string and routes by it. We mirror that:
 *
 *  - Strip everything except digits and the leading `+`
 *  - Require a leading `+` followed by 8-15 digits (E.164's max is 15)
 *
 * If the user types without `+`, we add it — friendlier than rejecting
 * "+1 555 555 0100" vs "1 555 555 0100" inputs that mean the same thing.
 *
 * Returns null on values that can't possibly be a phone number.
 */
export function normalizePhoneE164(raw: string): string | null {
  const stripped = raw.replace(/[^\d+]/g, "");
  if (!stripped) return null;
  // Drop any `+` past the first character — pasted strings sometimes carry
  // a stray ++ from copy-paste or formatting.
  const withPlus = stripped.startsWith("+")
    ? "+" + stripped.slice(1).replace(/\+/g, "")
    : "+" + stripped.replace(/\+/g, "");
  const digits = withPlus.slice(1);
  if (digits.length < 8 || digits.length > 15) return null;
  return withPlus;
}
