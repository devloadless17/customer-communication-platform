import type { Role } from "../types";

/**
 * Team-chat permission predicates. Single source of truth — both server-side
 * guards and client-side conditional rendering call these so the matrix
 * lives in one place.
 *
 * Matrix:
 *   create channel:    admin, manager (and superAdmin transparently)
 *   rename channel:    admin, manager      (default channel "general" is
 *                                            extra-protected at route level)
 *   delete channel:    admin               (default channel is undeletable)
 *   send message:      anyone signed in
 *   delete own msg:    author or admin
 *   edit own msg:      author only, within EDIT_WINDOW_MS
 *   react / unreact:   anyone
 *   pin / unpin:       admin, manager
 *
 * Editing-by-admin is intentionally NOT allowed — admins can delete a
 * problematic message but they can't rewrite history into another agent's
 * voice. Cleaner audit trail.
 */

export function canCreateChannel(role: Role): boolean {
  return role === "superAdmin" || role === "admin" || role === "manager";
}

export function canManageChannel(role: Role): boolean {
  return role === "superAdmin" || role === "admin" || role === "manager";
}

export function canDeleteChannel(role: Role): boolean {
  return role === "superAdmin" || role === "admin";
}

export function canPinMessage(role: Role): boolean {
  return role === "superAdmin" || role === "admin" || role === "manager";
}

export function canDeleteMessage(role: Role, authorUserId: string | null, viewerUserId: string): boolean {
  if (authorUserId === viewerUserId) return true;
  return role === "superAdmin" || role === "admin";
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
