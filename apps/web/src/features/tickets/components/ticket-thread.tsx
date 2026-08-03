"use client";

import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Loader2, MessagesSquare } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { useTzNow } from "@/providers/tz-provider";
import { calendarDayKey, cn, formatDaySeparator, initials } from "@ccp/shared/utils";
import type { TicketThreadMessage } from "@ccp/shared/tickets/types";

import { TicketAttachmentRow } from "./ticket-attachment-row";

/**
 * The ticket THREAD — the conversation between the departments working one
 * customer's issue.
 *
 * This is the page's main pane, not a section of the audit log. The log answers
 * "who changed what"; this answers "what did Billing actually say", and mixing
 * them meant scrolling past twenty status flips to find one reply.
 *
 * Deliberately its OWN grouping/day-separator code rather than a shared helper
 * lifted out of team chat: that surface is heavily tuned around edits,
 * reactions and a 500-message virtualized window, and rewiring it to share ~25
 * lines with a 200-message capped thread is risk with no user-visible gain.
 * Revisit if a third caller appears.
 */

/** A run of consecutive messages from one author breaks after this long. */
const GROUP_GAP_MS = 5 * 60 * 1000;

export function TicketThread({
  messages,
  busy,
  /** First message this reader hadn't seen — the "New replies" divider. */
  unreadSinceMessageId,
  /** Who else reads this. Empty on an unshared ticket. */
  audience,
  onRetry,
}: {
  messages: TicketThreadMessage[];
  busy: boolean;
  unreadSinceMessageId: string | null;
  audience: string;
  onRetry: (message: TicketThreadMessage) => void;
}) {
  const { tz, now } = useTzNow();
  // `now` ticks every 60s but the labels only change at LOCAL midnight — read
  // it through a ref and key the memo on the calendar day, or every tick
  // re-formats the whole thread.
  const nowRef = useRef(now);
  nowRef.current = now;
  const todayKey = useMemo(() => calendarDayKey(now, tz), [tz, now]);

  const dayLabels = useMemo(() => {
    const labels: Array<string | null> = new Array(messages.length);
    const byDay = new Map<string, string>();
    let prev: string | null = null;
    for (let i = 0; i < messages.length; i++) {
      const iso = messages[i]!.createdAt;
      const key = calendarDayKey(Date.parse(iso), tz);
      let label = byDay.get(key);
      if (label === undefined) {
        label = formatDaySeparator(iso, tz, nowRef.current);
        byDay.set(key, label);
      }
      labels[i] = label !== prev ? label : null;
      prev = label;
    }
    return labels;
    // `todayKey` is a recompute TRIGGER (local midnight), not a value read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, tz, todayKey]);

  /** `continues[i]` — message i joins the run above it, so it renders without a
   *  repeated avatar and name. This is what makes the feed read as a chat. */
  const continues = useMemo(() => {
    const flags: boolean[] = new Array(messages.length).fill(false);
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1]!;
      const cur = messages[i]!;
      // A day separator or the unread divider must sit above a full header.
      if (dayLabels[i] !== null) continue;
      if (cur.id === unreadSinceMessageId) continue;
      if (!cur.authorUserId || cur.authorUserId !== prev.authorUserId) continue;
      // A failed row stands alone so its Retry affordance always shows.
      if (cur.failed || prev.failed) continue;
      const gap = Date.parse(cur.createdAt) - Date.parse(prev.createdAt);
      // NaN or negative (an optimistic row's local clock vs a server stamp) —
      // a wrong group is worse than none.
      if (!(gap >= 0) || gap > GROUP_GAP_MS) continue;
      flags[i] = true;
    }
    return flags;
  }, [messages, dayLabels, unreadSinceMessageId]);

  // Pin to the newest message on open and on arrival. ~10 lines instead of the
  // inbox's useChatScroll: this thread is capped at 200 with no pagination, so
  // there is no anchor-preserving prepend to solve for.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center">
        <MessagesSquare aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-xs font-medium">No replies yet</p>
        <p className="max-w-xs text-2xs leading-relaxed text-muted-foreground">
          {audience
            ? `Anything you write here goes to ${audience}. The customer never sees it.`
            : "Talk through this ticket here. Escalate it to bring another workspace into the same thread."}
        </p>
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-0.5">
      {messages.map((m, i) => (
        <li key={m.id}>
          {dayLabels[i] ? (
            <div className="flex items-center gap-2 py-2">
              <span className="h-px flex-1 bg-border" />
              <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                {dayLabels[i]}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null}

          {m.id === unreadSinceMessageId ? (
            <div className="flex items-center gap-2 py-1.5">
              <span className="h-px flex-1 bg-primary/40" />
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-3xs font-medium text-primary">
                New replies
              </span>
              <span className="h-px flex-1 bg-primary/40" />
            </div>
          ) : null}

          <div
            className={cn(
              "flex gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/40",
              m.pending && "opacity-60",
            )}
          >
            {continues[i] ? (
              <span className="w-7 shrink-0" aria-hidden />
            ) : (
              <Avatar className="mt-0.5 size-7 shrink-0">
                {m.authorAvatarUrl ? (
                  <AvatarImage src={m.authorAvatarUrl} alt="" />
                ) : null}
                <AvatarFallback seed={m.authorUserId ?? m.id} className="text-3xs">
                  {initials(m.authorName ?? "Automation")}
                </AvatarFallback>
              </Avatar>
            )}

            <div className="min-w-0 flex-1">
              {continues[i] ? null : (
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-xs font-medium">{m.authorName ?? "Automation"}</span>
                  {/* WHICH department spoke — the reason this thread exists.
                      Resolved server-side, because the reader's roster only
                      holds their own workspace's people. */}
                  {m.authorWorkspaceName ? (
                    <span className="rounded bg-muted px-1 py-px text-3xs text-muted-foreground">
                      {m.authorWorkspaceName}
                    </span>
                  ) : null}
                  <span className="text-3xs text-muted-foreground">
                    <LocalTime iso={m.createdAt} format="listTime" />
                  </span>
                  {m.pending ? (
                    <Loader2 aria-hidden className="size-3 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
              )}

              {/* A reply may be evidence with no caption — render nothing
                  rather than an empty line that pushes the files down. */}
              {m.body ? (
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{m.body}</p>
              ) : null}

              {m.attachments.length > 0 ? (
                <ul className="mt-1 flex max-w-md flex-col gap-1">
                  {m.attachments.map((a) => (
                    <TicketAttachmentRow key={a.id} attachment={a} busy={busy} preview />
                  ))}
                </ul>
              ) : null}

              {m.failed ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-3xs text-destructive">
                  <AlertTriangle aria-hidden className="size-3" />
                  Didn&rsquo;t send.
                  <button
                    type="button"
                    onClick={() => onRetry(m)}
                    className="cursor-pointer font-medium underline underline-offset-2"
                  >
                    Retry
                  </button>
                </p>
              ) : null}
            </div>
          </div>
        </li>
      ))}
      <div ref={endRef} />
    </ol>
  );
}
