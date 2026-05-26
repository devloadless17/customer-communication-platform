"use client";

import { memo } from "react";
import {
  ArrowRightLeft,
  CircleDot,
  Tag,
  Trash2,
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

/** Bold actor name fragment, reused across every kind. `System` for automation. */
function actor(name: string | null): string {
  return name ?? "System";
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
  const who = actor(e.actorName);
  switch (e.kind) {
    case "assigned": {
      const toName = e.assignedToName;
      // assignedToName === null → unassigned; a string → assigned to them.
      if (toName == null) {
        return {
          icon: UserMinus,
          text: (
            <>
              <b>{who}</b> unassigned the conversation
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
            <b>{who}</b> self-assigned
          </>
        ) : (
          <>
            <b>{who}</b> assigned to <b>{toName}</b>
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
            <b>{who}</b> {STATUS_VERB[status]}
          </>
        ),
      };
    }
    case "stage_changed": {
      const from = (e.before?.stageName as string | null | undefined) ?? null;
      const to = (e.after?.stageName as string | null | undefined) ?? null;
      return {
        icon: ArrowRightLeft,
        text: (
          <>
            <b>{who}</b> moved stage{" "}
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
            <b>{who}</b> added tag {name ? <b>{name}</b> : <i>tag</i>}
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
            <b>{who}</b> removed tag {name ? <b>{name}</b> : <i>tag</i>}
          </>
        ),
      };
    }
    case "note_deleted":
      return {
        icon: Trash2,
        text: (
          <>
            <b>{who}</b> deleted an internal note
          </>
        ),
      };
    // note_added is intentionally NOT rendered as a pill: the note card itself
    // already shows inline, so a "added a note" line would be redundant noise.
    case "note_added":
      return null;
    default:
      return null;
  }
}

function ActivityEntryImpl({ event }: { event: ConversationActivityEvent }) {
  const desc = describe(event);
  if (!desc) return null;
  const Icon = desc.icon;
  return (
    <div className="my-1 flex w-full justify-center px-4">
      <div className="inline-flex max-w-2xl items-center gap-1 text-[10px] leading-tight text-muted-foreground">
        <Icon className="size-2.5 shrink-0 opacity-70" />
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
