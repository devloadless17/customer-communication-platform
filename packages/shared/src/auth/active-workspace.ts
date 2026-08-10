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
  /**
   * Last-resort candidates for a user with ZERO membership rows whose reach
   * still exceeds membership — an org owner who removed themselves from every
   * workspace, or a superAdmin. Each is still put through
   * `canAccessBeyondMembership`, so this can only SELECT among workspaces the
   * caller already proved; it never widens access.
   *
   * Without it, `memberships[0]` was the only fallback and such a user
   * resolved to null on any request without a valid `ccp.ws` cookie: HTTP
   * 401, and the RSC session redirects to /logout, which clears the cookie —
   * so the next login loops login → logout with no way back in short of DB
   * surgery when the locked-out user is the org's only owner.
   */
  beyondMembershipFallbacks?: readonly string[];
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
  const firstMembership = input.memberships[0]?.workspaceId;
  if (firstMembership) return firstMembership;
  // Zero memberships: fall back to a workspace this caller may reach beyond
  // membership (org owner / superAdmin). Each candidate is DB-verified by the
  // same injected rule the cookie goes through.
  for (const candidate of input.beyondMembershipFallbacks ?? []) {
    if (await canAccess(candidate)) return candidate;
  }
  return null;
}

/**
 * THE beyond-membership access rule, as a factory.
 *
 * Encodes who may act in a workspace they hold no `WorkspaceMember` row for:
 *   - a platform superAdmin → any workspace on the box (OPERATOR MODE — read
 *     the branch comment below before touching it);
 *   - an org owner/admin  → any workspace IN THEIR OWN org (DB-verified —
 *     trusting an unscoped "is org admin" boolean is exactly the bug that let
 *     any org owner set `ccp.ws` to another tenant's workspace);
 *   - anyone else → nothing beyond their membership rows.
 *
 * This rule used to be COPIED VERBATIM in three places (the HTTP guard, the
 * socket handshake and the switch endpoint) and semantically re-derived in a
 * fourth (the RSC session — which omitted it, producing the split-tenant
 * render this file's header warns about). One definition, DB injected so the
 * package stays framework-agnostic; per-candidate memoised because resolvers
 * legitimately probe the same id more than once per request.
 */
export interface BeyondMembershipInput {
  isSuperAdmin: boolean;
  /** `orgRole === "owner" || orgRole === "admin"` — computed by the caller. */
  isOrgAdmin: boolean;
  organizationId: string;
  memberWorkspaceIds: ReadonlySet<string>;
  /** `prisma.workspace.count({ where })`-shaped probe, injected. */
  countWorkspaces: (where: {
    id: string;
    organizationId?: string;
  }) => Promise<number>;
}

export function makeCanAccessBeyondMembership(
  input: BeyondMembershipInput,
): (workspaceId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  const uncached = async (wsId: string): Promise<boolean> => {
    if (input.memberWorkspaceIds.has(wsId)) return true;
    if (input.isSuperAdmin) {
      // OPERATOR MODE — platform-wide, and deliberately so. THE TWO BRANCHES
      // ARE SEPARATE AND MUST STAY SEPARATE; re-merging them is the bug.
      //
      // History: this used to be one branch, org-scoped for both, because a
      // superAdmin granted ANY workspace meant setting one cookie
      // (`ccp.ws=<any customer workspace>`) turned every workspace-scoped API
      // into that tenant's inbox — message bodies, contact names, phone
      // numbers — with nothing in front of it but a client-side redirect to
      // /platform. Two DIFFERENT problems were fixed together, and only one of
      // them was ever about the superAdmin:
      //
      //   - the ORG-ADMIN half (below) is the actual vulnerability: an ordinary
      //     customer's org owner reaching a SIBLING TENANT. It stays org-scoped
      //     and DB-verified, forever.
      //   - the SUPERADMIN half is the platform's owner reaching their own
      //     platform. That is not privilege escalation, it is the job: onboarding
      //     a client who cannot paste their own channel credentials, and watching
      //     a live workspace to confirm the system is healthy. Denying it forced
      //     the alternative of one mailbox and one invite per tenant.
      //
      // What makes it the "EXPLICIT, audited mode" the old comment asked for
      // rather than a silent side effect:
      //   - entry is an action, not an ambient capability — `POST /api/admin/
      //     operator-access` (superAdmin-gated) writes an append-only
      //     `OperatorAccess` row before it sets the cookie, and the platform
      //     org page renders that log;
      //   - the operator is never a `WorkspaceMember`, so they are absent from
      //     every people-surface (assignment pools, availability, seat counts,
      //     rosters) — present to administer, never counted as workforce;
      //   - passive viewing writes NOTHING a tenant could observe: no team
      //     unread cleared, no read receipt, no presence, no viewer pill, no
      //     typing (see `isOperatorAccess` below and its call sites).
      //
      // The honest limit, stated so nobody mistakes the log for a gate: a
      // superAdmin who hand-sets `ccp.ws` reaches a tenant without writing an
      // `OperatorAccess` row. The log records intent, it does not enforce it.
      // That is accepted because the only principal who can do it is the sole
      // platform operator the log exists to describe. If this ever becomes a
      // MULTI-operator platform, this branch must gate on an active grant row
      // instead of on the flag — the shape is already here, it just has to
      // consult `OperatorAccess` rather than `countWorkspaces`.
      return (await input.countWorkspaces({ id: wsId })) > 0;
    }
    if (input.isOrgAdmin) {
      // ORG-SCOPED, DB-VERIFIED, AND NOT NEGOTIABLE. Trusting an unscoped "is
      // org admin" boolean is exactly the bug that let any customer's org owner
      // set `ccp.ws` to another tenant's workspace. An org admin's reach ends
      // at their own organization; there is no operator mode here.
      return (
        (await input.countWorkspaces({
          id: wsId,
          organizationId: input.organizationId,
        })) > 0
      );
    }
    return false;
  };
  return (wsId: string): Promise<boolean> => {
    const hit = cache.get(wsId);
    if (hit) return hit;
    const p = uncached(wsId);
    cache.set(wsId, p);
    return p;
  };
}

/**
 * Is this session ACTING AS THE PLATFORM OPERATOR right now?
 *
 * True when a superAdmin is acting in a workspace they hold no
 * `WorkspaceMember` row for — i.e. they got here through the operator branch of
 * `makeCanAccessBeyondMembership` above. One definition, because four places
 * need the same answer: the HTTP session, the socket handshake, the RSC session
 * and the web chrome.
 *
 * Deliberately keyed on NON-MEMBERSHIP rather than on the `isSuperAdmin` flag.
 * In their own anchor workspace the operator IS a member and should behave like
 * any other admin — their presence dot, their viewer pill and their read state
 * are all real there. The flag says who they are; this says what they are doing.
 *
 * Every stealth gate reads this, and the direction of failure is always
 * "behave like a member": a missing gate leaks the operator's presence into a
 * tenant's UI, it never denies a tenant anything.
 */
export function isOperatorAccess(input: {
  isSuperAdmin: boolean;
  workspaceId: string;
  memberWorkspaceIds: ReadonlySet<string>;
}): boolean {
  return input.isSuperAdmin && !input.memberWorkspaceIds.has(input.workspaceId);
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
