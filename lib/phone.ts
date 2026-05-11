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
  return digits;
}
