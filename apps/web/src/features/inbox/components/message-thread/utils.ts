import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";
import type { User } from "@ccp/shared/types";

/**
 * What the workspace's own team sees where an actor id doesn't resolve to one
 * of their members.
 *
 * In practice that is the PLATFORM OPERATOR. They act in the workspace holding
 * no `WorkspaceMember` row — which is the whole point of operator mode, since
 * membership is what excludes them from assignment pools, availability and seat
 * counts — so `/api/users` (the query that defines "who is in this workspace")
 * deliberately omits them and their id arrives here unresolvable.
 *
 * A DELETED teammate is not this case: those FKs are `onDelete: SetNull`, so
 * the id is null and still reads "Removed user" below.
 *
 * Named rather than personal, deliberately: the tenant's team has no
 * relationship with the operator as a person, and a real name invites a reply
 * to a stranger. The operator sees "Support" on their own messages too — mildly
 * odd for them, correct for everyone else, and not worth threading the current
 * user through six call sites to special-case.
 */
export const UNKNOWN_ACTOR_NAME = "Support";

/**
 * Synthesize a placeholder user for the inbox UI in three cases:
 *   - We don't have the row in our local `memberById` map — the platform
 *     operator (see `UNKNOWN_ACTOR_NAME`), or a rare load race.
 *   - The note/message was authored by a teammate who has been hard-deleted
 *     (authorUserId / senderUserId is now NULL in the DB).
 *   - We want to render "Removed user" without crashing.
 */
export function unknownAuthor(id: string | null): User {
  return {
    id: id ?? "removed",
    workspaceId: "",
    role: "agent",
    name: id ? UNKNOWN_ACTOR_NAME : "Removed user",
    email: "",
    isActive: false,
  };
}

/**
 * Resolve an actor id to the name to print, for the timeline's non-note rows
 * (message sender, call initiator / answerer) which take a bare string.
 *
 * One helper instead of six copies of `memberById.get(id)?.name ?? null` —
 * every one of which rendered the platform operator as a nameless bubble.
 */
export function actorName(
  memberById: ReadonlyMap<string, User>,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return memberById.get(id)?.name ?? UNKNOWN_ACTOR_NAME;
}

/** Best-effort extract a human-readable message from a 4xx/5xx response. */
export async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as
    | { error?: string; detail?: string }
    | null;
  return apiErrorMessageFrom(json, `Server returned HTTP ${res.status}.`);
}
