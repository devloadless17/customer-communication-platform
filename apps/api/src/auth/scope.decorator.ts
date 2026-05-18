import { SetMetadata } from "@nestjs/common";

import type { ApiKeyScope } from "@ccp/shared/api-keys/scopes";

/**
 * Marks a route as requiring a specific API-key scope. Used together with
 * `ScopeGuard` so the guard runs after `ApiKeyGuard` (which populates
 * `req.apiKey.scopes`) and gates the handler accordingly.
 *
 * Sessions (Better Auth, agent UI traffic) are NOT scope-gated — the
 * existing RBAC permissions live on `User.role`. ScopeGuard skips when
 * the request has a session and no apiKey, mirroring how the unified
 * permission story currently works.
 *
 * Usage:
 *   ＠RequireScope("write:contacts")
 *   ＠Post("/contacts")
 *   create(...) { ... }
 */
export const SCOPE_META_KEY = "ccp:required-scope";

export const RequireScope = (scope: ApiKeyScope) => SetMetadata(SCOPE_META_KEY, scope);
