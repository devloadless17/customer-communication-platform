import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { assignConversation } from "@/lib/conversations/mutations";

/**
 * Apply a campaign's drawn assignee when the customer actually REPLIES.
 *
 * Why replies and not sends. A broadcast is overwhelmingly one-way: send
 * 10,000 templates and a few hundred people answer. Assigning every recipient
 * at send time would drop ~9,700 conversations nobody will ever respond to onto
 * agents' plates — and those conversations are exactly what capacity limits and
 * least-busy routing are measured against, so the whole routing system would be
 * reading a number made of noise. Ali would look "full" because of a campaign he
 * has nothing to do.
 *
 * So the split is DRAWN up front, at materialize time — that's what keeps
 * "first 50 to Ali" exact and resumable — and APPLIED here, per person, only
 * when they engage. A campaign can opt into the old behavior with
 * `Broadcast.assignmentTrigger = "on_send"`, for outreach where owning the
 * follow-up matters more than owning the reply.
 *
 * Called fire-and-forget from the inbound attribution path, which has already
 * decided WHICH campaign earned the reply (direct quote, else last-touch inside
 * the attribution window). This function never re-derives that.
 */
export async function applyCampaignAssigneeOnReply(args: {
  workspaceId: string;
  contactId: string;
  /** The BroadcastRecipient the reply was just credited to. */
  recipientId: string;
}): Promise<void> {
  const { workspaceId, contactId, recipientId } = args;

  const recipient = await db.broadcastRecipient.findUnique({
    where: { id: recipientId },
    select: {
      assignedUserId: true,
      broadcast: {
        select: { workspaceId: true, assignmentTrigger: true, assignmentOverwrite: true },
      },
    },
  });
  if (!recipient?.assignedUserId) return;
  // BroadcastRecipient has no workspaceId of its own (it's scoped through Broadcast),
  // so assert tenancy explicitly rather than relying on the caller.
  if (recipient.broadcast.workspaceId !== workspaceId) return;
  // "on_send" campaigns already assigned in the runner.
  if (recipient.broadcast.assignmentTrigger !== "on_reply") return;

  const conversation = await db.conversation.findFirst({
    where: { workspaceId, contactId },
    select: { id: true },
  });
  if (!conversation) return;

  // Shared mutation → same CAS, status side-effects, realtime frame, audit row
  // and outbound webhook as a manual assign. NOT silent: campaign ownership is
  // a real business change workflows and partners should see.
  //
  // "Never take a live conversation from the agent already handling it" is
  // enforced by `onlyIfUnassigned` INSIDE the mutation's own read — the
  // previous read-then-return left two round trips in which an agent could
  // claim the thread and still be overwritten.
  await assignConversation({
    db,
    publish,
    workspaceId,
    conversationId: conversation.id,
    targetUserId: recipient.assignedUserId,
    onlyIfUnassigned: !recipient.broadcast.assignmentOverwrite,
    changedByUserId: null,
  });
}

/**
 * A campaign assignee still owed to this conversation.
 *
 * Consulted by `assignByPolicy` so a campaign's split can't be lost to a race
 * or to the AI:
 *
 *   THE RACE. When a customer replies, TWO post-commit paths react to the same
 *   inbound with no ordering guarantee between them — the auto-assign
 *   subscriber (via `message.received`) and the attribution path (which is what
 *   sets `repliedAt`). If this gated on `repliedAt`, the subscriber could win,
 *   see no campaign draw, assign by policy, and then attribution would find the
 *   conversation already owned and skip — silently discarding the admin's
 *   split. So it matches on the SEND window instead, exactly like
 *   `resolveAttributedRecipient` does, which makes both paths pick the same
 *   person regardless of who runs first. Whoever wins, the answer is identical
 *   and the loser no-ops.
 *
 *   THE AI. When the assistant answers the reply, no human is assigned yet
 *   (correct — none is needed). This is what makes the thread land on the
 *   drawn owner when the AI later escalates, instead of being re-routed by the
 *   generic policy.
 *
 * Deliberately narrow: `on_reply` campaigns only, inside the attribution
 * window, and only asked on the inbound/reopen/handoff paths. Returns null for
 * everything else, which is the overwhelming majority of calls.
 */
export async function pendingCampaignAssignee(args: {
  workspaceId: string;
  conversationId: string;
}): Promise<{ userId: string; overwrite: boolean } | null> {
  const conv = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: { contactId: true },
  });
  if (!conv) return null;

  const cutoff = new Date(Date.now() - attributionWindowMs());
  const recipient = await db.broadcastRecipient.findFirst({
    where: {
      contactId: conv.contactId,
      assignedUserId: { not: null },
      sentAt: { gte: cutoff },
      // Only a message that actually reached the customer can earn a reply —
      // same gate attribution applies.
      deliveryState: { in: ["sent", "delivered", "read"] },
      // IN the where, not a post-check on the single newest row: this is
      // last-touch among ON_REPLY campaigns specifically. As a post-filter, a
      // newer on_send campaign's recipient row (which always carries an
      // assignee) masked an older still-pending on_reply draw and this
      // returned null — the admin's split silently lost to generic routing.
      broadcast: {
        workspaceId: args.workspaceId,
        assignmentTrigger: "on_reply",
      },
    },
    // Backed by @@index([contactId, sentAt desc]).
    orderBy: { sentAt: "desc" },
    select: {
      assignedUserId: true,
      broadcast: {
        select: {
          // Carried so the CALLER can honour it. `applyCampaignAssigneeOnReply`
          // below always did; the ai_handoff/inbound/reopen path in apply.ts
          // did not, so a campaign with the default `assignmentOverwrite:
          // false` — documented as "a blast never takes a live support thread
          // from the agent handling it" — still took the thread from the agent
          // working it when the AI later escalated.
          assignmentOverwrite: true,
        },
      },
    },
  });
  if (!recipient?.assignedUserId) return null;
  return {
    userId: recipient.assignedUserId,
    overwrite: recipient.broadcast.assignmentOverwrite,
  };
}

/**
 * Attribution window, mirroring `lib/broadcast-attribution.ts`. Re-read from the
 * env here rather than imported so this module stays free of a cycle
 * (attribution imports THIS file). Same default and same clamp — a drift
 * between the two would make a campaign owner and a campaign reply-credit
 * disagree about which campaign a message belongs to.
 */
function attributionWindowMs(): number {
  const raw = Number.parseInt(process.env.BROADCAST_REPLY_ATTRIBUTION_HOURS ?? "72", 10);
  const hours = Number.isFinite(raw) && raw >= 1 && raw <= 168 ? raw : 72;
  return hours * 60 * 60 * 1000;
}
