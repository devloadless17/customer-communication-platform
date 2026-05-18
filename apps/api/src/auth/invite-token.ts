import { createHash, randomBytes } from "node:crypto";

/**
 * Invite tokens.
 *
 * The raw token is a 32-byte random URL-safe string handed to the inviter
 * once (in the share link). We persist only its SHA-256 hash, the same
 * pattern as a password — so a DB leak doesn't grant attackers the ability
 * to accept pending invites. The hash is also the unique key on the row,
 * which means lookup is a single indexed read.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy — way past brute-force range.

export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Default expiry — long enough that an admin can DM the link to a teammate
 * without urgency, short enough that abandoned invites self-clean.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function inviteExpiry(now = Date.now()): Date {
  return new Date(now + INVITE_TTL_MS);
}
