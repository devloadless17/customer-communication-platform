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
 *   - Has `@RequireScope` → the request MUST be api-key-authenticated and
 *     the key must hold the scope (or `"*"`).
 *
 * A scope-gated route is API-KEY-ONLY. There used to be a session
 * passthrough here ("scopes are an API-key concept; session routes use
 * RoleGuard instead") — which was dead code on the only mounted controller
 * (`ApiKeyGuard` rejects sessionless-keyless requests first), but fail-OPEN
 * the moment anyone reused this guard on a controller that also accepts
 * sessions without a RoleGuard behind it. A surface that should serve
 * browser sessions gets its own controller with role/capability guards; it
 * does not ride through here.
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
