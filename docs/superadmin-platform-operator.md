# Super admin should be a platform operator, not a tenant

**Status:** specified, not built. Belongs in the workspaces/organization restructure —
it touches the same `User` / session model, so doing it separately means doing it twice.

## The problem

A super admin logs in to manage *other people's* organizations. Today they are
also forced to **be** one: the platform organizations list shows the operator's
own org next to real customers, and `getPlatformAnalytics` counts it in the
totals — so your own account inflates "organizations" and "new this period".

On the pilot database that org (`Loadless Support`) has **0 conversations and
0 contacts**. It is not a tenant anyone is using; it exists purely to satisfy a
schema constraint.

## Why it exists

Two things force it, and only two:

1. **`User.organizationId` is non-nullable** (`prisma/schema.prisma`, model `User`).
   Every user must belong to an organization, so `prisma/seeds/seed-superadmin.ts`
   manufactures one and calls it, in its own comment, *"the operator's anchor
   data scope"*.

2. **The session refuses a user with no workspace** —
   `apps/api/src/auth/session.guard.ts`:

   ```ts
   if (!activeWorkspaceId) return null; // no workspace to act in
   ```

   That line is *correct* for tenant users (it exists so the guard can never
   silently pick someone else's workspace), but it means a workspace-less
   operator cannot authenticate at all.

## Why the rest is already fine

Most of the work is done — this is not a big feature, it is unblocking one FK:

- **Platform routes gate on the `isSuperAdmin` FLAG, not on a role or a
  workspace** (`apps/api/src/auth/role.guard.ts`), so `/platform/*` never needed
  a tenant scope.
- `isSuperAdmin` already bypasses the org-approval gate (`session.guard.ts`).
- `/pending` already redirects super admins to `/platform`.

## The change

1. **Schema** — `User.organizationId String?` (+ `organization` relation optional),
   with a migration doing `ALTER TABLE "User" ALTER COLUMN "organizationId" DROP NOT NULL;`.
   Additive and reversible; existing rows are unaffected.

2. **Session guard** — admit an operator with no workspace:

   ```ts
   if (!activeWorkspaceId && !user.isSuperAdmin) return null;
   ```

3. **`ApiSession.workspaceId: string | null`.** This is the real cost: ~320 call
   sites read it, and TypeScript will flag every one. That is a *feature* — each
   site has to answer "what does this mean with no workspace?" The answer is the
   same nearly everywhere: tenant routes reject with 400/403 when it is null, so
   no `where: { workspaceId }` ever runs unscoped. Consider a small helper —
   `requireWorkspace(session)` — so the 320 sites become a one-line call rather
   than 320 bespoke null checks.

4. **Seed** (`prisma/seeds/seed-superadmin.ts`) — create the super admin with no
   organization and no workspace. Drop the anchor org entirely.

5. **Platform list + analytics** — nothing to exclude once the anchor no longer
   exists. If any operator still legitimately owns a workspace (dogfooding), add
   `Organization.isInternal` and filter on that rather than special-casing ids.

## Product rule this encodes

> A super admin sees and controls every organization. They do not have one by
> default. If they want to *use* the product, they create an organization like
> any other customer.

## Verification

- A super admin with `organizationId = null` can log in and reach `/platform`.
- The same account gets a clean 4xx (never an unscoped query) on any `/api/*`
  tenant route.
- The organizations list and `getPlatformAnalytics` show only real customers.
- A normal signup is unaffected: org created, `/pending` until approved.

## Watch out for

Prisma `select` / `include` / `_count` keys are **not typechecked** — the XOR
unions defeat excess-property checking, so a wrong field name compiles clean and
fails only when a request runs it. Two bugs of exactly this shape were found
during the restructure (`Workspace._count.users` → `members`, and
`Workspace.statusReason` → `organization.statusReason`). After changing the
model, grep the query blocks; do not trust a green `tsc`.
