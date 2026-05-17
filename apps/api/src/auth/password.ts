import "server-only";

import { createHash } from "node:crypto";

import bcrypt from "bcryptjs";

// 10 rounds: ~100ms on dev hardware. Higher hardens against offline attacks
// at the cost of login latency; 10 is the standard sweet spot for B2B apps.
const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Minimum password length. Modern guidance (NIST SP 800-63B) favours length
 * over arbitrary complexity rules; combined with the breach check below,
 * this is the floor we enforce. Bump back up if compliance ever requires it.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Validate a candidate password against the local policy. Returns an error
 * message string when the password fails, or null when it's structurally
 * OK. Does NOT do the breach check — that's a network call and lives in
 * `isPasswordBreached` so callers can decide whether to await it.
 */
export function validatePasswordStructure(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (plain.length > 200) {
    // Bcrypt only uses the first 72 bytes anyway, but cap input to keep
    // the HIBP request body sane and avoid pathological hashing inputs.
    return "Password is too long.";
  }
  return null;
}

/**
 * Have I Been Pwned k-anonymity check. We send only the first 5 chars of
 * the SHA-1 hash, and look for the rest in the returned bucket. Plain
 * password never leaves this process.
 *
 * Fail-OPEN on network error — we don't want the signup flow to break
 * because HIBP is down. Returns:
 *   - true  → password appears in known breaches; reject it.
 *   - false → either clean, or the API was unreachable.
 *
 * Tradeoff considered: failing CLOSED (treat any HIBP failure as breached)
 * would harden against a downgrade-by-DNS-blocking attack, but the realistic
 * threat here is "user picks a common password", not "attacker silences
 * HIBP and slips a known-pwned password past us" — so open is the right
 * call for UX.
 */
export async function isPasswordBreached(plain: string): Promise<boolean> {
  try {
    const sha1 = createHash("sha1").update(plain).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: {
        // Padding obscures the exact bucket size from a passive observer
        // who could otherwise narrow down the hash prefix.
        "Add-Padding": "true",
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;

    const text = await res.text();
    for (const line of text.split("\n")) {
      // Each line is "<hashSuffix>:<count>". Padding rows have count 0;
      // those still match by suffix but indicate "not actually breached".
      const [hashSuffix, countStr] = line.split(":");
      if (!hashSuffix || !countStr) continue;
      if (hashSuffix.trim().toUpperCase() === suffix && Number(countStr.trim()) > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
