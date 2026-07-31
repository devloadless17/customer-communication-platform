import "server-only";

/**
 * FACADE — the real fetchers live in ./queries/<domain>.ts (split 2026-07-31;
 * this file had grown to 1,076 lines of ~130 fetchers + 25 DTOs across 13
 * domains). Every existing `@/lib/api/queries` import keeps working through
 * these re-exports — 67 files imported it on split day, and churning them
 * bought nothing. New code may import the domain file directly.
 */
export * from "./queries/team";
export * from "./queries/super-admin";
export * from "./queries/catalogs";
export * from "./queries/conversations";
export * from "./queries/contacts";
export * from "./queries/team-chat";
export * from "./queries/whatsapp";
export * from "./queries/broadcasts";
export * from "./queries/api-keys";
export * from "./queries/outbound-webhooks";
export * from "./queries/workflows";
export * from "./queries/invites";
export * from "./queries/helpers";
