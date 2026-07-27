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
   * REQUIRED. This used to be optional and defaulted to `["*"]`, so
   * `POST /api/workspace/api-keys {"name":"x"}` minted a FULL-ACCESS key —
   * and `"*"` short-circuits `hasScope`, so it also bypassed `admin:settings`.
   * Least privilege has to be the default for a credential mint; the settings
   * UI has shipped its scope picker and always sends this, and a caller that
   * genuinely wants everything can say `["*"]` explicitly.
   */
  scopes: z
    .array(ScopeEnum)
    .min(1, "at least one scope is required")
    .max(API_KEY_SCOPES.length),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;
