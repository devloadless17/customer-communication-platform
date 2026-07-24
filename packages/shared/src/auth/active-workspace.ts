/**
 * THE rule for "which workspace is this request acting in".
 *
 * There are four places that have to answer this question — the NestJS HTTP
 * guard (`resolveSession`), the Socket.io handshake (`SocketAuthService`), the
 * Next.js RSC session (`getSession`), and the switch endpoint — and they must
 * all answer it identically. When they didn't, a multi-workspace user got a
 * render whose chrome said workspace B while its permissions, effective role
 * and realtime filters still said workspace A. Same discipline as
 * `provisionOrganization` → `provisionWorkspace`: one definition, many callers.
 *
 * SECURITY. `cookieCandidate` is the `ccp.ws` cookie — CLIENT INPUT. It can
 * only ever SELECT among workspaces the user provably may act in; it can never
 * widen access. Membership is the fast path (no query). Anything BEYOND
 * membership (a platform superAdmin, or an org owner/admin who is implicitly
 * admin everywhere in THEIR OWN org) must be verified against the database by
 * the caller, org-scoped — hence `canAccessBeyondMembership` is injected rather
 * than inferred here. Trusting an unscoped "is org admin" boolean is exactly
 * the bug that let any org owner set `ccp.ws` to another tenant's workspace.
 */

export interface ActiveWorkspaceCandidateInput {
  /**
   * The user's explicit `WorkspaceMember` rows. MUST be ordered deterministically
   * (createdAt asc) — `memberships[0]` is the final fallback, and an unstable
   * order would make a cookie-less request land somewhere different each time.
   */
  memberships: readonly { workspaceId: string }[];
  /** Raw `ccp.ws` value, or null when the request carries none. */
  cookieCandidate: string | null;
  /**
   * `Session.activeWorkspaceId` — this DEVICE's durable choice, written by the
   * switch endpoint. Consulted when the cookie is missing (cleared, or a
   * server-side fetch that didn't forward it) so a switch survives a cookie wipe.
   */
  storedWorkspaceId: string | null;
  /**
   * DB-verified, org-scoped escape hatch for callers whose reach exceeds their
   * membership rows. Omit for a membership-only resolution.
   */
  canAccessBeyondMembership?: (workspaceId: string) => Promise<boolean>;
}

/**
 * Resolve the active workspace, or null when there is none to act in (which
 * every caller treats as "unauthenticated" rather than silently picking
 * someone else's workspace).
 *
 * Order: validated cookie → validated stored choice → first membership.
 */
export async function resolveActiveWorkspaceId(
  input: ActiveWorkspaceCandidateInput,
): Promise<string | null> {
  const memberWorkspaceIds = new Set(input.memberships.map((m) => m.workspaceId));

  const canAccess = async (workspaceId: string): Promise<boolean> => {
    if (memberWorkspaceIds.has(workspaceId)) return true;
    if (!input.canAccessBeyondMembership) return false;
    return input.canAccessBeyondMembership(workspaceId);
  };

  if (input.cookieCandidate && (await canAccess(input.cookieCandidate))) {
    return input.cookieCandidate;
  }
  if (input.storedWorkspaceId && (await canAccess(input.storedWorkspaceId))) {
    return input.storedWorkspaceId;
  }
  return input.memberships[0]?.workspaceId ?? null;
}

/**
 * Parse the `ccp.ws` cookie out of a raw `Cookie` header.
 *
 * Lives here, next to the rule that consumes it, so the API guard, the socket
 * handshake and anything else reading the header share one parser instead of
 * three subtly different `split(";")` loops.
 */
export const ACTIVE_WORKSPACE_COOKIE = "ccp.ws";

export function readActiveWorkspaceCookie(
  cookieHeader: string | undefined,
): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== ACTIVE_WORKSPACE_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value.length > 0 ? value : null;
  }
  return null;
}
