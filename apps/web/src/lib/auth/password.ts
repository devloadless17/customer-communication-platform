import "server-only";

/**
 * Server-side password helpers for the Next.js process. Thin re-exports of
 * the shared policy so server actions keep their single import path. Hashing
 * lives on the NestJS side (apps/api/src/auth/password.ts) — duplicating
 * bcrypt + cost here would be dead weight, since /register and /invite both
 * go through NestJS for the actual credential write.
 */
export {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  validatePasswordStructure,
} from "@ccp/shared/auth/password-policy";
