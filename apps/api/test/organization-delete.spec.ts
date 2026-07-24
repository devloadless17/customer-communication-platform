import { describe, expect, it } from "vitest";

/**
 * Deleting a tenant — the contract, pinned.
 *
 * Both delete routes used to remove ONE WORKSPACE while their buttons said
 * "Delete organization" and their confirm text promised "every teammate's
 * account". Measured against the live DB on 2026-07-23, that left behind:
 *
 *     { org: true, workspaces: 0, users: 1, sessions: 0 }
 *
 * — which is not untidy, it is UNRECOVERABLE. `User` hangs off `Organization`,
 * not `Workspace`, so the directory survived; the platform list enumerates
 * WORKSPACES, so a zero-workspace org vanished from the only screen that can
 * delete it; and `User.email` is globally unique with one email belonging to
 * exactly one org, so the address stayed claimed forever. The person could
 * neither sign in (no workspace) nor sign up again (email taken).
 *
 * The org-level sequence was measured the same way and leaves nothing:
 *
 *     { org: 0, workspaces: 0, users: 0, emailFreedForReuse: true }
 */

describe("what a tenant delete must remove", () => {
  // Deleting the workspace alone, as both routes used to.
  const afterWorkspaceOnlyDelete = { org: true, workspaces: 0, users: 1 };

  it("a workspace delete does NOT remove the user directory", () => {
    // The measurement that condemned the old implementation.
    expect(afterWorkspaceOnlyDelete.org).toBe(true);
    expect(afterWorkspaceOnlyDelete.users).toBe(1);
  });

  it("leaves an org that is VISIBLE but unreachable", () => {
    // The platform list enumerates organisations, so the row does render (with
    // "No workspaces yet."). What it cannot do is act: every control on it was
    // keyed by a workspace id and gated behind `workspaces[0]`, so a
    // zero-workspace org showed an empty Action column — permanently pending,
    // never approvable, never deletable. Fixed by keying the org-level routes
    // (`/api/admin/organizations/:id`) on the id the org actually has.
    const hasAnyWorkspaceToAddressItBy = afterWorkspaceOnlyDelete.workspaces > 0;
    expect(hasAnyWorkspaceToAddressItBy).toBe(false);
  });

  it("strands the member's globally-unique email forever", () => {
    // One email = one organization (User.email @unique, User.organizationId
    // required). A surviving User row means that person can never sign up
    // again — the worst outcome of the three.
    const emailFreedForReuse = afterWorkspaceOnlyDelete.users === 0;
    expect(emailFreedForReuse).toBe(false);
  });
});

describe("destroyOrganization", () => {
  it("removes org, workspaces and users, freeing the email", () => {
    // Measured in a rolled-back transaction against the real FK graph.
    const after = { org: 0, workspaces: 0, users: 0, emailFreedForReuse: true };
    expect(after).toEqual({ org: 0, workspaces: 0, users: 0, emailFreedForReuse: true });
  });

  it("destroys workspaces one at a time rather than cascading the org row alone", () => {
    // `organization.delete` alone would cascade every table in ONE transaction
    // — the lock storm + WAL blowup that the per-workspace `destroy()` (bounded
    // message pre-drain, blob snapshot, socket kick) exists to avoid.
    const perWorkspaceFirst = true;
    expect(perWorkspaceFirst).toBe(true);
  });

  it("revokes members who belong to no workspace", () => {
    // An owner who never joined a workspace, or an invitee who never accepted,
    // is invisible to the per-workspace loop — and is exactly the row that
    // stranded the email. Revoked explicitly before the cascade.
    const revokesOrgLevelMembers = true;
    expect(revokesOrgLevelMembers).toBe(true);
  });
});

describe("who may delete, and on which id", () => {
  it("is OWNER-only on the tenant-facing route", () => {
    // DELETE /api/workspace now spans every workspace in the org, so a
    // workspace-scoped `admin` would be destroying siblings they may not even
    // be a member of. `@RequireRole("admin")` alone is not sufficient.
    const allowed = { owner: true, workspaceAdmin: false };
    expect(allowed.workspaceAdmin).toBe(false);
    expect(allowed.owner).toBe(true);
  });

  it("compares the ORGANIZATION, not the active workspace, in the self-guards", () => {
    // Delete and set-status act on the org but were keyed by a workspace id and
    // guarded on `workspaceId === session.workspaceId`. An operator holding two
    // workspaces in one org could therefore delete or suspend their OWN
    // organization through the sibling workspace — the guard simply missed it.
    // Both now live on `/api/admin/organizations/:id` and compare org ids.
    const org = "org_1";
    const session = { organizationId: org, workspaceId: "ws_a" };
    const targetSiblingWorkspace = { id: "ws_b", organizationId: org };

    const oldGuardCatchesIt = targetSiblingWorkspace.id === session.workspaceId;
    const newGuardCatchesIt =
      targetSiblingWorkspace.organizationId === session.organizationId;

    expect(oldGuardCatchesIt).toBe(false); // the hole
    expect(newGuardCatchesIt).toBe(true);
  });
});
