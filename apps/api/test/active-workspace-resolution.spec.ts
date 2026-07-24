import { describe, expect, it } from "vitest";

import {
  readActiveWorkspaceCookie,
  resolveActiveWorkspaceId,
} from "@ccp/shared/auth/active-workspace";

/**
 * How a request's ACTIVE workspace is chosen — the tenant-isolation scope that
 * every `where: { workspaceId }` in the product depends on.
 *
 * Two inputs feed it and NEITHER may be trusted on its own:
 *   · the `ccp.ws` cookie — plain client input;
 *   · `Session.activeWorkspaceId` — server-written, but a SNAPSHOT of a past
 *     decision that access changes can invalidate.
 *
 * Both are run through the access check on every resolve. The tempting shortcut
 * is "the server wrote `activeWorkspaceId`, so it's trustworthy" — it is not: an
 * admin can remove that person from the workspace afterwards, and skipping the
 * re-check would leave them acting inside a workspace they were just removed
 * from until their session happened to expire.
 *
 * These exercise the REAL `resolveActiveWorkspaceId`
 * (packages/shared/src/auth/active-workspace.ts) — the one function the NestJS
 * guard, the Socket.io handshake and the Next.js RSC session all call.
 *
 * This file used to re-implement the rule locally and assert against the copy.
 * That is worth spelling out, because the copy passed while the RSC session was
 * meanwhile resolving `workspaceMemberships[0]` and ignoring the cookie
 * entirely: a whole render tree scoped to the wrong workspace, invisible to a
 * green test. A test that mirrors the logic can only ever confirm the mirror.
 */

const ORG = "org_1";
const OTHER_ORG = "org_2";
const WORKSPACES = [
  { id: "ws_a", organizationId: ORG },
  { id: "ws_b", organizationId: ORG },
  { id: "ws_foreign", organizationId: OTHER_ORG },
];

type Viewer = { isSuperAdmin: boolean; isOrgAdmin: boolean; organizationId: string };

/**
 * The DB-backed escape hatch the guards inject: who may reach a workspace they
 * hold no membership row for. Mirrors the `canAccess` closure in
 * `resolveSession` / `SocketAuthService` — the org-scoped lookup those perform
 * against Postgres, done here against a fixture.
 */
function beyondMembership(user: Viewer) {
  return async (wsId: string): Promise<boolean> => {
    const ws = WORKSPACES.find((w) => w.id === wsId);
    if (!ws) return false;
    if (user.isSuperAdmin) return true;
    if (user.isOrgAdmin) return ws.organizationId === user.organizationId;
    return false;
  };
}

function resolve(
  user: Viewer,
  memberships: string[],
  cookieCandidate: string | null,
  storedWorkspaceId: string | null,
) {
  return resolveActiveWorkspaceId({
    memberships: memberships.map((workspaceId) => ({ workspaceId })),
    cookieCandidate,
    storedWorkspaceId,
    canAccessBeyondMembership: beyondMembership(user),
  });
}

const MEMBER: Viewer = { isSuperAdmin: false, isOrgAdmin: false, organizationId: ORG };
const ORG_ADMIN: Viewer = { isSuperAdmin: false, isOrgAdmin: true, organizationId: ORG };
const OPERATOR: Viewer = { isSuperAdmin: true, isOrgAdmin: false, organizationId: ORG };

describe("the ccp.ws cookie is client input", () => {
  it("cannot widen access to another org's workspace", async () => {
    // The attack: set the cookie by hand and act inside someone else's tenant.
    await expect(resolve(MEMBER, ["ws_a"], "ws_foreign", null)).resolves.toBe("ws_a");
  });

  it("cannot reach a sibling workspace the member never joined", async () => {
    // ws_b is in the SAME org, so an org check alone would let this through.
    // A plain member's boundary is MEMBERSHIP, not the organisation.
    await expect(resolve(MEMBER, ["ws_a"], "ws_b", null)).resolves.toBe("ws_a");
  });

  it("does select among workspaces the user genuinely belongs to", async () => {
    // It must still WORK — this is how the switcher persists a choice per device.
    await expect(resolve(MEMBER, ["ws_a", "ws_b"], "ws_b", null)).resolves.toBe("ws_b");
  });
});

describe("a stored activeWorkspaceId is re-validated, not trusted", () => {
  it("is ignored once the user is removed from that workspace", async () => {
    // The regression this guards: they switched to ws_b, an admin then removed
    // them from it. `Session.activeWorkspaceId` still says ws_b. Trusting it
    // because "the server wrote it" leaves them operating inside a workspace
    // they were just removed from.
    await expect(resolve(MEMBER, ["ws_a"], null, "ws_b")).resolves.toBe("ws_a");
  });

  it("is ignored when the workspace was deleted outright", async () => {
    await expect(resolve(MEMBER, ["ws_a"], null, "ws_deleted")).resolves.toBe("ws_a");
  });

  it("is honoured while access still holds", async () => {
    await expect(resolve(MEMBER, ["ws_a", "ws_b"], null, "ws_b")).resolves.toBe("ws_b");
  });

  it("is what a cookie-less request falls back to", async () => {
    // Server-side fetches and a post-cookie-wipe browser both arrive with no
    // `ccp.ws`. Without consulting the stored choice they'd silently drop to the
    // first membership — i.e. a switch that survives on one path and not the
    // other, which is how the socket ended up in a different `ws:` room than the
    // HTTP session it belonged to.
    await expect(resolve(MEMBER, ["ws_a", "ws_b"], null, "ws_b")).resolves.toBe("ws_b");
  });
});

describe("who may reach a workspace without a membership row", () => {
  it("an org owner/admin — but ONLY inside their own org", async () => {
    // The CRITICAL bug this encodes: `isOrgAdmin` was once checked UNSCOPED, so
    // any org owner could set `ccp.ws` to any workspace on the platform and act
    // as its admin. The org comparison is the whole control.
    await expect(resolve(ORG_ADMIN, [], "ws_b", null)).resolves.toBe("ws_b");
    await expect(resolve(ORG_ADMIN, [], "ws_foreign", null)).resolves.toBeNull();
  });

  it("a platform operator, anywhere — that is the job", async () => {
    await expect(resolve(OPERATOR, [], "ws_foreign", null)).resolves.toBe("ws_foreign");
  });

  it("nobody, when no escape hatch is supplied", async () => {
    // The RSC session deliberately omits `canAccessBeyondMembership`: it shapes
    // UI and must never let the browser widen its own tenant scope. Membership
    // only.
    await expect(
      resolveActiveWorkspaceId({
        memberships: [{ workspaceId: "ws_a" }],
        cookieCandidate: "ws_b",
        storedWorkspaceId: null,
      }),
    ).resolves.toBe("ws_a");
  });
});

describe("unresolvable means unauthenticated", () => {
  it("returns null rather than silently picking someone else's workspace", async () => {
    // A null here makes the guard treat the request as unauthenticated. The
    // dangerous alternative is defaulting to *some* workspace, which would
    // quietly place a user inside a tenant nobody granted them.
    await expect(resolve(MEMBER, [], "ws_foreign", "ws_b")).resolves.toBeNull();
  });
});

describe("reading the cookie out of a raw header", () => {
  it("finds the value among other cookies", () => {
    expect(
      readActiveWorkspaceCookie("better-auth.session_token=abc; ccp.ws=ws_b; theme=dark"),
    ).toBe("ws_b");
  });

  it("is absent rather than empty when unset", () => {
    expect(readActiveWorkspaceCookie("better-auth.session_token=abc")).toBeNull();
    expect(readActiveWorkspaceCookie("ccp.ws=")).toBeNull();
    expect(readActiveWorkspaceCookie(undefined)).toBeNull();
  });

  it("does not match a cookie that merely ends in the same name", () => {
    // `not-ccp.ws` must not be mistaken for `ccp.ws` — the parser trims and
    // compares the whole name, it doesn't `endsWith`.
    expect(readActiveWorkspaceCookie("not-ccp.ws=ws_foreign")).toBeNull();
  });
});
