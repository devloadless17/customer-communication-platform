import type { Role } from "@/lib/types";

/**
 * Single source of truth for "who can do what." Every permission check —
 * server-side guards in API routes AND client-side conditional rendering —
 * goes through these predicates so changing the matrix is a one-file edit.
 *
 * Matrix:
 *   superAdmin  every action; only role that can grant/revoke superAdmin
 *   admin       full team management within their org; cannot touch superAdmins
 *   manager     read-only visibility into /settings/team; same conversation
 *               powers as agent
 *   agent       reply, assign, mark read, change status, add notes
 */

const SUPER_ADMIN: Role = "superAdmin";

/** Anyone in this set sees the Settings → Team link and can open the page. */
export function canViewTeamSettings(role: Role): boolean {
  return role === "superAdmin" || role === "admin" || role === "manager";
}

/** Invite a new user, change roles, and deactivate. */
export function canManageUsers(role: Role): boolean {
  return role === "superAdmin" || role === "admin";
}

/** Only superAdmins can grant or revoke the superAdmin role. */
export function canGrantSuperAdmin(role: Role): boolean {
  return role === SUPER_ADMIN;
}

/**
 * Whether `actor` is allowed to mutate `target`'s role / activation.
 * - superAdmin can modify anyone (incl. other superAdmins).
 * - admin can modify anyone EXCEPT a superAdmin.
 * - everyone else: never.
 *
 * Self-edit guards (don't demote yourself, don't deactivate yourself) live
 * in the route handler since they apply equally regardless of role.
 */
export function canModifyUser(actor: Role, target: Role): boolean {
  if (actor === "superAdmin") return true;
  if (actor === "admin") return target !== "superAdmin";
  return false;
}

/** Set of roles `actor` is allowed to assign to a target. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "superAdmin") return ["superAdmin", "admin", "manager", "agent"];
  if (actor === "admin") return ["admin", "manager", "agent"];
  return [];
}

/** Pretty label for UI. */
export function roleLabel(role: Role): string {
  switch (role) {
    case "superAdmin":
      return "Super admin";
    case "admin":
      return "Admin";
    case "manager":
      return "Manager";
    case "agent":
      return "Agent";
  }
}

export const ALL_ROLES: Role[] = ["superAdmin", "admin", "manager", "agent"];
