/**
 * WhatsApp Business Calling region restrictions.
 *
 * THE RULE THAT MATTERS: business-initiated calling eligibility is decided by
 * the BUSINESS phone number's country, not the customer's. Meta is explicit —
 * "The business phone number's country code must be in this supported list. The
 * consumer phone number can be from any country where Cloud API is available."
 *
 * So a business number registered in a blocked market cannot place calls to
 * anyone, and an eligible business number can call customers anywhere Cloud API
 * reaches. Reading this the other way round (gating on the customer's country)
 * is wrong in both directions at once: it refuses legitimate calls to customers
 * in blocked markets, and it waves through calls from a business number that
 * Meta will reject with an opaque error.
 *
 * Inbound (user-initiated) calling is available everywhere Cloud API is, so
 * none of this applies to receiving calls.
 *
 * Wire-format stability: `bic_blocked_region` appears in API error responses
 * and the frontend filters on it. Adding a country is non-breaking; renaming
 * the exported constants is not.
 */

/**
 * Countries where a business phone number CANNOT place business-initiated
 * calls. A number registered here can still RECEIVE calls normally.
 */
export const BIC_BLOCKED_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "US",
  "CA",
  "EG",
  "VN",
  "NG",
]);

/**
 * Sanctioned regions where Cloud API does not operate at all, in either
 * direction. Listed for defense-in-depth — by the time a contact in one of
 * these reaches a "place call" code path, multiple upstream guards should
 * already have refused the operation.
 *
 * Crimea, Donetsk and Luhansk are sub-regional and not representable in ISO
 * 3166-1 alpha-2 — those still resolve to UA. Treat any sanctioned-region
 * customer as a process-time human decision, not an automatic gate.
 */
export const SANCTIONED_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "CU",
  "IR",
  "KP",
  "SY",
]);

/**
 * True when this team's BUSINESS number may place business-initiated calls.
 *
 * Conservative on null: if we don't know the number's country (no display
 * number stored, or libphonenumber couldn't parse it), don't gate — let the
 * provider be the authority rather than blocking a tenant on missing metadata.
 */
export function isBicAllowedForBusinessNumber(
  businessCountryCode: string | null | undefined,
): boolean {
  if (!businessCountryCode) return true;
  const cc = businessCountryCode.toUpperCase();
  return !BIC_BLOCKED_COUNTRY_CODES.has(cc) && !SANCTIONED_COUNTRY_CODES.has(cc);
}
