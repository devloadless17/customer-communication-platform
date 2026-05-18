/**
 * Cross-process password policy. Both the web and api sides import from here
 * so a bump to the floor / ceiling / hashing cost lands in one place. Drift
 * here causes silent verify-mismatch bugs at a session boundary — e.g. web
 * hashes at cost 10, api re-hashes at cost 11, and the cookie suddenly stops
 * verifying after a Better Auth update.
 *
 * No `server-only` import — client forms render `MIN_PASSWORD_LENGTH` in
 * placeholders and `minLength` attributes, and `validatePasswordStructure`
 * is pure data with no Node-only deps.
 *
 * Bumping BCRYPT_COST is a coordinated change — every NEW password hashes at
 * the new cost, but existing `Account.password` rows keep their stored cost
 * (bcrypt's hash encodes its own cost prefix) and verify identically.
 *
 * 10 ≈ 100ms on typical hardware. The standard B2B sweet spot.
 */
export const BCRYPT_COST = 10;

/**
 * Modern guidance (NIST SP 800-63B) favours length over arbitrary complexity
 * rules. Bump back up if compliance ever requires it.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Upper cap is not a security boundary — bcrypt only uses the first 72 bytes
 * regardless. The limit exists to keep memory / CPU bounded on pathological
 * inputs.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Pure structural check. Returns an error message string when the password
 * fails, or null when it's structurally OK. Hashing / breach checks are NOT
 * done here — see `apps/api/src/auth/password.ts` for hashing.
 */
export function validatePasswordStructure(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return "Password is too long.";
  }
  return null;
}
