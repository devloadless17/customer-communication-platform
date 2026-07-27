/**
 * Tiny bridge so framework-agnostic lib code (the round-robin picker, used by
 * both the AI-handoff service and the workflow `assign_to` step) can consult
 * LIVE socket presence — which lives in-memory in the NestJS `PresenceService`,
 * not the DB. The api wires the resolver on boot (see presence.service.ts);
 * same pattern as `setSharedDb`.
 *
 * Returns `null` ONLY when no resolver is wired in this process (a standalone
 * worker) — callers then fall back to the DB availabilityStatus. In the api
 * process the resolver is wired at boot, so right after a restart this returns
 * an EMPTY set, not null: callers that would conclude "everyone is offline"
 * from that (the rebalance sweeper) must treat empty as unknowable too.
 */
type OnlineResolver = (workspaceId: string) => Set<string>;

let resolver: OnlineResolver | null = null;

export function setOnlinePresenceResolver(fn: OnlineResolver): void {
  resolver = fn;
}

/** Connected userIds for the team, or null if presence is unavailable here. */
export function getOnlineUserIds(workspaceId: string): Set<string> | null {
  return resolver ? resolver(workspaceId) : null;
}
