import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { hasScope, type ApiKeyScope } from "@ccp/shared/api-keys/scopes";

import { SCOPE_META_KEY } from "./scope.decorator";

/**
 * Enforces `@RequireScope(...)` declared on a controller route. Must run
 * AFTER `ApiKeyGuard` so `req.apiKey.scopes` is populated.
 *
 * Behavior:
 *   - No `@RequireScope` on the route → allow (open per the controller
 *     gate above, which already required an api key OR a session).
 *   - Has `@RequireScope` AND request authenticated by api key:
 *     check `req.apiKey.scopes` includes the required scope (or `"*"`).
 *   - Has `@RequireScope` AND request authenticated by SESSION (the
 *     agent UI calling the same controller): allow — scopes are an
 *     API-key concept, not an RBAC concept. Session-based routes use
 *     `RoleGuard` for permission enforcement instead.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(
      SCOPE_META_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    // Session-authenticated request — out of scope for this guard.
    if (!req.apiKey && req.session) return true;
    if (!req.apiKey) {
      throw new ForbiddenException({
        error: "no_credentials",
        detail: "scope-gated route requires an api key",
      });
    }
    if (!hasScope(req.apiKey.scopes, required)) {
      throw new ForbiddenException({
        error: "insufficient_scope",
        detail: `this api key is missing the required scope "${required}"`,
        required,
      });
    }
    return true;
  }
}
