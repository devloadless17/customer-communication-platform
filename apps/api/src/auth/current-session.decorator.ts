import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import type { ApiSession } from "./session.guard";
import type { ApiKeyContext } from "./api-key.guard";

/**
 * Param decorator that pulls the session attached by SessionGuard:
 *
 *   @UseGuards(SessionGuard)
 *   @Get()
 *   list(@CurrentSession() session: ApiSession) { ... }
 *
 * Throws if no session is present — that means the route forgot to use
 * SessionGuard (or RequireRole), which is a developer error.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiSession => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.session) {
      throw new UnauthorizedException(
        "no session on request — did you forget @UseGuards(SessionGuard)?",
      );
    }
    return req.session;
  },
);

/**
 * Param decorator that pulls the API key context attached by ApiKeyGuard.
 * Used by /external/v1/* controllers.
 */
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiKeyContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.apiKey) {
      throw new UnauthorizedException(
        "no api key on request — did you forget @UseGuards(ApiKeyGuard)?",
      );
    }
    return req.apiKey;
  },
);
