/**
 * Tiny bridge so framework-agnostic lib code (the round-robin picker, used by
 * both the AI-handoff service and the workflow `assign_to` step) can consult
 * LIVE socket presence — which lives in-memory in the NestJS `PresenceService`,
 * not the DB. The api wires the resolver on boot (see presence.service.ts);
 * same pattern as `setSharedDb`.
 *
 * Returns `null` when presence isn't wired or knowable in this process (e.g. a
 * standalone worker, or right after a restart before anyone reconnects), which
 * tells callers to fall back to the DB availabilityStatus only.
 */
type OnlineResolver = (teamId: string) => Set<string>;

let resolver: OnlineResolver | null = null;

export function setOnlinePresenceResolver(fn: OnlineResolver): void {
  resolver = fn;
}

/** Connected userIds for the team, or null if presence is unavailable here. */
export function getOnlineUserIds(teamId: string): Set<string> | null {
  return resolver ? resolver(teamId) : null;
}
