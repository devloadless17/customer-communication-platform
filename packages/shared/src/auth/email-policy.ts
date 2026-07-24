/**
 * Is this address worth creating an account for?
 *
 * Two checks, and it is worth being precise about what each one buys, because
 * the temptation is to add more and they stop paying for themselves quickly.
 *
 * 1. SHAPE — a real parse, not the `/\S+@\S+\.\S+/` that let `a@b.c` through.
 * 2. DISPOSABLE DOMAINS — a small static list of the throwaway-inbox services.
 *
 * What this deliberately does NOT do is an MX lookup. It costs a DNS round-trip
 * on the signup path, it fails for domains that are perfectly deliverable behind
 * a slow resolver, and it still proves nothing about whether the mailbox exists.
 * The OTP proves that, and the OTP is the actual gate — this is only here to
 * stop the obvious junk before we spend a send on it.
 *
 * The list is intentionally SHORT. A comprehensive one is a maintenance
 * treadmill (new domains daily) and every entry is a chance to lock out a real
 * customer. These are the handful that show up in practice.
 */

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mailnesia.com",
  "spamgourmet.com",
]);

/**
 * A pragmatic address parse. Not RFC 5322 — that grammar permits quoted strings
 * and comments nobody types, and implementing it faithfully rejects nothing
 * users actually send. This requires a local part, one `@`, and a domain with a
 * dot and a 2+ character TLD.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[a-z]{2,}$/i;

export type EmailRejection = "invalid" | "disposable";

/**
 * `null` when the address is acceptable, otherwise why it isn't.
 *
 * Returns a REASON rather than a message so the caller owns the wording — the
 * signup form and the invite form phrase these differently.
 */
export function checkEmailPolicy(email: string): EmailRejection | null {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) return "invalid";

  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) return "disposable";

  return null;
}

/** Exposed for tests + the settings UI; never mutate. */
export function isDisposableEmailDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.trim().toLowerCase());
}
