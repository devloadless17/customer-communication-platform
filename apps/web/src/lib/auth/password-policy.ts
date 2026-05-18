/**
 * Re-export of the cross-process password policy. Lives here as a tiny
 * shim so client forms keep importing `@/lib/auth/password-policy` (no
 * `server-only` chain → safe in `"use client"` components) while the actual
 * source of truth is `@ccp/shared/auth/password-policy`, also consumed by
 * the NestJS side.
 */
export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "@ccp/shared/auth/password-policy";
