import "server-only";

import bcrypt from "bcrypt";

import {
  BCRYPT_COST,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePasswordStructure,
} from "@ccp/shared/auth/password-policy";

/**
 * NestJS-side password helpers. Hashing + verification only — the policy
 * constants and structural validator come from `@ccp/shared/auth/password-policy`
 * so the cost / floor / ceiling stays in lockstep with the Next.js side.
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  validatePasswordStructure,
};
