import type { PrismaClient } from "@prisma/client";

import type { Role } from "@ccp/shared/types";

/**
 * Agent conversation visibility — the read boundary.
 *
 * A team can restrict role `agent` to the conversations assigned to them
 * (`Team.agentConversationVisibility = "assigned"`). admin / manager /
 * superAdmin are never restricted.
 *
 * EVERYTHING funnels through this file on purpose. A visibility rule
 * re-implemented at forty call sites is a rule that will be wrong at one of
 * them, and being wrong here means one customer's messages shown to the wrong
 * agent. So there are exactly two primitives:
 *
 *   `visibilityWhere(viewer)`      — a Prisma where-fragment to AND into any
 *                                    Conversation query.
 *   `assertCanViewConversation()`  — the guard for per-conversation endpoints.
 *
 * THE HANDOVER RULE. Scoping keys on the CURRENT assignee, never on who wrote
 * a message. That is deliberate and load-bearing: when an admin moves a thread
 * from Ali to Sara, Sara sees the ENTIRE history — every message, internal
 * note, call and activity event, including Ali's — and continues the
 * conversation seamlessly. Ali loses access at the same instant. Any design
 * that filtered by authorship would hand Sara a thread full of holes.
 *
 * FAIL CLOSED. `restricted` is computed once per session from the role and the
 * team setting. If either is missing we do NOT restrict — that matches the
 * default ("team") and avoids locking a whole org out of its own inbox on a
 * bad read — but every *per-conversation* check fails closed: an unreadable or
 * missing conversation is a 404, never a pass.
 */

/** The viewer, as carried on `ApiSession`. */
export interface ConversationViewer {
  userId: string;
  workspaceId: string;
  role: Role;
  /** `Team.agentConversationVisibility`. */
  agentConversationVisibility?: string | null;
}

/**
 * Is this viewer limited to their own conversations?
 *
 * Only `agent` is ever restricted. Managers are explicitly included in the
 * unrestricted set — the product treats them as conversation-level leads who
 * need the whole floor in view to supervise it.
 */
export function isRestrictedViewer(viewer: ConversationViewer): boolean {
  if (viewer.role !== "agent") return false;
  return viewer.agentConversationVisibility === "assigned";
}

/**
 * Where-fragment to AND into any `Conversation` query.
 *
 * Returns `{}` for unrestricted viewers, so an un-configured org's queries are
 * byte-identical to what they were before this feature existed.
 */
export function visibilityWhere(
  viewer: ConversationViewer,
): { assignedUserId?: string } {
  return isRestrictedViewer(viewer) ? { assignedUserId: viewer.userId } : {};
}

/**
 * Same rule, expressed as a filter on a NESTED conversation relation — for
 * queries rooted at Message / InternalNote / Call / MessageFlag rather than at
 * Conversation.
 */
export function conversationRelationWhere(
  viewer: ConversationViewer,
): { conversation?: { assignedUserId: string } } {
  return isRestrictedViewer(viewer)
    ? { conversation: { assignedUserId: viewer.userId } }
    : {};
}

/** Thrown by `assertCanViewConversation`. Callers map it to a 404 — never a
 *  403, which would confirm the conversation exists to someone who shouldn't
 *  know that. */
export class ConversationNotVisibleError extends Error {
  constructor() {
    super("conversation_not_found");
    this.name = "ConversationNotVisibleError";
  }
}

/**
 * Guard for any endpoint keyed by a conversation id.
 *
 * Cheap by design: unrestricted viewers (the overwhelming majority, and every
 * request in an un-configured org) return immediately with zero queries.
 */
export async function assertCanViewConversation(
  db: Pick<PrismaClient, "conversation">,
  viewer: ConversationViewer,
  conversationId: string,
): Promise<void> {
  if (!isRestrictedViewer(viewer)) return;
  const row = await db.conversation.findFirst({
    where: {
      id: conversationId,
      workspaceId: viewer.workspaceId,
      assignedUserId: viewer.userId,
    },
    select: { id: true },
  });
  if (!row) throw new ConversationNotVisibleError();
}

/**
 * Cache key suffix for anything memoized per team that is now ALSO per viewer.
 *
 * The conversation-counts memo is keyed by workspaceId; without this a restricted
 * agent would read another agent's cached totals — a leak that no `where`
 * clause could catch because the query never runs. Unrestricted viewers share
 * one key, so the cache stays as effective as it was.
 */
export function visibilityScopeKey(viewer: ConversationViewer): string {
  return isRestrictedViewer(viewer) ? `u:${viewer.userId}` : "team";
}

/**
 * Hooks called when an admin flips `Team.agentConversationVisibility`.
 *
 * The ONE registered invalidator (realtime.gateway.ts) performs the whole
 * revocation in strict order: workspace-scoped session-cache bust (HTTP +
 * socket handshake fast paths), emitter scope-cache bust, a catalog tick so
 * clients re-derive their restricted flag, then a forced disconnect of the
 * workspace's sockets. The ORDER is the security property — the re-handshake
 * must not be able to read a pre-flip cached visibility. Bound on boot rather
 * than imported so this file stays free of NestJS and Prisma — the same seam
 * `presence-bridge.ts` uses for the online-user resolver.
 */
type VisibilityInvalidator = (workspaceId: string) => void;

const invalidators: VisibilityInvalidator[] = [];

export function registerVisibilityInvalidator(fn: VisibilityInvalidator): void {
  invalidators.push(fn);
}

export function invalidateTeamVisibilityCaches(workspaceId: string): void {
  for (const fn of invalidators) {
    try {
      fn(workspaceId);
    } catch {
      // Best-effort: a failed cache bust degrades to "the change lands within
      // the TTL", never to a broken save.
    }
  }
}
