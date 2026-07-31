/**
 * WhatsApp business USERNAME rules — shared by the settings UI (live validation
 * while typing) and the API (the request gate), so the two can never drift.
 *
 * A username is a chat-native handle (`@my.business`) that is 1:1 with a
 * business phone number and globally unique across WhatsApp. Adopting one does
 * NOT hide the phone number. Meta is the FINAL authority on every rule here —
 * this mirrors its published constraints so an operator hears about a problem
 * while typing instead of as an opaque Graph error, but a value that passes
 * can still be refused by Meta (taken, reserved, policy).
 */

export const WHATSAPP_USERNAME_MIN = 3;
export const WHATSAPP_USERNAME_MAX = 35;

/**
 * Usernames are case-insensitive at Meta — normalize to lowercase in exactly
 * one place so "MyShop" and "myshop" can't be stored as two different strings.
 * `.` and `_` are NOT interchangeable (`my.id` ≠ `my_id`), so nothing beyond
 * case is touched.
 */
export function normalizeWhatsappUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface WhatsappUsernameCheck {
  /** True when no HARD rule failed. Warnings never flip this. */
  ok: boolean;
  /** Hard failures, each a sentence mirroring Meta's rule. Empty when ok. */
  errors: string[];
  /**
   * Heuristic cautions — shown, never blocked on, because Meta is the
   * authority (e.g. "looks like it ends in a TLD" is a guess about a rule
   * Meta enforces with its own list).
   */
  warnings: string[];
  /** The lowercase form actually sent to Meta. */
  normalized: string;
}

/**
 * Validate a candidate username against Meta's published rules:
 * 3–35 chars from `a-z 0-9 . _` (case-insensitive), at least one letter, no
 * leading/trailing period, no `..`, must not start with `www`. The TLD-lookalike
 * check (ends in `.` + 2–4 letters, e.g. `.com`) is a WARNING only.
 */
export function checkWhatsappUsername(raw: string): WhatsappUsernameCheck {
  const normalized = normalizeWhatsappUsername(raw);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (normalized.length < WHATSAPP_USERNAME_MIN || normalized.length > WHATSAPP_USERNAME_MAX) {
    errors.push(
      `Must be ${WHATSAPP_USERNAME_MIN}–${WHATSAPP_USERNAME_MAX} characters long.`,
    );
  }
  if (!/^[a-z0-9._]*$/.test(normalized)) {
    errors.push("Only letters, numbers, periods and underscores are allowed.");
  }
  if (normalized.length > 0 && !/[a-z]/.test(normalized)) {
    errors.push("Must contain at least one letter.");
  }
  if (normalized.startsWith(".") || normalized.endsWith(".")) {
    errors.push("Can't start or end with a period.");
  }
  if (normalized.includes("..")) {
    errors.push("Can't contain consecutive periods.");
  }
  if (normalized.startsWith("www")) {
    errors.push('Can\'t start with "www".');
  }
  // Heuristic, not a rule we can prove: Meta rejects usernames that read as a
  // web domain, and "ends in a period + 2–4 letters" catches `.com`/`.net`/
  // `.shop` without us maintaining a TLD list. Meta arbitrates the real cases.
  if (errors.length === 0 && /\.[a-z]{2,4}$/.test(normalized)) {
    warnings.push(
      "This looks like it ends in a web domain (e.g. .com) — WhatsApp may reject it.",
    );
  }

  return { ok: errors.length === 0, errors, warnings, normalized };
}
