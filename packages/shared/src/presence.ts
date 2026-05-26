/**
 * Shared catalog for user-controlled availability. Used by:
 *   - The Zod schema at the API boundary (PATCH /api/users/me).
 *   - The realtime fanout filter that decides which "online" socket
 *     identities appear in `presence:update`.
 *   - Every client surface that paints the user-state dot/label (sidebar
 *     teammate list, user menu, assignment dropdown).
 *
 * Order is the canonical UI order (matches the picker). Don't depend on the
 * order for logic — switch on the literal value.
 */
import type { UserAvailabilityStatus } from "./types";

export const ALL_AVAILABILITY_STATUSES: UserAvailabilityStatus[] = [
  "available",
  "busy",
  "away",
  "offline",
];

export const AVAILABILITY_LABELS: Record<UserAvailabilityStatus, string> = {
  available: "Available",
  busy: "Busy",
  away: "Away",
  offline: "Appear offline",
};

/**
 * Tailwind class for the small status dot teammates see. Kept here so the
 * sidebar, the user menu, and any future surface (assignment dropdown, viewer
 * pill) all paint the SAME color for a given status — single source of truth
 * means swapping a hue is a one-file edit.
 */
export const AVAILABILITY_DOT_CLASSES: Record<UserAvailabilityStatus, string> = {
  available: "bg-emerald-500",
  busy: "bg-amber-500",
  away: "bg-zinc-400",
  // Offline matches the "no socket" dot color in the sidebar — a user marked
  // offline must be visually indistinguishable from one who's literally gone.
  offline: "bg-muted-foreground/40",
};

/**
 * Resolve a possibly-missing status into the canonical one. The wire format
 * allows `undefined` so the migration doesn't have to backfill; every UI
 * consumer should pass through this helper so "no value" reads as
 * "available" instead of falling through a switch unhandled.
 */
export function resolveAvailabilityStatus(
  status: UserAvailabilityStatus | null | undefined,
): UserAvailabilityStatus {
  return status ?? "available";
}

/**
 * Whether this user should appear in the team-wide online list. Marked-
 * offline users keep their socket connected (so coming back is instant) but
 * teammates see them as offline — same rule everywhere this matters.
 */
export function isVisiblyOnline(
  status: UserAvailabilityStatus | null | undefined,
): boolean {
  return resolveAvailabilityStatus(status) !== "offline";
}
