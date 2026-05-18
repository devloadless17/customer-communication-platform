import { z } from "zod";

import { API_KEY_SCOPES } from "@ccp/shared/api-keys/scopes";

/**
 * Scope catalog for new keys. The DB column accepts any string array
 * (it's a TEXT[]), but the create endpoint Zod-validates against the
 * known catalog so a partner can't write garbage that the ScopeGuard
 * would then silently never match.
 */
const ScopeEnum = z.enum(API_KEY_SCOPES);

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  /**
   * Optional. If omitted, the create endpoint defaults to `["*"]` — the
   * wildcard. The settings UI presents specific scope checkboxes so
   * the wildcard path is essentially "admin / migration only" usage.
   */
  scopes: z
    .array(ScopeEnum)
    .min(1, "at least one scope is required")
    .max(API_KEY_SCOPES.length)
    .optional(),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;
