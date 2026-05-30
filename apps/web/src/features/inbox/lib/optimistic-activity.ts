"use client";

import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import type {
  ConversationActivityEvent,
  ConversationStatus,
} from "@ccp/shared/types";

/**
 * Optimistic activity-log pills.
 *
 * The header (status badge / assignee chip / stage stepper) flips instantly via
 * the existing optimistic `conversation:status` / `conversation:assigned` /
 * `contact:updated` dispatches, but the matching timeline PILL came only from
 * the authoritative GET /api/conversations/:id/events — a round-trip behind the
 * header. These builders close that gap for the agent who MADE the change:
 * synthesize the same `ConversationActivityEvent` the server will write (all
 * fields `describe()` reads — actor, value names, before/after, time) from data
 * already in hand, and fan it on the client-only `conversation:activity` event.
 *
 * `use-conversation-events` appends it to `data.events` immediately; the
 * trailing authoritative GET then replaces the whole array with server rows
 * (correct id + exact server time), so the stub is reconciled away — never
 * persisted, never doubled (matched out by its `optimistic-…` id prefix).
 *
 * Teammates' changes are NOT covered here (the socket frames they ride don't
 * carry actor/time/resolved names) — they surface via the now leading-edge GET,
 * a beat slower, which is already a remote round-trip. See the question the user
 * answered: "my own actions" scope.
 */

export const OPTIMISTIC_ACTIVITY_ID_PREFIX = "optimistic-activity-";

let counter = 0;
function newOptimisticId(): string {
  counter += 1;
  return `${OPTIMISTIC_ACTIVITY_ID_PREFIX}${Date.now()}-${counter}`;
}

/** True for a stub this module created — used to dedupe against server rows. */
export function isOptimisticActivityId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_ACTIVITY_ID_PREFIX);
}

function base(
  conversationId: string,
  actorName: string,
  kind: ConversationActivityEvent["kind"],
): ConversationActivityEvent {
  return {
    id: newOptimisticId(),
    conversationId,
    kind,
    actorName,
    actorKind: "user",
    before: null,
    after: null,
    at: new Date().toISOString(),
  };
}

/** Roll back one stub (failed PATCH) so the pill doesn't linger as a lie. */
export function rollbackOptimisticActivity(
  teamId: string,
  conversationId: string,
  optimisticId: string,
): void {
  dispatchLocalSocketEvent("conversation:activity", {
    teamId,
    conversationId,
    event: null,
    removeId: optimisticId,
  });
}

// --- per-kind builders ----------------------------------------------------
// Each returns the dispatch tuple + the stub id WITHOUT fanning. The caller
// bundles the activity-pill frame with the state-changing frame
// (`conversation:status`, `conversation:assigned`, `contact:updated`) into ONE
// `dispatchLocalSocketEvents([...])` call — so React commits header chip +
// pill in a single paint cycle. Two separate `dispatchLocalSocketEvent` calls
// each wrap their own flushSync, which produces two paints back-to-back —
// that's the visible "the activity log lags everything else" gap.
// -------------------------------------------------------------------------

type ActivityDispatch = [
  "conversation:activity",
  { teamId: string; conversationId: string; event: ConversationActivityEvent },
];

export interface OptimisticActivityBuild {
  /** Tuple to pass into `dispatchLocalSocketEvents([..., frame])`. */
  frame: ActivityDispatch;
  /** Stub id — pass to `rollbackOptimisticActivity` on a failed write. */
  id: string;
}

function build(
  teamId: string,
  conversationId: string,
  event: ConversationActivityEvent,
): OptimisticActivityBuild {
  return {
    id: event.id,
    frame: ["conversation:activity", { teamId, conversationId, event }],
  };
}

export function buildOptimisticStatusChange(args: {
  teamId: string;
  conversationId: string;
  actorName: string;
  status: ConversationStatus;
}): OptimisticActivityBuild {
  const e = base(args.conversationId, args.actorName, "status_changed");
  e.after = { status: args.status };
  return build(args.teamId, args.conversationId, e);
}

export function buildOptimisticAssignment(args: {
  teamId: string;
  conversationId: string;
  actorName: string;
  assignedToName: string | null;
}): OptimisticActivityBuild {
  const e = base(args.conversationId, args.actorName, "assigned");
  e.assignedToName = args.assignedToName;
  return build(args.teamId, args.conversationId, e);
}

export function buildOptimisticStageChange(args: {
  teamId: string;
  conversationId: string;
  actorName: string;
  fromStageName: string | null;
  toStageName: string | null;
}): OptimisticActivityBuild {
  const e = base(args.conversationId, args.actorName, "stage_changed");
  e.before = { stageName: args.fromStageName };
  e.after = { stageName: args.toStageName };
  return build(args.teamId, args.conversationId, e);
}

export function buildOptimisticTagAdded(args: {
  teamId: string;
  conversationId: string;
  actorName: string;
  tagName: string;
}): OptimisticActivityBuild {
  const e = base(args.conversationId, args.actorName, "tag_added");
  e.after = { tagName: args.tagName };
  return build(args.teamId, args.conversationId, e);
}

export function buildOptimisticTagRemoved(args: {
  teamId: string;
  conversationId: string;
  actorName: string;
  tagName: string;
}): OptimisticActivityBuild {
  const e = base(args.conversationId, args.actorName, "tag_removed");
  e.before = { tagName: args.tagName };
  return build(args.teamId, args.conversationId, e);
}

