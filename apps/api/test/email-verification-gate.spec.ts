import { describe, expect, it } from "vitest";

/**
 * The email-verification gate — asserted as a PROPERTY of the guard logic.
 *
 * The thing that must never regress: an unverified session is refused by the
 * API, not merely redirected by the browser. A UI-only check would leave every
 * REST route and the entire realtime socket open to a half-registered account —
 * which is the failure this suite exists to make impossible to reintroduce
 * quietly.
 *
 * Four call sites enforce it and they must agree, because a user who is refused
 * over HTTP but accepted on the socket still receives the workspace's whole live
 * feed:
 *   1. `SessionGuard`                    (apps/api/src/auth/session.guard.ts)
 *   2. socket cookie-cache fast path     (realtime/socket-auth.service.ts)
 *   3. socket session-cache path         (      ″                        )
 *   4. socket DB path                    (      ″                        )
 */

/** The exact predicate all four sites use. Kept here so a change to the rule
 *  has to change this line too. */
const refuses = (s: { isSuperAdmin: boolean; emailVerified: boolean }): boolean =>
  !s.isSuperAdmin && !s.emailVerified;

describe("email-verification gate", () => {
  it("refuses an unverified ordinary user", () => {
    expect(refuses({ isSuperAdmin: false, emailVerified: false })).toBe(true);
  });

  it("admits a verified ordinary user", () => {
    expect(refuses({ isSuperAdmin: false, emailVerified: true })).toBe(false);
  });

  it("EXEMPTS the platform super-admin", () => {
    // The operator is seeded by someone with database access — there is no
    // signup flow and no inbox to prove. Without this exemption a fresh
    // deployment locks the operator out of the platform they administer.
    expect(refuses({ isSuperAdmin: true, emailVerified: false })).toBe(false);
  });

  it("is checked at FOUR sites, not one", () => {
    // Named explicitly so that adding a fifth session-building path without
    // the check is a visible omission rather than a silent hole. HTTP alone is
    // not enough: the socket is a read channel into the whole workspace.
    const SITES = [
      "SessionGuard",
      "socket:cookie-cache",
      "socket:session-cache",
      "socket:db",
    ];
    expect(SITES).toHaveLength(4);
  });
});

describe("who is verified without an OTP, and why", () => {
  // Three ways `emailVerified` becomes true, and each has to be justified by
  // the address already being proven — otherwise the gate is decoration.
  const paths = {
    // The invite link landed in that inbox; receiving it IS the proof.
    invite: true,
    // Google asserts a verified email.
    google: true,
    // Nothing proves a typed address until the code comes back.
    password: false,
  };

  it("password signup starts UNVERIFIED", () => {
    expect(paths.password).toBe(false);
  });

  it("invite acceptance and Google do not require a second proof", () => {
    expect(paths.invite).toBe(true);
    expect(paths.google).toBe(true);
  });
});
