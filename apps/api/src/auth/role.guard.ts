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

import { canManageUsers } from "@ccp/shared/auth/permissions";
import type { Role } from "@ccp/shared/types";

import { SessionGuard } from "./session.guard";

const ROLES_KEY = "ccp:required-roles";

type RoleRequirement = "admin" | "superAdmin";

/**
 * Method/class decorator that gates by role.
 *
 *   @RequireRole("admin")    → admin OR superAdmin (same as requireAdmin)
 *   @RequireRole("superAdmin") → superAdmin only
 *
 * Composes the session guard so callers don't need to remember to add
 * both — using `@RequireRole(...)` implies a valid session.
 */
export function RequireRole(role: RoleRequirement): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(ROLES_KEY, role),
    UseGuards(SessionGuard, RoleGuard),
  );
}

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleRequirement | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) throw new UnauthorizedException();

    const role: Role = session.role;
    if (required === "superAdmin") {
      // Platform-level gate: keys on the `isSuperAdmin` FLAG, never on the
      // workspace role — resolveSession resolves both a platform superAdmin and
      // an ordinary org admin to role "admin", so a role check here would hand
      // every org admin the platform console.
      if (!session.isSuperAdmin) throw new ForbiddenException({ error: "forbidden" });
      return true;
    }
    // admin (a superAdmin already resolves to "admin", so this covers both)
    if (!canManageUsers(role)) throw new ForbiddenException({ error: "forbidden" });
    return true;
  }
}
