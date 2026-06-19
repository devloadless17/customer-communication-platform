import { parsePhoneNumberFromString } from "libphonenumber-js/min";

/**
 * Phone normalization for storage. Returns a digits-only string (no `+`,
 * no spaces, no formatting) that matches Meta's wa_id wire format exactly.
 *
 * Why digits-only and not `+`-prefixed E.164:
 *   - Meta's webhook delivers `from` / `wa_id` as digits only ("96170921116")
 *   - Meta's send endpoint accepts both formats
 *   - Storing digits-only keeps manual-create, CSV import, and webhook ingest
 *     in lockstep — otherwise the same contact gets created twice (a manual
 *     "+96170921116" and an inbound "96170921116") and replies open a new
 *     chat instead of landing in the original thread.
 *
 * Validation: 8-15 digits (E.164's range). Anything else returns null.
 *
 * The function name keeps "E164" for historical reasons; the canonical form
 * we store IS E.164 minus the cosmetic `+`.
 */
export function normalizePhoneE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  // Prefer libphonenumber's canonical national-significant E.164. With the
  // country code present (we prepend `+`), it strips a national TRUNK-PREFIX 0
  // where the plan requires it (UK 07…, LB 03/70…) but KEEPS it where it's
  // significant (Italy +39 0…) — so a number typed/pasted in national format
  // (the common pilot foot-gun) isn't stored as an undeliverable wa_id, and it
  // stays in lockstep with the trunk-0-less wa_id Meta delivers on inbound
  // (preserving the dedupe invariant in this file's header). Falls back to the
  // raw digits when libphonenumber can't validate it, so nothing currently
  // accepted is newly rejected.
  try {
    const parsed = parsePhoneNumberFromString(`+${digits}`);
    if (parsed?.isValid()) {
      const e164 = parsed.number.replace(/\D/g, "");
      if (e164.length >= 8 && e164.length <= 15) return e164;
    }
  } catch {
    // unparseable shape → keep the digits-only fallback below
  }
  return digits;
}
