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

/**
 * Cross-workspace enumeration of everyone online, for the agent-presence
 * sampler (lib/sweepers/agent-presence-sample.ts) — the per-workspace resolver
 * above can't answer "who is online ANYWHERE" without knowing every workspace
 * id. Same wiring pattern and same null contract: null = no enumerator in
 * this process (a standalone worker), an empty array = genuinely nobody
 * connected.
 */
type OnlineEnumerator = () => Array<{ workspaceId: string; userId: string }>;

let enumerator: OnlineEnumerator | null = null;

export function setOnlinePresenceEnumerator(fn: OnlineEnumerator): void {
  enumerator = fn;
}

export function enumerateOnlineUsers(): Array<{
  workspaceId: string;
  userId: string;
}> | null {
  return enumerator ? enumerator() : null;
}
