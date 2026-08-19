import { createHash, randomBytes } from "node:crypto";

/**
 * Team API key helpers.
 *
 * Tokens look like `ccp_<48 hex chars>` (24 random bytes). We store
 * SHA-256(token) in WorkspaceApiKey.tokenHash and the first 12 chars —
 * `ccp_` + 8 hex — in tokenPrefix, which is what the UI shows to identify a
 * key. The plaintext is shown ONCE at creation; lost keys are rotated, not
 * recovered.
 *
 * Storing only the hash means a database read leak doesn't grant API access —
 * an attacker would have to reverse SHA-256 on a 24-byte random value first,
 * and the stored prefix reveals 4 of those bytes at most.
 */

const PREFIX = "ccp_";

export interface NewApiKey {
  /** Plaintext token. Show to user ONCE. Never store. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function generateApiKey(): NewApiKey {
  const random = randomBytes(24).toString("hex"); // 48 hex chars
  const token = `${PREFIX}${random}`;
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 12), // "ccp_xxxxxxxx" — recognizable in UI
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Quick shape check before we even hit the DB on auth. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX) && token.length === PREFIX.length + 48;
}
