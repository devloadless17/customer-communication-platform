import { describe, expect, it } from "vitest";

import {
  canManageOrgDirectory,
  canModifyUser,
  canModifyUserAccount,
  type UserActor,
} from "@ccp/shared/auth/permissions";

/**
 * Two authorities, deliberately kept apart.
 *
 * `canModifyUser` is the WORKSPACE one: change someone's role in this inbox.
 * `canModifyUserAccount` is the ORG one: deactivate the account, delete it,
 * reset its password — each of which reaches every workspace the person belongs
 * to and, in the delete case, ends their existence in the organization.
 *
 * They were the same check. `resolveSession` collapses a platform superAdmin, an
 * org owner/admin AND a plain org member holding `WorkspaceMember.role="admin"`
 * in ONE workspace all down to the effective workspace role "admin" — so a
 * workspace-role check could not tell the third case from the first two, and a
 * single-workspace admin could hard-delete the org owner.
 */

const OWNER: UserActor = { role: "admin", isSuperAdmin: false, orgRole: "owner" };
const ORG_ADMIN: UserActor = { role: "admin", isSuperAdmin: false, orgRole: "admin" };
/** The dangerous one: admin of ONE workspace, an ordinary member of the org. */
const WORKSPACE_ADMIN: UserActor = { role: "admin", isSuperAdmin: false, orgRole: "member" };
const MANAGER: UserActor = { role: "manager", isSuperAdmin: false, orgRole: "member" };
const OPERATOR: UserActor = { role: "admin", isSuperAdmin: true, orgRole: "member" };

const TARGET_OWNER: UserActor = { role: "admin", isSuperAdmin: false, orgRole: "owner" };
const TARGET_MEMBER: UserActor = { role: "agent", isSuperAdmin: false, orgRole: "member" };
const TARGET_OPERATOR: UserActor = { role: "admin", isSuperAdmin: true, orgRole: "member" };

describe("who administers the organization directory", () => {
  it("owners, org admins and platform operators — nobody else", () => {
    expect(canManageOrgDirectory(OWNER)).toBe(true);
    expect(canManageOrgDirectory(ORG_ADMIN)).toBe(true);
    expect(canManageOrgDirectory(OPERATOR)).toBe(true);
    expect(canManageOrgDirectory(WORKSPACE_ADMIN)).toBe(false);
    expect(canManageOrgDirectory(MANAGER)).toBe(false);
  });

  it("treats a MISSING orgRole as no authority", () => {
    // Fail closed. A call site that forgets to pass `orgRole` must not be handed
    // the power the field exists to gate — the UI's inline role picker
    // legitimately omits it.
    expect(canManageOrgDirectory({ role: "admin", isSuperAdmin: false })).toBe(false);
  });
});

describe("account-level actions (deactivate / delete / reset password)", () => {
  it("a workspace admin who is only an org MEMBER cannot touch the org owner", () => {
    // The headline regression: deleting a user removes them from every
    // workspace in the org, so administering one inbox is not the authority to
    // do it — least of all to the person who owns the account.
    expect(canModifyUserAccount(WORKSPACE_ADMIN, TARGET_OWNER)).toBe(false);
  });

  it("...nor any other member of the organization", () => {
    expect(canModifyUserAccount(WORKSPACE_ADMIN, TARGET_MEMBER)).toBe(false);
  });

  it("but keeps their WORKSPACE authority intact", () => {
    // The fix must not cost a workspace admin the ability to run their own
    // workspace — re-roling a member there is still theirs.
    expect(canModifyUser(WORKSPACE_ADMIN, TARGET_MEMBER)).toBe(true);
  });

  it("an org admin may act on ordinary members", () => {
    expect(canModifyUserAccount(ORG_ADMIN, TARGET_MEMBER)).toBe(true);
  });

  it("an org admin may NOT act on an owner — only another owner may", () => {
    // Otherwise an admin granted access by the owner could remove the owner,
    // which inverts the grant.
    expect(canModifyUserAccount(ORG_ADMIN, TARGET_OWNER)).toBe(false);
    expect(canModifyUserAccount(OWNER, TARGET_OWNER)).toBe(true);
  });

  it("nobody but a platform operator may act on a platform operator", () => {
    expect(canModifyUserAccount(OWNER, TARGET_OPERATOR)).toBe(false);
    expect(canModifyUserAccount(ORG_ADMIN, TARGET_OPERATOR)).toBe(false);
    expect(canModifyUserAccount(OPERATOR, TARGET_OPERATOR)).toBe(true);
  });

  it("a platform operator may act on anyone", () => {
    expect(canModifyUserAccount(OPERATOR, TARGET_OWNER)).toBe(true);
    expect(canModifyUserAccount(OPERATOR, TARGET_MEMBER)).toBe(true);
  });

  it("a manager never can, in either direction", () => {
    expect(canModifyUserAccount(MANAGER, TARGET_MEMBER)).toBe(false);
    expect(canModifyUser(MANAGER, TARGET_MEMBER)).toBe(false);
  });
});
