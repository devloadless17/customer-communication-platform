/**
 * The visibility-flip revocation, at the cache layer.
 *
 * Flipping `Workspace.agentConversationVisibility` force-disconnects every
 * socket in the workspace — but the re-handshake reads the session-cache fast
 * paths (`sessionCacheGetByCookie` / `sessionCacheGet`). Before the fix,
 * nothing busted those caches for the workspace, so the reconnected socket
 * re-derived its PRE-flip visibility and rejoined the `ws:` firehose for the
 * socket's whole lifetime. `invalidateWorkspaceSessionCache` is the bust; the
 * gateway's visibility invalidator calls it FIRST, before the disconnect.
 *
 * These tests pin the bust itself: both caches, exactly one workspace, and
 * the cookie fast path dying with the snapshot.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  invalidateSessionCache,
  invalidateWorkspaceSessionCache,
  sessionCacheGet,
  sessionCacheGetByCookie,
  sessionCacheSet,
  sessionCacheSetByCookie,
  type ApiSession,
} from "../src/auth/session.guard";

function makeSession(userId: string, workspaceId: string): ApiSession {
  return {
    sessionId: `sess_${userId}_${workspaceId}`,
    userId,
    organizationId: "org_1",
    orgRole: "member",
    isSuperAdmin: false,
    workspaceId,
    role: "agent",
    workspaceMemberships: [{ workspaceId, name: "WS", role: "agent" }],
    name: "Agent",
    email: `${userId}@test.local`,
    avatarUrl: null,
    orgStatus: "active",
    emailVerified: true,
    rolePermissions: null,
    agentConversationVisibility: "team",
  };
}

const WS_A = "ws_flip_a";
const WS_B = "ws_flip_b";

describe("invalidateWorkspaceSessionCache", () => {
  beforeEach(() => {
    // The caches are module-level; scrub our users so a prior test's entries
    // can't satisfy an assertion.
    for (const uid of ["u1", "u2", "u3"]) invalidateSessionCache(uid);
  });

  it("drops every snapshot for the workspace and no other", () => {
    sessionCacheSet(makeSession("u1", WS_A));
    sessionCacheSet(makeSession("u2", WS_A));
    // Same USER also active in another workspace — that snapshot must survive.
    sessionCacheSet(makeSession("u1", WS_B));

    invalidateWorkspaceSessionCache(WS_A);

    expect(sessionCacheGet("u1", WS_A)).toBeNull();
    expect(sessionCacheGet("u2", WS_A)).toBeNull();
    expect(sessionCacheGet("u1", WS_B)).not.toBeNull();
  });

  it("kills the cookie fast path for the workspace — the socket re-handshake reads this", () => {
    const cookieA = "ccp.session=aaa; ccp.ws=ws_flip_a";
    const cookieB = "ccp.session=bbb; ccp.ws=ws_flip_b";
    sessionCacheSet(makeSession("u1", WS_A));
    sessionCacheSet(makeSession("u2", WS_B));
    sessionCacheSetByCookie(cookieA, "u1", "sess_a", WS_A);
    sessionCacheSetByCookie(cookieB, "u2", "sess_b", WS_B);
    expect(sessionCacheGetByCookie(cookieA)).not.toBeNull();

    invalidateWorkspaceSessionCache(WS_A);

    // The flipped workspace's cookie entry is gone — a handshake now takes
    // the slow path and reads the post-flip setting from the database.
    expect(sessionCacheGetByCookie(cookieA)).toBeNull();
    // The sibling workspace is untouched.
    expect(sessionCacheGetByCookie(cookieB)).not.toBeNull();
  });

  it("is idempotent and safe on a workspace with no entries", () => {
    expect(() => invalidateWorkspaceSessionCache("ws_never_seen")).not.toThrow();
    invalidateWorkspaceSessionCache(WS_A);
    expect(() => invalidateWorkspaceSessionCache(WS_A)).not.toThrow();
  });
});
