import type { Role } from "../types";
import type { TeamChannelKind, TeamChannelVisibility } from "./types";

/**
 * Team-chat permission predicates. Single source of truth — both server-side
 * guards and client-side conditional rendering call these so the matrix
 * lives in one place.
 *
 * Matrix:
 *   create public ch:  anyone signed in
 *   create private ch: admin, manager (and superAdmin transparently)
 *   rename channel:    admin, manager      (default channel "general" is
 *                                            extra-protected at route level)
 *   delete channel:    admin               (default channel is undeletable)
 *   join public ch:    anyone signed in    (self-serve, no invite needed)
 *   leave channel:     anyone (except the default channel)
 *   start a DM:        anyone signed in, with any active teammate
 *   send message:      anyone signed in
 *   delete own msg:    author or admin
 *   edit own msg:      author only, within EDIT_WINDOW_MS
 *   react / unreact:   anyone
 *   pin / unpin:       admin, manager in a channel; either party in a DM
 *
 * Editing-by-admin is intentionally NOT allowed — admins can delete a
 * problematic message but they can't rewrite history into another agent's
 * voice. Cleaner audit trail.
 */

/**
 * Public channels are free for anyone to create — they're discoverable in the
 * browser and joinable by the whole team, so there's nothing to govern.
 *
 * PRIVATE channels stay admin/manager-gated on purpose: a private channel is
 * invisible in the browser and excluded from every other member's workspace
 * search, so an agent-created one is an ungoverned space with no discovery
 * surface for anyone responsible for the team. Opening that up would want an
 * admin-only "all channels including private" audit view first.
 *
 * The default arg keeps the older 1-arg call sites compiling with the
 * stricter (private) semantics they already assumed.
 */
export function canCreateChannel(
  role: Role,
  visibility: TeamChannelVisibility = "private",
): boolean {
  if (visibility === "public") return true;
  return role === "admin" || role === "manager";
}

/**
 * Pinning in a DM is available to both participants. Role-gating it there is
 * nonsense in both directions: an admin who isn't in the DM can't reach it at
 * all, and a non-admin shouldn't need permission to pin something in their
 * own two-person conversation.
 */
export function canPinInChannel(role: Role, kind: TeamChannelKind): boolean {
  if (kind === "dm") return true;
  return canPinMessage(role);
}

export function canManageChannel(role: Role): boolean {
  return role === "admin" || role === "manager";
}

export function canDeleteChannel(role: Role): boolean {
  return role === "admin";
}

export function canPinMessage(role: Role): boolean {
  return role === "admin" || role === "manager";
}

export function canDeleteMessage(role: Role, authorUserId: string | null, viewerUserId: string): boolean {
  if (authorUserId === viewerUserId) return true;
  return role === "admin";
}

/**
 * 24h edit window. After this, edits 422 — keeps "what did Bob say last
 * week" stable. The composer hides the Edit option once expired so the
 * server-side 422 is a safety net, not the primary UX.
 */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function canEditMessage(
  authorUserId: string | null,
  viewerUserId: string,
  createdAt: Date | string,
): boolean {
  if (authorUserId !== viewerUserId) return false;
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : createdAt.getTime();
  return Date.now() - created < EDIT_WINDOW_MS;
}
