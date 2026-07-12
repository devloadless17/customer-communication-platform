import type { ContactShareField } from "../providers/types";
import { normalizePhoneE164 } from "./phone";

/**
 * Interpreting a tapped "share your phone / email" consent chip.
 *
 * Meta's inbound webhook for these chips is DELIBERATELY ambiguous: the shared
 * value lands in BOTH `message.text` and `message.quick_reply.payload`, and the
 * frame is structurally identical to a normal text quick-reply. There is no
 * `content_type` echo — nothing on the wire says "this was the phone chip".
 *
 * So we never guess from the value alone. Two guards, both required:
 *
 *   1. CORRELATION — the reply must follow an outbound message that actually
 *      offered that chip (the offered set is persisted on the outbound message's
 *      `rawPayload.interactive.contactShare`). Without this, an `ask_question`
 *      option whose author-assigned id happened to be `sales@acme.com` would
 *      overwrite the customer's email the moment they tapped it.
 *   2. VALIDATION — the value must actually parse as the requested kind. Meta
 *      returns the RAW profile string (no E.164 normalization is documented), so
 *      we normalize before storing and reject anything that doesn't parse.
 *
 * Both live here so the ingest path reads as one decision, not two half-checks.
 */

// Deliberately conservative: one `@`, a dot-bearing domain, no whitespace. We
// are deciding whether to WRITE this onto a customer's identity record and then
// auto-merge two profiles on it — a false positive silently fuses two people.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isPlausibleEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 320 && EMAIL_RE.test(v);
}

export interface ContactShareValue {
  field: ContactShareField;
  /** Normalized for storage: E.164 digits for phone, lowercased for email. */
  value: string;
}

/**
 * Resolve a tapped quick-reply payload into a contact-identity write, or `null`
 * when it isn't one.
 *
 * @param payload   the `quick_reply.payload` Meta sent (the raw profile value)
 * @param offered   the chips the preceding outbound message actually offered
 * @param optionIds ids of the regular text options on that same message — a
 *                  payload matching one of these is an ordinary reply, never a share
 */
export function resolveContactShare(
  payload: string,
  offered: readonly ContactShareField[],
  optionIds: readonly string[] = [],
): ContactShareValue | null {
  const raw = payload.trim();
  if (raw.length === 0 || offered.length === 0) return null;
  // An author-defined option id always wins — that's a normal button tap.
  if (optionIds.includes(raw)) return null;

  if (offered.includes("email") && isPlausibleEmail(raw)) {
    return { field: "email", value: raw.toLowerCase() };
  }
  if (offered.includes("phone")) {
    const e164 = normalizePhoneE164(raw);
    if (e164) return { field: "phone", value: e164 };
  }
  return null;
}
