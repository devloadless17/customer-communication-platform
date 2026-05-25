import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  applyDecorators,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { resolvePermissions } from "@ccp/shared/auth/permissions";
import type { Capability } from "@ccp/shared/auth/permissions";

import { SessionGuard } from "./session.guard";

const CAP_KEY = "ccp:required-capability";

/**
 * Method/class decorator that gates by an admin-configurable capability.
 *
 *   @RequireCapability("broadcasts:manage")
 *
 * Composes the session guard so callers don't double-apply. The capability is
 * resolved from `req.session.role` + the team's stored `rolePermissions`
 * (already on the session — zero extra DB read). admin/superAdmin always pass.
 *
 * Body-dependent gates (e.g. contacts bulk where only `action:"delete"` should
 * be gated) can't use this decorator — the guard runs before the handler reads
 * the body. Those check `resolvePermissions(...)` inline in the handler.
 */
export function RequireCapability(
  capability: Capability,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(CAP_KEY, capability),
    UseGuards(SessionGuard, CapabilityGuard),
  );
}

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability | undefined>(
      CAP_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) throw new UnauthorizedException();

    const perms = resolvePermissions(session.role, session.rolePermissions);
    if (!perms[required]) throw new ForbiddenException("forbidden");
    return true;
  }
}
