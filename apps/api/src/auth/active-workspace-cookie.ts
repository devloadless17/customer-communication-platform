import type { Response } from "express";

import { ACTIVE_WORKSPACE_COOKIE } from "./session.guard";

/**
 * Write the `ccp.ws` cookie — the CANDIDATE active workspace for the next
 * request and, critically, for the Socket.io handshake (which only ever sees
 * cookies).
 *
 * ONE definition because there are now two doors into a workspace — the
 * switcher (`POST /api/workspaces/active`) and operator entry
 * (`POST /api/admin/operator-access`) — and a cookie written with different
 * attributes by each is a bug that only shows up on one of them: a mismatched
 * `path` or `sameSite` leaves the browser holding two `ccp.ws` cookies, and
 * which one wins is not something the server gets to decide.
 *
 * Attributes, and why:
 *   - `httpOnly` — nothing client-side reads it; `GET /api/workspaces` echoes
 *     the active id back for the UI.
 *   - `sameSite: "lax"` — matches the Better Auth session cookie; see the CSRF
 *     posture in the security docs. A cookie that didn't match would be dropped
 *     on exactly the cross-site navigations the session cookie survives.
 *   - `secure` in production only, so local http dev still works.
 *
 * SECURITY: this is client input on the way back in. It can only ever SELECT
 * among workspaces `resolveActiveWorkspaceId` will independently verify — it
 * never widens access, which is why writing it here needs no authority beyond
 * whatever the calling route already required.
 */
export function setActiveWorkspaceCookie(res: Response, workspaceId: string): void {
  res.cookie(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 90 * 24 * 60 * 60 * 1000,
  });
}
