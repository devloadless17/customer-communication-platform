"use client";

import { memo } from "react";
import Link from "next/link";
import {
  ArrowRightLeft,
  Ban,
  Bot,
  CircleDot,
  Flag,
  FlagOff,
  RefreshCw,
  Tag,
  Ticket as TicketIcon,
  Trash2,
  Undo2,
  UserPlus,
  UserMinus,
} from "lucide-react";

import { LocalTime } from "@/components/local-time";
import type { ConversationActivityEvent, ConversationStatus } from "@ccp/shared/types";

// Slim, centered, single-line audit pill interleaved with the message
// timeline ("Sara assigned to Ali", "Ali closed the conversation", "Omar
// moved stage Lead → Customer"). Deliberately lightweight — one icon + one
// line of muted text — so the activity log reads as quiet context, never
// competing with messages for attention or weighing the thread down.

const STATUS_VERB: Record<ConversationStatus, string> = {
  open: "reopened the conversation",
  pending: "marked the conversation pending",
  closed: "closed the conversation",
};

/**
 * Bold actor fragment, reused across every kind.
 *  - user / apiKey → the resolved name ("Sara", "Zapier integration")
 *  - workflow      → "workflow «name»" (the automation that made the change),
 *                    or "Automation" when the workflow was since deleted
 *  - system        → "System" (retention sweeps / unattributed)
 * Rendered as one `<b>` so the surrounding sentence structure is unchanged for
 * the existing kinds — only the *text* differs for the workflow actor.
 */
function actor(event: ConversationActivityEvent): React.ReactNode {
  if (event.actorKind === "workflow") {
    // actorWorkflowName === null → workflow deleted; undefined shouldn't happen
    // for a workflow actor but the ?? guards it the same way.
    const name = event.actorWorkflowName;
    return name ? <b>workflow «{name}»</b> : <b>Automation</b>;
  }
  return <b>{event.actorName ?? "System"}</b>;
}

/**
 * Build the icon + sentence for one event. Pure — driven entirely by the
 * pre-resolved fields the server wrote (names already resolved at audit time),
 * so renames/deletes never garble a historical line.
 */
function describe(e: ConversationActivityEvent): {
  icon: typeof CircleDot;
  text: React.ReactNode;
} | null {
  // `who` is the bold actor node (name for user/apiKey, "workflow «name»" for
  // an automation, "System" otherwise). Built once; each branch drops it into
  // the sentence in place of the former inline `{who}`.
  const who = actor(e);
  switch (e.kind) {
    case "assigned": {
      const toName = e.assignedToName;
      // assignedToName === null → unassigned; a string → assigned to them.
      if (toName == null) {
        return {
          icon: UserMinus,
          text: (
            <>
              {who} unassigned the conversation
            </>
          ),
        };
      }
      // Self-assign reads more naturally as "assigned to themselves".
      const toSelf = toName === e.actorName;
      return {
        icon: UserPlus,
        text: toSelf ? (
          <>
            {who} self-assigned
          </>
        ) : (
          <>
            {who} assigned to <b>{toName}</b>
          </>
        ),
      };
    }
    case "status_changed": {
      const status = (e.after?.status as ConversationStatus | undefined) ?? null;
      if (!status) return null;
      return {
        icon: CircleDot,
        text: (
          <>
            {who} {STATUS_VERB[status]}
          </>
        ),
      };
    }
    case "ai_paused":
      return {
        icon: Bot,
        text: (
          <>
            {who} paused AI Autopilot
          </>
        ),
      };
    case "ai_resumed":
      return {
        icon: Bot,
        text: (
          <>
            {who} resumed AI Autopilot
          </>
        ),
      };
    // Provider-level block (WhatsApp Block Users API). The pill is what
    // explains the locked composer to a teammate opening the thread later.
    case "contact_blocked":
      return {
        icon: Ban,
        text: (
          <>
            {who} blocked this contact
          </>
        ),
      };
    case "contact_unblocked":
      return {
        icon: Undo2,
        text: (
          <>
            {who} unblocked this contact
          </>
        ),
      };
    case "stage_changed": {
      const from = (e.before?.stageName as string | null | undefined) ?? null;
      const to = (e.after?.stageName as string | null | undefined) ?? null;
      return {
        icon: ArrowRightLeft,
        text: (
          <>
            {who} moved stage{" "}
            {from ? <b>{from}</b> : <i>none</i>} → {to ? <b>{to}</b> : <i>none</i>}
          </>
        ),
      };
    }
    case "tag_added": {
      const name = (e.after?.tagName as string | null | undefined) ?? null;
      return {
        icon: Tag,
        text: (
          <>
            {who} added tag {name ? <b>{name}</b> : <i>tag</i>}
          </>
        ),
      };
    }
    case "tag_removed": {
      const name = (e.before?.tagName as string | null | undefined) ?? null;
      return {
        icon: Tag,
        text: (
          <>
            {who} removed tag {name ? <b>{name}</b> : <i>tag</i>}
          </>
        ),
      };
    }
    // Message triage flags. `definitionName` was snapshotted at audit-write
    // time, so these lines stay correct after the definition is renamed or
    // archived — same guarantee as tagName above.
    case "flag_added": {
      const name = (e.after?.definitionName as string | null | undefined) ?? null;
      return {
        icon: Flag,
        text: (
          <>
            {who} flagged a message as {name ? <b>{name}</b> : <i>a flag</i>}
          </>
        ),
      };
    }
    case "flag_reopened": {
      const name = (e.after?.definitionName as string | null | undefined) ?? null;
      return {
        icon: Flag,
        text: (
          <>
            {who} reopened the {name ? <b>{name}</b> : <i>flag</i>} flag
          </>
        ),
      };
    }
    case "flag_resolved": {
      const name = (e.after?.definitionName as string | null | undefined) ?? null;
      // `dismissed` means "this wasn't actually one" — a materially different
      // outcome from "handled", and worth distinguishing in the timeline.
      const dismissed = e.after?.status === "dismissed";
      return {
        icon: dismissed ? FlagOff : Flag,
        text: (
          <>
            {who} {dismissed ? "dismissed" : "resolved"} the{" "}
            {name ? <b>{name}</b> : <i>flag</i>} flag
          </>
        ),
      };
    }
    case "flag_removed": {
      const name = (e.before?.definitionName as string | null | undefined) ?? null;
      return {
        icon: FlagOff,
        text: (
          <>
            {who} removed the {name ? <b>{name}</b> : <i>flag</i>} flag
          </>
        ),
      };
    }
    case "note_deleted":
      return {
        icon: Trash2,
        text: (
          <>
            {who} deleted an internal note
          </>
        ),
      };
    // note_added is intentionally NOT rendered as a pill: the note card itself
    // already shows inline, so a "added a note" line would be redundant noise.
    case "note_added":
      return null;
    // The visitor chose "Start a new conversation" in the widget — a self-contained
    // line (the actor IS the visitor, so there's no team-user prefix).
    case "visitor_started_conversation":
      return {
        icon: RefreshCw,
        text: <>Visitor started a new conversation</>,
      };
    // Ticket boundaries. Only four of the ticket lifecycle's transitions cross
    // over into the THREAD timeline — the ones that change what the
    // conversation means from here on. The full history lives on the ticket
    // itself; putting it all here would drown the thread.
    //
    // The number and subject are snapshotted on the audit row at write time
    // (same rule as tag_added), so the pill keeps reading correctly after a
    // rename — and the link stays valid because the id is snapshotted too.
    case "ticket_opened":
    case "ticket_reopened":
    case "ticket_solved":
    case "ticket_closed": {
      const number = e.after?.number;
      const subject = (e.after?.subject as string | null | undefined) ?? null;
      const id = (e.after?.ticketId as string | null | undefined) ?? null;
      const verb =
        e.kind === "ticket_opened"
          ? "opened"
          : e.kind === "ticket_reopened"
            ? "reopened"
            : e.kind === "ticket_solved"
              ? "solved"
              : "closed";
      const label = typeof number === "number" ? `#${number}` : "a ticket";
      return {
        icon: TicketIcon,
        text: (
          <>
            {who} {verb}{" "}
            {id ? (
              <Link href={`/tickets/${id}`} className="font-medium hover:underline">
                {label}
              </Link>
            ) : (
              <b>{label}</b>
            )}
            {subject ? <> — {subject}</> : null}
          </>
        ),
      };
    }
    default:
      return null;
  }
}

function ActivityEntryImpl({
  event,
}: {
  event: ConversationActivityEvent;
}) {
  // No entrance animation: an audit pill must appear INSTANTLY and solid in its
  // final spot, like a WhatsApp Web / Slack micro event-line. ANY tween — even
  // opacity/transform — reads as a "bounce / lag before it settles" on the
  // newest pill. Adding the row shifts the older content up by its height in ONE
  // column-reverse reflow step (already clean); the pill itself just paints in
  // place. (History: a height tween slid the whole stack; a 4px opacity/y rise
  // then bounced the single new pill — both removed for a dead-solid result.)
  const desc = describe(event);
  if (!desc) return null;
  const Icon = desc.icon;
  return (
    <div className="my-1 flex w-full justify-center px-4">
      <div className="inline-flex max-w-2xl items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-0.5 text-2xs leading-tight text-muted-foreground">
        <Icon className="size-3 shrink-0 opacity-80" />
        <span className="wrap-break-word [&>b]:font-medium [&>b]:text-foreground/80 [&>i]:not-italic [&>i]:opacity-70">
          {desc.text}
        </span>
        <span className="opacity-50">·</span>
        <LocalTime
          iso={event.at}
          format="messageTime"
          className="shrink-0 tabular-nums opacity-70"
        />
      </div>
    </div>
  );
}

/** Memoized — the timeline re-renders on every socket frame, but an activity
 *  entry only changes when its event object identity does. */
export const ActivityEntry = memo(ActivityEntryImpl);
