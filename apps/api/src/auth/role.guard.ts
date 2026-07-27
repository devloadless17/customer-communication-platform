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
const ORG_ROLES_KEY = "ccp:required-org-role";

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

/**
 * Method/class decorator that gates by ORG role — the tenant-level authority
 * axis, orthogonal to the workspace role RequireRole checks.
 *
 *   @RequireOrgRole("owner") → the org OWNER, strictly. Deliberately NO
 *   superAdmin bypass: routes behind this act on the CALLER'S OWN org
 *   (session.organizationId), so a bypass would let a platform operator
 *   destroy the anchor org by accident — operating on TENANT orgs has its own
 *   surface (admin/admin-organizations) with its own gates.
 *
 * Exists because `resolveSession` collapses a superAdmin, an org owner/admin
 * AND a plain member who admins one workspace all to the effective workspace
 * role "admin" — so an org-destroying route decorated `@RequireRole("admin")`
 * READS as workspace-scoped while actually needing tenant authority. The
 * decorator now says what the route means (§18: org-wide actions need ORG
 * authority).
 */
export function RequireOrgRole(role: "owner"): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(ORG_ROLES_KEY, role),
    UseGuards(SessionGuard, OrgRoleGuard),
  );
}

@Injectable()
export class OrgRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<"owner" | undefined>(
      ORG_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) throw new UnauthorizedException();
    if (session.orgRole !== required) {
      throw new ForbiddenException({
        error: "org_owner_required",
        detail: "only the organization owner can do this",
      });
    }
    return true;
  }
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
