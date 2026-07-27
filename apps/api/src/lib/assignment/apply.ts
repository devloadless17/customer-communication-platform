import type { PrismaClient } from "@prisma/client";

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";
import type {
  AssignmentContext,
  AssignmentDecision,
  AssignmentSource,
} from "@ccp/shared/assignment/types";

import { assignConversation } from "@/lib/conversations/mutations";

import { pendingCampaignAssignee } from "./campaign-reply";
import { releaseReservation, resolveAssignee } from "./resolve";

/**
 * The WRITE path: resolve a policy decision and actually assign the
 * conversation. Every automated assignment in the product goes through here —
 * AI handoff, the new-conversation router, the reopen router, the workflow
 * `assign_to` policy mode, the rebalance sweeps and the `/v1` API.
 *
 * It exists so the hard parts are solved ONCE:
 *
 *   NEVER STEAL FROM A HUMAN. `onlyIfUnassigned` (default true for every
 *   automated caller) means automation only ever fills an EMPTY slot. An agent
 *   who claimed a thread keeps it, no matter what a policy or a late webhook
 *   redelivery says. This is also what makes the whole surface idempotent
 *   under at-least-once event delivery.
 *
 *   DEGRADE, DON'T DROP. A picked member who was deactivated between the
 *   groupBy and the write is excluded and the pick is retried, rather than
 *   giving up and leaving the customer unowned. Bounded to MAX_ATTEMPTS so a
 *   pathologically broken team can't spin.
 *
 *   LOSE RACES GRACEFULLY. A CAS conflict means someone else changed the
 *   conversation mid-flight. We re-read: if a human took it, we stop; if it's
 *   still free, we try again with a fresh decision.
 *
 * The actual mutation is always `lib/conversations/mutations.assignConversation`,
 * so an automated assignment is indistinguishable downstream from a manual one:
 * same CAS, same status side-effects, same `conversation.assigned` event, same
 * realtime frame, audit row, analytics and outbound webhook.
 */

type Db = Pick<
  PrismaClient,
  | "conversation"
  | "user"
  | "$transaction"
  | "assignmentPolicy"
  | "assignmentRule"
  | "assignmentSettings"
  | "assignmentPolicyMember"
>;

type Publish = <K extends DomainEventType>(event: DomainEventOf<K>) => Promise<void>;

/** Retries cover "the member vanished between pick and write". Three is enough
 *  to survive two concurrent deactivations; beyond that the team is broken and
 *  triage is the right answer. */
const MAX_ATTEMPTS = 3;

export type AssignByPolicyOutcome =
  | {
      applied: true;
      userId: string;
      decision: AssignmentDecision;
      /** True when the write also flipped closed→pending (reopen into triage). */
      statusChanged: boolean;
      /**
       * False when the write was an idempotent NO-OP (the target was already
       * the assignee). Callers that COUNT moves — the offline rebalance's
       * "moved N conversations", remove-member's unassign-when-no-candidate —
       * must not treat a no-op as a move: the rebalance logged rescues that
       * never happened, and remove-member skipped the unassign it owed.
       */
      changed: boolean;
    }
  | {
      applied: false;
      userId: null;
      decision: AssignmentDecision | null;
      skipped:
        | "already_assigned"
        | "not_found"
        | "no_assignee"
        | "lost_race"
        | "exhausted";
    };

/**
 * Build the rule-matching context from what's already on the conversation, so
 * callers don't each hand-roll (and drift on) the same joins. Returns null when
 * the conversation is gone.
 */
export async function buildAssignmentContext(
  db: Db,
  workspaceId: string,
  conversationId: string,
  source: AssignmentSource,
  extra?: Partial<AssignmentContext>,
): Promise<{
  ctx: AssignmentContext;
  assignedUserId: string | null;
} | null> {
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      assignedUserId: true,
      channel: true,
      contact: {
        select: {
          stageId: true,
          language: true,
          createdAt: true,
          tags: { select: { id: true } },
        },
      },
    },
  });
  if (!conv) return null;

  return {
    assignedUserId: conv.assignedUserId,
    ctx: {
      source,
      channel: conv.channel,
      tagIds: conv.contact?.tags.map((t) => t.id) ?? [],
      stageId: conv.contact?.stageId ?? null,
      language: conv.contact?.language ?? null,
      ...extra,
    },
  };
}

export async function assignByPolicy(args: {
  db: Db;
  publish: Publish;
  workspaceId: string;
  conversationId: string;
  source: AssignmentSource;
  /** Extra rule-matching context the caller has cheaply (message text, etc). */
  context?: Partial<AssignmentContext>;
  /** Force a specific policy (workflow step / campaign / API). */
  policyId?: string | null;
  /** Default TRUE. Automation must not take a thread away from a human. */
  onlyIfUnassigned?: boolean;
  changedByUserId?: string | null;
  changedByApiKeyId?: string | null;
  changedByWorkflowId?: string | null;
  /** Default false: an auto-assignment is a real business change and SHOULD
   *  drive workflows + outbound webhooks. Workflow steps pass true to avoid
   *  chain-triggering themselves mid-run. */
  silent?: boolean;
}): Promise<AssignByPolicyOutcome> {
  const {
    db,
    publish,
    workspaceId,
    conversationId,
    source,
    context,
    policyId,
    onlyIfUnassigned = true,
    changedByUserId = null,
    changedByApiKeyId,
    changedByWorkflowId,
    silent = false,
  } = args;

  const built = await buildAssignmentContext(db, workspaceId, conversationId, source, context);
  if (!built) {
    return { applied: false, userId: null, decision: null, skipped: "not_found" };
  }
  if (onlyIfUnassigned && built.assignedUserId) {
    return { applied: false, userId: null, decision: null, skipped: "already_assigned" };
  }

  // A campaign draw outranks the policy on the paths where a human is being
  // brought in for a customer who replied to a campaign. The admin said "these
  // 50 people are Ali's"; that intent must survive the AI answering first and
  // escalating later, which would otherwise re-route the thread generically.
  // Only consulted on those paths — every other caller skips the query.
  if (source === "ai_handoff" || source === "inbound" || source === "reopen") {
    const drawn = await pendingCampaignAssignee({ workspaceId, conversationId }).catch(
      () => null,
    );
    if (drawn) {
      const result = await assignConversation({
        db,
        publish,
        workspaceId,
        conversationId,
        targetUserId: drawn.userId,
        changedByUserId,
        ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
        ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
        // Honour the campaign's own overwrite setting, not just the caller's
        // flag: `assignmentOverwrite: false` (the default) promises a blast
        // never takes a live thread from the agent handling it, and the
        // ai_handoff path calls in with onlyIfUnassigned: false.
        onlyIfUnassigned: onlyIfUnassigned || !drawn.overwrite,
        silent,
      });
      if (result.ok) {
        const decision: AssignmentDecision = {
          userId: drawn.userId,
          reason: "fixed",
          policyId: null,
          policyName: "Campaign assignment",
          ruleId: null,
          ruleName: null,
        };
        return {
          applied: true,
          userId: drawn.userId,
          decision,
          statusChanged: result.statusChanged,
          changed: result.changed,
        };
      }
      // Anything else (the drawn member left, a CAS race) falls through to
      // normal policy routing rather than leaving the customer unowned.
    }
  }

  const excluded: string[] = [];
  let lastDecision: AssignmentDecision | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const decision = await resolveAssignee({
      db,
      workspaceId,
      // Caller exclusions (e.g. the offline-rebalance excluding the agent who
      // went home) MUST survive: this used to overwrite `built.ctx`'s list
      // with the retry-loop's own `excluded`, which is empty on attempt 0 —
      // so the offline sweep happily re-picked the very agent it was trying
      // to route around (continuity then hands the thread straight back).
      ctx: {
        ...built.ctx,
        excludeUserIds: [...(built.ctx.excludeUserIds ?? []), ...excluded],
      },
      policyId,
      conversationId,
    });
    lastDecision = decision;
    if (!decision.userId) {
      return { applied: false, userId: null, decision, skipped: "no_assignee" };
    }

    const result = await assignConversation({
      db,
      publish,
      workspaceId,
      conversationId,
      targetUserId: decision.userId,
      changedByUserId,
      ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
      ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
      // §18, enforced where it is actually race-proof. The pre-read at the top
      // of this function is only a cheap fast path: between it and this write
      // sit a campaign lookup, a config load, a member groupBy, a continuity
      // read and a cursor write — tens of ms in which an agent can claim the
      // thread. Passing the flag makes `assignConversation` re-check INSIDE
      // the same read that feeds its CAS, so automation can no longer
      // overwrite a human who clicked "Assign to me" mid-routing.
      onlyIfUnassigned,
      silent,
    });

    if (result.ok) {
      return {
        applied: true,
        userId: decision.userId,
        decision,
        statusChanged: result.statusChanged,
        changed: result.changed,
      };
    }

    // The pick reserved a least-busy slot for this user; the write didn't
    // land, so give it back — otherwise the phantom +1 skews the next pick
    // against them for the reservation TTL. (Cursor/`served` stay advanced —
    // see releaseReservation's doc for why rolling those back would be worse.)
    releaseReservation(workspaceId, decision.userId);

    switch (result.reason) {
      case "invalid_user":
        // Deactivated / removed between the pick and the write. Exclude and
        // let the next attempt route to someone real.
        excluded.push(decision.userId);
        continue;
      case "not_found":
        return { applied: false, userId: null, decision, skipped: "not_found" };
      case "conflict": {
        // Someone else mutated the conversation mid-flight. If a human claimed
        // it, we're done — automation never overrides that.
        const now = await db.conversation.findFirst({
          where: { id: conversationId, workspaceId },
          select: { assignedUserId: true },
        });
        if (!now) {
          return { applied: false, userId: null, decision, skipped: "not_found" };
        }
        if (onlyIfUnassigned && now.assignedUserId) {
          return { applied: false, userId: null, decision, skipped: "lost_race" };
        }
        continue;
      }
    }
  }

  return { applied: false, userId: null, decision: lastDecision, skipped: "exhausted" };
}
