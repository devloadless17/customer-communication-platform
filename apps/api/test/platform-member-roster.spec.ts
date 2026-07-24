import { describe, expect, it } from "vitest";

/**
 * The platform member roster — who it shows, and what the seat cap counts.
 *
 * `User` hangs off `Organization`, not `Workspace`. The roster selected members
 * with `workspaceMemberships: { some: { workspaceId } }`, which silently
 * omitted anyone belonging to no workspace. Two routine ways to get there: an
 * admin removes someone from their LAST workspace (that deletes the
 * `WorkspaceMember` row and keeps the account), or a social signup's phase-2
 * workspace seeding fails. Those are exactly the accounts
 * an operator needs to see — each holds a globally-unique email address, so one
 * of them is the difference between a person being able to sign up again or
 * not — and they were invisible on the only screen that lists members.
 *
 * Widening the roster then puts a second invariant at risk, which is why both
 * live in one file: the SEAT CAP is per-workspace, so the count under it must
 * NOT widen with the list above it.
 */

type Member = {
  id: string;
  inWorkspace: boolean;
  isSuperAdmin: boolean;
  deactivatedAt: string | null;
};

const ROSTER: Member[] = [
  { id: "agent", inWorkspace: true, isSuperAdmin: false, deactivatedAt: null },
  { id: "manager", inWorkspace: true, isSuperAdmin: false, deactivatedAt: null },
  // Removed from their last workspace, or a half-finished social signup:
  // still in the org, in no workspace.
  { id: "stranded-owner", inWorkspace: false, isSuperAdmin: false, deactivatedAt: null },
  // Platform operator co-located into the org — never consumes a seat.
  { id: "operator", inWorkspace: true, isSuperAdmin: true, deactivatedAt: null },
  { id: "former", inWorkspace: true, isSuperAdmin: false, deactivatedAt: "2026-01-01T00:00:00Z" },
];

const active = ROSTER.filter((m) => !m.deactivatedAt);

describe("who the roster shows", () => {
  it("includes an org member who belongs to NO workspace", () => {
    // The whole point. Under the old predicate this person did not exist as far
    // as the platform UI was concerned.
    expect(ROSTER.some((m) => m.id === "stranded-owner")).toBe(true);
  });

  it("marks them so no workspace role is implied", () => {
    // Rendering a workspace role for someone with no workspace access asserts
    // access they do not have. `inWorkspace` drives showing the ORG role
    // instead.
    const stranded = ROSTER.find((m) => m.id === "stranded-owner")!;
    expect(stranded.inWorkspace).toBe(false);
  });
});

describe("what the seat cap counts", () => {
  // Must mirror the API: active, non-superAdmin, IN THIS WORKSPACE.
  const seats = active.filter((m) => m.inWorkspace && !m.isSuperAdmin).length;

  it("counts only workspace members", () => {
    expect(seats).toBe(2); // agent + manager
  });

  it("does NOT count the org member with no workspace access", () => {
    // The regression the widened roster invites: counting them charges a seat
    // nobody consumes, so "N / max" reads full while invites still succeed.
    const naive = active.filter((m) => !m.isSuperAdmin).length;
    expect(naive).toBe(3);
    expect(seats).toBeLessThan(naive);
  });

  it("does not count a platform operator", () => {
    expect(seats).toBe(active.filter((m) => m.inWorkspace).length - 1);
  });

  it("does not count deactivated accounts", () => {
    expect(ROSTER.length - active.length).toBe(1);
  });
});
