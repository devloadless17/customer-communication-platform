import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";
import type { User } from "@ccp/shared/types";

/**
 * What the inbox prints for an actor id that isn't in the workspace roster.
 *
 * NOT "Support", and that distinction is the whole point. This fallback used to
 * mean "the platform operator", inferred from a roster miss — but a roster miss
 * has a much more common cause: a teammate whose membership was revoked keeps
 * their `User` row AND everything they authored, while `/api/users` (which
 * defines who is in this workspace) filters on membership. So every note, reply
 * and call an EX-TEAMMATE ever made started reading "Support", telling a
 * customer the platform vendor wrote their internal notes.
 *
 * Only the SERVER can tell those two apart — it can check `isSuperAdmin`
 * alongside the membership — so that is where the operator mask now lives
 * (`apps/api/src/lib/workspaces/operator-mask.ts`), and an operator's name
 * arrives here already reading "Support". Anything still unresolved at this
 * point is a former member, or a brief roster load race.
 */
export const UNKNOWN_ACTOR_NAME = "Former member";

/**
 * Synthesize a placeholder user for the inbox UI in three cases:
 *   - The actor isn't in our local `memberById` map — a former member, or a
 *     rare load race (see `UNKNOWN_ACTOR_NAME`).
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
