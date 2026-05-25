import { z } from "zod";

import type { Role } from "../types";

/**
 * Single source of truth for "who can do what." Every permission check —
 * server-side guards in API routes AND client-side conditional rendering —
 * goes through these predicates so changing the matrix is a one-file edit.
 *
 * Matrix:
 *   superAdmin  every action; only role that can grant/revoke superAdmin
 *   admin       full team management within their org; cannot touch superAdmins
 *   manager     same conversation powers as agent
 *   agent       reply, assign, mark read, change status, add notes
 *
 * Note: every signed-in user can view /settings/team — it's the team
 * directory. Only `canManageUsers` controls who can edit it.
 */

const SUPER_ADMIN: Role = "superAdmin";

/** Invite a new user, change roles, and deactivate. */
export function canManageUsers(role: Role): boolean {
  return role === "superAdmin" || role === "admin";
}

/**
 * Add / rename / delete team-wide contact field definitions. Manager is
 * included alongside admin: defining a field is a workflow choice, not a
 * security decision, and managers run the inbox day-to-day. Per-contact
 * field VALUES are editable by anyone signed in (handled at the contact
 * PATCH route, not here).
 */
export function canManageContactFields(role: Role): boolean {
  return DEFAULT_CAPABILITIES[role]["contactFields:manage"];
}

/**
 * Add / rename / recolor / reorder / delete customer-lifecycle stages.
 * Same shape as contact-field management: a workflow knob managers turn
 * day-to-day, not a security decision. MOVING a contact between existing
 * stages is open to anyone signed in (handled at the contact PATCH route).
 */
export function canManageStages(role: Role): boolean {
  return DEFAULT_CAPABILITIES[role]["stages:manage"];
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

/* ------------------------------------------------------------------------- *
 * Admin-configurable per-role capabilities
 *
 * A team admin can override, per role, which of these capabilities its
 * managers/agents have. Overrides live on `Team.rolePermissions` (sparse
 * JSON); `resolvePermissions(role, teamConfig)` overlays them on top of the
 * defaults below. admin/superAdmin are always allowed everything — the org
 * owner can't be locked out — so only `manager` and `agent` are editable.
 *
 * Wire-format stability: these capability strings are persisted in the DB
 * and round-trip through the settings API. Add new ones, don't rename.
 * ------------------------------------------------------------------------- */

export type Capability =
  | "conversations:delete"
  | "contacts:delete"
  | "broadcasts:manage"
  | "templates:manage"
  | "audienceGroups:manage"
  | "stages:manage"
  | "contactFields:manage";

export const ALL_CAPABILITIES: Capability[] = [
  "conversations:delete",
  "contacts:delete",
  "broadcasts:manage",
  "templates:manage",
  "audienceGroups:manage",
  "stages:manage",
  "contactFields:manage",
];

/** Roles whose capabilities an admin may edit. admin/superAdmin are fixed. */
export const EDITABLE_ROLES = ["manager", "agent"] as const;
export type EditableRole = (typeof EDITABLE_ROLES)[number];

/** Human labels for the settings grid. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "conversations:delete": "Delete conversations",
  "contacts:delete": "Delete contacts",
  "broadcasts:manage": "Create & manage broadcasts",
  "templates:manage": "Create & manage templates",
  "audienceGroups:manage": "Manage audience groups",
  "stages:manage": "Manage lifecycle stages",
  "contactFields:manage": "Manage contact fields",
};

/**
 * Default capability matrix — reproduces pre-feature behavior EXACTLY so an
 * un-configured team (`rolePermissions = {}`) is unchanged on deploy:
 *  - admin/superAdmin: everything (and not editable; the resolver forces this).
 *  - manager: everything — stages/fields matched the old `canManageStages/
 *    canManageContactFields`; delete/broadcast/template/groups were ungated
 *    (open to all), so `true` preserves that.
 *  - agent: delete/broadcast/template/groups true (ungated before); stages +
 *    contactFields false (agents never had those manage powers).
 */
export const DEFAULT_CAPABILITIES: Record<Role, Record<Capability, boolean>> = {
  superAdmin: allCapabilities(true),
  admin: allCapabilities(true),
  manager: allCapabilities(true),
  agent: {
    "conversations:delete": true,
    "contacts:delete": true,
    "broadcasts:manage": true,
    "templates:manage": true,
    "audienceGroups:manage": true,
    "stages:manage": false,
    "contactFields:manage": false,
  },
};

function allCapabilities(value: boolean): Record<Capability, boolean> {
  return ALL_CAPABILITIES.reduce(
    (acc, cap) => {
      acc[cap] = value;
      return acc;
    },
    {} as Record<Capability, boolean>,
  );
}

/** Persisted shape of `Team.rolePermissions` after validation. */
export type RolePermissionsConfig = Partial<
  Record<EditableRole, Partial<Record<Capability, boolean>>>
>;

/**
 * Resolve the effective capability map for a role given a team's stored
 * overrides. Pure — same inputs always yield the same output, so it's safe to
 * call on both server (guards) and client (UI gating).
 *
 * - admin/superAdmin → all true, ignoring `teamConfig` (can't lock out the
 *   org owner).
 * - manager/agent → defaults overlaid with any keys present in
 *   `teamConfig[role]`. Sparse: a missing key keeps the default.
 *
 * `teamConfig` is typed `unknown` because it arrives as raw Prisma JSON; we
 * validate-by-shape inline rather than trusting the caller.
 */
export function resolvePermissions(
  role: Role,
  teamConfig: unknown,
): Record<Capability, boolean> {
  if (role === "superAdmin" || role === "admin") {
    return allCapabilities(true);
  }

  const resolved = { ...DEFAULT_CAPABILITIES[role] };
  const overrides = readRoleOverrides(teamConfig, role);
  for (const cap of ALL_CAPABILITIES) {
    const value = overrides[cap];
    if (typeof value === "boolean") resolved[cap] = value;
  }
  return resolved;
}

/** Convenience: does the resolved map grant `cap`? */
export function hasCapability(
  perms: Record<Capability, boolean>,
  cap: Capability,
): boolean {
  return perms[cap] === true;
}

/** Pull a single role's override sub-map out of raw JSON, defensively. */
function readRoleOverrides(
  teamConfig: unknown,
  role: EditableRole,
): Partial<Record<Capability, boolean>> {
  if (!teamConfig || typeof teamConfig !== "object") return {};
  const sub = (teamConfig as Record<string, unknown>)[role];
  if (!sub || typeof sub !== "object") return {};
  return sub as Partial<Record<Capability, boolean>>;
}

/**
 * Zod schema for the PATCH body / stored value. Only editable roles, only
 * known capabilities, only booleans. `admin`/`superAdmin` keys are rejected so
 * a malformed write can't claim to lock out the owner. `.strict()` rejects
 * unknown role keys.
 */
const zCapabilityMap = z
  .object(
    ALL_CAPABILITIES.reduce(
      (acc, cap) => {
        acc[cap] = z.boolean().optional();
        return acc;
      },
      {} as Record<Capability, z.ZodOptional<z.ZodBoolean>>,
    ),
  )
  .strict();

export const zRolePermissions = z
  .object({
    manager: zCapabilityMap.optional(),
    agent: zCapabilityMap.optional(),
  })
  .strict();
