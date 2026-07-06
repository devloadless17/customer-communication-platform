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

/**
 * Format a phone number for display in international form, e.g.
 * "+961 71 505 894". Uses libphonenumber-js so the country-code split and
 * national-number grouping match each country's conventions (a hand-rolled
 * heuristic mis-grouped 3-digit codes like +961 as "+96 1...").
 *
 * Falls back to a "+digits" string if parsing fails — Meta's
 * `display_phone_number` can arrive without a + or be otherwise malformed,
 * and we'd rather show *something* than crash.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/[^\d]/g, "")}`;
  const parsed = parsePhoneNumberFromString(withPlus);
  if (parsed) return parsed.formatInternational();
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `+${digits}` : raw;
}

/**
 * Derive a contact's ISO 3166-1 alpha-2 country code from their phone number
 * via libphonenumber-js. Returns null when the input is missing/unparseable.
 *
 * Used at write time on new contacts (inbound webhook ingest + /v1 POST/PATCH)
 * so the outbound webhook payload's `country_code` is populated without a
 * lookup table maintained in app code. Pure function — safe to call on the
 * hot path; libphonenumber's /min metadata bundle is already in our bundle
 * via `formatPhone`.
 */
export function getCountryFromPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/[^\d]/g, "")}`;
  const parsed = parsePhoneNumberFromString(withPlus);
  return parsed?.country ?? null;
}

/**
 * Display string for a contact's natural identity:
 *   - Phone number when set (WhatsApp/SMS contacts).
 *   - "instagram:<id>", "telegram:<id>", … for channel-native identities.
 *   - "—" fallback when neither is present (shouldn't happen post-ingest).
 *
 * Use this everywhere a contact is rendered as a single line and the UI
 * doesn't already have a richer surface (channel chip + handle). Keeps
 * non-phone contacts legible without forcing every component to learn the
 * multi-channel identity model.
 */
export function formatContactIdentity(contact: {
  phoneNumber: string | null;
  identityChannel?: string | null;
  externalContactId?: string | null;
}): string {
  if (contact.phoneNumber) return formatPhone(contact.phoneNumber);
  if (contact.identityChannel && contact.externalContactId) {
    const channel = contact.identityChannel.replace(/_/g, " ");
    return `${channel}:${contact.externalContactId}`;
  }
  return "—";
}
