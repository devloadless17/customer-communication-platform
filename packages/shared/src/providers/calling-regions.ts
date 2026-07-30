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
/**
 * These five are CURRENT as of 2026-07-30, and Turkey is deliberately NOT among
 * them — verified twice because the sources disagree.
 *
 * Meta REMOVED Turkey from this list some time between 2025-10-05 and 2026-05-13,
 * as a silent doc edit with no changelog entry. Wayback pins both ends: the
 * 2025-09-26 and 2025-10-05 snapshots read "USA Canada Turkey Egypt Vietnam
 * Nigeria", while the 2026-05-13 and 2026-07-05 snapshots — and a live fetch of
 * both the `/documentation/` and legacy `/docs/` pages today — read "United
 * States, Canada, Egypt, Vietnam, Nigeria". The calling FAQ used to carry a
 * duplicate copy of the six; by 2026-04-13 Meta had reduced that answer to "See
 * Calling Availability" rather than maintain two lists.
 *
 * TWO TRAPS, both of which produced a wrong "add Turkey back" conclusion during
 * this audit before being caught:
 *   1. The docs MCP's search index serves page versions stamped Oct/Nov 2025 for
 *      this page — i.e. PRE-edit. Reading the index rather than fetching the URL
 *      returns the stale six.
 *   2. Third-party integrator docs (Wati, Respond.io, Infobip, Twilio, …) still
 *      mirror the old six. Do not let one of them be cited as a refutation.
 *
 * So: fetch the live page, and cross-check a second URL, before editing this set.
 * Error 138013 stays handled as a clean refusal regardless — its remediation text
 * points at exactly this availability section, so it is the documented server-side
 * answer AND the safety net if Meta re-adds a country as quietly as it dropped one.
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
