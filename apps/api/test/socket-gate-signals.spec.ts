import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * "Your credentials are dead" and "your session is fine but the app is gating
 * you" must reach the browser as DIFFERENT signals.
 *
 * The client reacts to them in opposite ways, and conflating them was a real
 * bug:
 *
 *   unauthenticated  → navigate to /logout, which DELETES the session.
 *   session_gated    → stop the socket, reload, let the server-rendered gate
 *                      route to /pending (org suspended / pending review) or
 *                      /verify (email unverified).
 *
 * The socket used to answer `unauthenticated` for a suspended org. So the
 * moment a platform operator suspended an organization, every member's socket
 * was kicked, the client walked to /logout, and their perfectly valid session
 * was destroyed — landing them on a context-free /login instead of the screen
 * that says WHY they're locked out and shows the operator's reason. The API's
 * suspend handler deliberately does NOT delete Better Auth sessions for exactly
 * this reason (see admin-organizations.controller); the socket was undoing that
 * from the other side.
 *
 * These strings are a WIRE CONTRACT: Socket.io serializes `Error.message` into
 * the browser's `connect_error`, and the client matches on the exact text. They
 * are asserted here as source-level invariants rather than through a live
 * handshake because the failure mode is a silent rename on one side only — the
 * thing an integration test of the happy path would never notice.
 *
 *   pnpm --filter @ccp/api exec vitest run test/socket-gate-signals.spec.ts
 */

const read = (rel: string): string => {
  for (const base of ["", "../../"]) {
    const p = `${base}${rel}`;
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`could not locate ${rel}`);
};

const gateway = read("apps/api/src/realtime/realtime.gateway.ts");
const socketAuth = read("apps/api/src/realtime/socket-auth.service.ts");
const client = read("apps/web/src/lib/socket-client.ts");

describe("the server's side of the contract", () => {
  it("has a distinct result kind for a valid-but-gated session", () => {
    expect(socketAuth).toContain('kind: "gated"');
  });

  it("uses it for BOTH gates — org status and email verification", () => {
    // Both are "valid session, app is gating you". Neither may fall through to
    // `unauthenticated`, or the user loses their session to a /logout.
    const gatedReturns = socketAuth.match(/kind: "gated"/g) ?? [];
    // 4 gate sites (cookie-cache org + email, snapshot org + email, slow-path
    // org + email) — at minimum both gates on every path plus the type decl.
    expect(gatedReturns.length).toBeGreaterThanOrEqual(6);
  });

  it("still answers `unauthenticated` when there is genuinely no session", () => {
    // The fix must not soften the real thing: no cookie, or Better Auth
    // returning no user, is still a dead session and still ends in /logout.
    expect(socketAuth).toContain('return { kind: "unauthenticated" }');
  });

  it("translates the gated kind into its own wire string", () => {
    expect(gateway).toContain('result.kind === "gated"');
    expect(gateway).toContain('new Error("session_gated")');
  });
});

describe("the client's side of the contract", () => {
  it("logs out ONLY on `unauthenticated`", () => {
    const logoutBlock = client.slice(
      client.indexOf('err.message === "unauthenticated"'),
      client.indexOf('err.message === "session_gated"'),
    );
    expect(logoutBlock).toContain("/logout");
  });

  it("handles `session_gated` WITHOUT navigating to /logout", () => {
    const idx = client.indexOf('err.message === "session_gated"');
    expect(idx, "client must handle the gated signal").toBeGreaterThan(-1);
    // The gated branch runs until the next connect_error branch.
    const gatedBlock = client.slice(idx, idx + 700);
    expect(gatedBlock).not.toContain("/logout");
    // …and it must stop the socket rather than retry forever against a gate
    // that only a human (approving the org, or verifying the email) can lift.
    expect(gatedBlock).toContain("disconnect");
  });

  it("keeps reconnecting on the transient classes", () => {
    // Unchanged: a degraded auth backend or a throttled handshake is "retry",
    // never "log out" and never "reload".
    expect(client).toContain('err.message === "auth_unavailable"');
    expect(client).toContain('err.message === "handshake_throttled"');
  });
});
