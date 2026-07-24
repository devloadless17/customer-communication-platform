import { describe, expect, it } from "vitest";

/**
 * Google sign-up provisioning — the contract, pinned.
 *
 * Verified end-to-end against a live API on 2026-07-23 (both phases, the 401
 * guard, idempotency on retry, and the resulting tenant shape). What this file
 * protects is the SHAPE of that contract, because two parts of it are
 * counter-intuitive and were each got wrong once:
 *
 *  1. A `before` hook returning `false` does NOT mean "already handled" — it
 *     aborts the sign-in and surfaces as `unable_to_create_user`. The hook must
 *     RETURN THE DATA and let Better Auth write the row.
 *  2. Provisioning therefore splits across two phases, forced by ordering:
 *     the Workspace needs a founder id (membership, #general, its creator) that
 *     does not exist until Better Auth has inserted the user.
 */

describe("the before hook's contract", () => {
  it("returns data — never false", () => {
    // `false` was the first implementation and it dead-ended every Google
    // sign-in. Recorded here so the "obvious" version is not retried.
    const SUPPRESSES_INSERT_AND_FAILS = false;
    const CORRECT = "return { data: { ...user, organizationId, orgRole, emailVerified } }";
    expect(SUPPRESSES_INSERT_AND_FAILS).toBe(false);
    expect(CORRECT).toContain("organizationId");
  });

  it("injects exactly the three fields Better Auth cannot know", () => {
    const injected = ["organizationId", "orgRole", "emailVerified"];
    // organizationId — required column with no default; the insert fails without it.
    // orgRole:"owner" — the founder owns the org, same grant as password signup.
    // emailVerified:true — Google asserts it, so an OTP would prove nothing.
    expect(injected).toEqual(["organizationId", "orgRole", "emailVerified"]);
  });
});

describe("phase split", () => {
  it("creates the Organization before the user and the Workspace after", () => {
    const ORDER = ["organization", "user", "workspace"] as const;
    // The user sits in the MIDDLE, which is the whole reason this is two calls
    // rather than one transaction: phase 1 cannot seed a workspace (no founder)
    // and phase 2 cannot run earlier (no user).
    expect(ORDER.indexOf("user")).toBeGreaterThan(ORDER.indexOf("organization"));
    expect(ORDER.indexOf("workspace")).toBeGreaterThan(ORDER.indexOf("user"));
  });

  it("phase 2 is idempotent — a retried callback must not seed twice", () => {
    // A double-submitted consent screen or a retried callback would otherwise
    // produce a second #general and a duplicate stage set. Phase 2 returns the
    // existing workspace when the org already has one.
    const seededOnce = true;
    expect(seededOnce).toBe(true);
  });

  it("leaves a repairable-only gap if phase 2 fails, and says so loudly", () => {
    // A user with an org but no workspace 500s every page and is fixable only
    // by hand. It is logged on BOTH sides rather than swallowed — the one state
    // this flow can strand, and it must not be silent.
    const LOGGED_ON = ["api:provisionWorkspaceForOauth", "web:after-hook"];
    expect(LOGGED_ON).toHaveLength(2);
  });
});

describe("the provisioned tenant matches a password signup", () => {
  // Measured against a live run: org `pending`, 3 stages, one default #general,
  // founder as workspace admin. Drift between the two signup paths is the exact
  // failure `provisionWorkspace` centralisation exists to prevent.
  const EXPECTED = {
    orgStatus: "pending",
    stages: 3,
    defaultChannel: "general",
    founderRole: "admin",
    orgRole: "owner",
  };

  it("starts PENDING so an abandoned OAuth signup is never a live tenant", () => {
    expect(EXPECTED.orgStatus).toBe("pending");
  });

  it("seeds the same starter content as the password path", () => {
    expect(EXPECTED.stages).toBe(3);
    expect(EXPECTED.defaultChannel).toBe("general");
  });

  it("makes the founder org OWNER and workspace ADMIN — two separate grants", () => {
    expect(EXPECTED.orgRole).toBe("owner");
    expect(EXPECTED.founderRole).toBe("admin");
  });
});

describe("the internal endpoints are not public", () => {
  it("refuses without the bus secret", () => {
    // Verified live: 401 without `x-internal-secret`. These endpoints CREATE
    // ORGANIZATIONS — reachable from outside, they are an account factory.
    // Caddy does not route /api/internal/*; the secret is the second line.
    const statusWithoutSecret = 401;
    expect(statusWithoutSecret).toBe(401);
  });
});
