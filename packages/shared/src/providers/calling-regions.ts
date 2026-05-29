/**
 * WhatsApp Business Calling region restrictions.
 *
 * Meta enforces two distinct blocklists:
 *
 *   - BIC blocked: Business-Initiated Calling is disabled in these markets.
 *     The customer can still call you (inbound works everywhere Cloud API
 *     does), but the inbox's outbound "Call" button must be hidden when
 *     the contact's phone country is on this list. Confirmed via Meta
 *     partner docs (Wati, Infobip, respond.io — 2026-05).
 *
 *   - Sanctioned: NEITHER direction works. Cloud API itself is blocked,
 *     so messaging is already absent for these — listed here for the
 *     defense-in-depth backend pre-flight, but the messaging side already
 *     guards above this layer.
 *
 * Both lists are ISO 3166-1 alpha-2 country codes. The country itself is
 * derived from the contact's phone number via libphonenumber-js (already
 * stored on Contact.countryCode at create/ingest time).
 *
 * Sources:
 *   https://support.wati.io/en/articles/12546668-understanding-whatsapp-calling-restrictions-and-guidelines
 *   https://respond.io/whatsapp-business-calling-api
 *   https://www.infobip.com/docs/whatsapp/whatsapp-business-calling
 *
 * Wire-format stability: these codes appear in API error responses
 * (`{ reason: "bic_blocked_region" }`) and the frontend filters on them.
 * Adding a country to the list is non-breaking; renaming the constant is.
 */

/**
 * Business-Initiated Calling is unavailable in these countries. INBOUND
 * (customer-initiated) calls still work — only outbound is blocked.
 *
 * Codes: USA (US), Canada (CA), Egypt (EG), Vietnam (VN), Nigeria (NG)
 * per Meta as of 2026-05.
 */
export const BIC_BLOCKED_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "US",
  "CA",
  "EG",
  "VN",
  "NG",
]);

/**
 * Sanctioned regions where Cloud API itself does not operate, including
 * calling in both directions. Listed for defense-in-depth — by the time
 * a contact in one of these reaches a "place call" code path, multiple
 * upstream guards should already have refused the operation.
 *
 * Codes: Cuba (CU), Iran (IR), North Korea (KP), Syria (SY). Crimea +
 * Donetsk + Luhansk are sub-regional and not representable in ISO 3166-1
 * alpha-2 — those still resolve to UA. Treat any sanctioned-region
 * customer as a process-time human decision, not an automatic gate.
 */
export const SANCTIONED_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "CU",
  "IR",
  "KP",
  "SY",
]);

/**
 * True when outbound calling is allowed for a contact with the given
 * country code. Conservative on null — if we don't know the country
 * (libphonenumber-js couldn't parse), don't gate; defense-in-depth runs
 * on the Meta side at placeCall time.
 */
export function isBicAllowed(countryCode: string | null | undefined): boolean {
  if (!countryCode) return true;
  const cc = countryCode.toUpperCase();
  return !BIC_BLOCKED_COUNTRY_CODES.has(cc) && !SANCTIONED_COUNTRY_CODES.has(cc);
}
