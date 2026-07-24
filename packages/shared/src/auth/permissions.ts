import type { OrgRole, Role } from "../types";

/**
 * Single source of truth for "who can do what." Every permission check —
 * server-side guards in API routes AND client-side conditional rendering —
 * goes through these predicates so changing the matrix is a one-file edit.
 *
 * Matrix (per-WORKSPACE roles):
 *   admin       full workspace management; cannot touch a platform superAdmin
 *   manager     same conversation powers as agent
 *   agent       reply, assign, mark read, change status, add notes
 *
 * `superAdmin` is NOT a role here any more — it is the platform-level
 * `User.isSuperAdmin` flag, orthogonal to any workspace. `resolveSession`
 * already resolves a superAdmin (and an org owner/admin) to an EFFECTIVE
 * workspace role of "admin", so these predicates only ever see the three
 * workspace roles. The one place the flag still matters is protecting a
 * superAdmin from being modified by a mere workspace admin — see
 * `canModifyUser`, which takes the flag explicitly rather than inferring it.
 *
 * Note: every signed-in user can view /settings/team — it's the team
 * directory. Only `canManageUsers` controls who can edit it.
 */

/** Invite a new user, change roles, and deactivate. */
export function canManageUsers(role: Role): boolean {
  return role === "admin";
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

/** An actor/target for the user-management checks below. `isSuperAdmin` is the
 *  platform flag; `role` is the effective role in the workspace being acted in;
 *  `orgRole` is the org-directory role.
 *
 *  `orgRole` is OPTIONAL and its absence means "no org authority". That default
 *  is deliberate: the org-wide checks below are the security boundary, so a call
 *  site that forgets to pass it fails CLOSED rather than silently granting the
 *  power it was supposed to gate. UI gating that only knows the workspace role
 *  (the members table's inline role picker) legitimately omits it. */
export interface UserActor {
  role: Role;
  isSuperAdmin: boolean;
  orgRole?: OrgRole;
}

/**
 * Whether `actor` is allowed to mutate `target`'s role WITHIN one workspace.
 * - a platform superAdmin can modify anyone (incl. other superAdmins).
 * - a workspace admin can modify anyone EXCEPT a platform superAdmin.
 * - everyone else: never.
 *
 * This is the WORKSPACE-scoped gate. Anything whose effect reaches beyond the
 * workspace — deactivating an account, deleting it, resetting its password —
 * must use `canModifyUserAccount` instead. See its comment for why.
 *
 * SECURITY: the "admin cannot touch a superAdmin" rule keys on the target's
 * `isSuperAdmin` FLAG. It used to key on the target's role, which no longer
 * carries that information — inferring it from the role would silently drop the
 * protection and let any workspace admin demote a platform operator.
 *
 * Self-edit guards (don't demote yourself, don't deactivate yourself) live
 * in the route handler since they apply equally regardless of role.
 */
export function canModifyUser(actor: UserActor, target: UserActor): boolean {
  if (actor.isSuperAdmin) return true;
  if (actor.role === "admin") return !target.isSuperAdmin;
  return false;
}

/**
 * Does this actor administer the ORGANIZATION — its directory, its plan, its
 * workspaces? Platform operators always do.
 *
 * Distinct from `canManageUsers(role)`, which asks about the ACTIVE WORKSPACE.
 * `resolveSession` collapses a superAdmin, an org owner/admin AND a plain org
 * member who happens to hold `WorkspaceMember.role = "admin"` in one workspace
 * all down to the effective workspace role `"admin"` — so a workspace-role
 * check cannot tell the third case from the first two.
 */
export function canManageOrgDirectory(actor: UserActor): boolean {
  return (
    actor.isSuperAdmin || actor.orgRole === "owner" || actor.orgRole === "admin"
  );
}

/**
 * Whether `actor` may act on `target`'s ACCOUNT — deactivate it, delete it, or
 * reset its password.
 *
 * These are org-wide, irreversible-ish effects: a deactivated user can't sign in
 * to ANY workspace, a deleted one is gone from the organization entirely, and a
 * reset password kicks every device. Gating them on the per-workspace role let
 * a plain org member who administers one workspace delete the org owner — the
 * authority to run one inbox is not the authority to run the company's account
 * directory.
 *
 * Three rules, in order:
 *   1. a platform superAdmin may act on anyone;
 *   2. the actor must administer the organization (owner / admin);
 *   3. nobody may act on a platform superAdmin, and only an OWNER may act on
 *      another owner — so an org admin can't remove the person who owns the
 *      account they were granted admin on.
 *
 * Same-organization membership is NOT checked here (this is a pure predicate);
 * every caller already scopes its target lookup to the tenant.
 */
export function canModifyUserAccount(actor: UserActor, target: UserActor): boolean {
  if (actor.isSuperAdmin) return true;
  if (!canManageOrgDirectory(actor)) return false;
  if (target.isSuperAdmin) return false;
  if (target.orgRole === "owner" && actor.orgRole !== "owner") return false;
  return true;
}

/**
 * Set of WORKSPACE roles `actor` is allowed to assign to a target. Granting or
 * revoking the platform `isSuperAdmin` flag is deliberately NOT expressible
 * here — it is a platform-level action on its own admin surface, not a
 * workspace role assignment.
 */
export function assignableRoles(actor: UserActor): Role[] {
  if (actor.isSuperAdmin || actor.role === "admin") return ["admin", "manager", "agent"];
  return [];
}

/** Pretty label for UI. */
export function roleLabel(role: Role): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "manager":
      return "Manager";
    case "agent":
      return "Agent";
  }
}

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
  | "contacts:export"
  | "contacts:import"
  | "broadcasts:manage"
  | "templates:manage"
  | "audienceGroups:manage"
  | "stages:manage"
  | "contactFields:manage"
  | "tags:manage"
  | "messageFlags:manage"
  | "inboxViews:manageShared"
  | "snippets:manage"
  | "availability:manage"
  | "availability:manageOthers"
  | "calls:make"
  | "calls:receive"
  | "teamActivity:view"
  | "aiAssistant:manage"
  | "conversations:assignOthers";

export const ALL_CAPABILITIES: Capability[] = [
  "conversations:delete",
  "contacts:delete",
  "contacts:export",
  "contacts:import",
  "broadcasts:manage",
  "templates:manage",
  "audienceGroups:manage",
  "stages:manage",
  "contactFields:manage",
  "tags:manage",
  "messageFlags:manage",
  "inboxViews:manageShared",
  "snippets:manage",
  "availability:manage",
  "availability:manageOthers",
  "calls:make",
  "calls:receive",
  "teamActivity:view",
  "aiAssistant:manage",
  "conversations:assignOthers",
];

/** Roles whose capabilities an admin may edit. admin/superAdmin are fixed. */
export const EDITABLE_ROLES = ["manager", "agent"] as const;
export type EditableRole = (typeof EDITABLE_ROLES)[number];

/** Human labels for the settings grid. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "conversations:delete": "Delete conversations",
  "contacts:delete": "Delete contacts",
  "contacts:export": "Export the contact book (CSV / Excel)",
  "contacts:import": "Import contacts from a CSV / Excel file",
  "broadcasts:manage": "Create & manage broadcasts",
  "templates:manage": "Create & manage templates",
  "audienceGroups:manage": "Manage audience groups",
  "stages:manage": "Manage lifecycle stages",
  "contactFields:manage": "Manage contact fields",
  "tags:manage": "Create & manage tags",
  "messageFlags:manage": "Create & manage message flags",
  "inboxViews:manageShared":
    "Create & manage shared inbox views (everyone can always save their own)",
  "snippets:manage": "Create & manage snippets",
  "availability:manage": "Set own availability (busy / away / offline)",
  "availability:manageOthers": "Set teammates' availability & working hours",
  "calls:make": "Place outbound voice calls",
  "calls:receive": "Answer incoming voice calls",
  "teamActivity:view": "View team activity report",
  "aiAssistant:manage": "Configure the AI Assistant (company profile, knowledge, voice)",
  "conversations:assignOthers":
    "Assign conversations to other teammates (everyone can always claim one themselves)",
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
  admin: allCapabilities(true),
  manager: allCapabilities(true),
  agent: {
    "conversations:delete": true,
    "contacts:delete": true,
    // Export was UNGATED before this capability existed (any agent could pull
    // the full contact CSV), so default `true` preserves today's behavior. An
    // admin can flip it off to stop low-trust agents exfiltrating the book.
    "contacts:export": true,
    // Import was likewise UNGATED before this capability existed, so `true`
    // preserves today's behavior for every existing team. Mirrors
    // contacts:export deliberately — an admin locking down bulk contact
    // movement almost always wants both directions closed together.
    "contacts:import": true,
    "broadcasts:manage": true,
    "templates:manage": true,
    "audienceGroups:manage": true,
    "stages:manage": false,
    "contactFields:manage": false,
    // tags + snippets were UNGATED before this capability existed (any agent
    // could create/edit/delete them), so default `true` to preserve today's
    // behavior exactly. An admin can flip them off in settings to lock down
    // team-wide tag/snippet management — the whole point of adding the gate.
    "tags:manage": true,
    // The message-flag CATALOG (which flags exist) is a team-wide setting, so
    // it follows tags:manage. Note this gates only the catalog — RAISING and
    // RESOLVING a flag is triage every agent must be able to do and is
    // deliberately ungated, like sending a message or leaving a note.
    "messageFlags:manage": true,
    // SHARED inbox views only. Saving a PERSONAL view is never gated — it is
    // the agent organising their own work, like a bookmark. This flag is
    // `false` for agents (unlike tags/flags) because it is a NEW surface with
    // no pre-existing ungated behaviour to preserve, and a shared view appears
    // in every teammate's sidebar: the conservative default is the one an
    // admin can loosen, not one they discover after the rail fills up.
    "inboxViews:manageShared": false,
    "snippets:manage": true,
    // Agents can manage THEIR OWN availability by default. An admin can flip
    // this off for teams that want fixed online presence (e.g. a call center
    // where agents shouldn't self-mark "away" mid-shift).
    "availability:manage": true,
    // Setting SOMEONE ELSE's status or editing their working hours is a
    // supervisor action — off for agents by default (admin/manager get it).
    // An admin can grant it to agents for a small team where everyone covers
    // for everyone.
    "availability:manageOthers": false,
    // Calls: default true for all roles. A team that wants to scope outbound
    // calling to managers only can flip "calls:make" off via the settings
    // grid — same admin-configurable pattern as every other capability.
    "calls:make": true,
    "calls:receive": true,
    // Team activity report is team-performance data — off for agents by
    // default (admin/manager get it); an admin can grant it per role in
    // Settings → Role permissions.
    "teamActivity:view": false,
    // Handing a conversation to SOMEONE ELSE is a supervisor action — an agent
    // can always claim a conversation for themselves, and can always unassign
    // themselves off one, but routing work onto a teammate's plate is off by
    // default. Admin/manager get it. An admin can grant it to agents for a
    // small team where everyone triages for everyone.
    "conversations:assignOthers": false,
    // Configuring the AI Assistant (company profile, knowledge base, voice,
    // auto-reply behavior) is an admin/manager setting — off for agents by
    // default. Agents still OPERATE the assistant in the inbox (pause/resume,
    // send/edit a suggestion, take over) without this capability.
    "aiAssistant:manage": false,
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
  // A platform superAdmin and an org owner/admin both arrive here as "admin"
  // (resolveSession collapses them), so this single arm covers all three.
  if (role === "admin") {
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
