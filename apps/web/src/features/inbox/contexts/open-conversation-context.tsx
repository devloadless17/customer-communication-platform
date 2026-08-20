"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";

/**
 * "TAKE ME TO THAT CHAT", from anywhere inside the inbox shell.
 *
 * WHY THIS EXISTS — a link to `/inbox?c=<id>` from INSIDE the shell is a dead
 * control about half the time, and the reason is worth writing down because it
 * is invisible at the call site.
 *
 * The shell owns the open conversation in client state and mirrors it into the
 * URL with `history.replaceState` (see openConversation) — deliberately, so
 * Back doesn't walk through every chat you clicked. But replaceState is
 * invisible to the Next router AND to the RSC props, so after any in-app chat
 * switch `initialActiveConversationId` still holds whatever the last REAL
 * navigation resolved. The shell then only re-syncs when that prop actually
 * changes (`lastSyncedInitialId !== initialActiveConversationId`).
 *
 * So: you deep-link to chat B, browse to chat A through the list, then click a
 * link pointing back at B. The prop is still B, the guard sees no change, and
 * nothing happens — not once, not on the tenth click. It only ever "works" when
 * the target happens to differ from the last navigated id, which is exactly the
 * "sometimes it moves me, sometimes it does nothing" report.
 *
 * The fix is to stop routing at all for a switch the shell can do itself:
 * `openConversation` is the single authoritative path (cache, prefetch, URL
 * mirror, read-state), and it is instant because a cached thread needs no
 * server round-trip.
 *
 * The context is NULL outside the shell — the /calls page, a ticket detail —
 * where reaching the inbox genuinely IS a navigation. `OpenConversationLink`
 * picks the right one, so a shared component (CallHistoryRow renders in both
 * places) doesn't have to care which side it is on.
 */
type OpenConversation = (conversationId: string) => void;

const OpenConversationContext = createContext<OpenConversation | null>(null);

export function OpenConversationProvider({
  open,
  children,
}: {
  /** Must be referentially stable — it is the raw context value. */
  open: OpenConversation;
  children: ReactNode;
}) {
  return (
    <OpenConversationContext.Provider value={open}>
      {children}
    </OpenConversationContext.Provider>
  );
}

/** `null` when rendered outside the inbox shell — navigate instead. */
export function useOpenConversation(): OpenConversation | null {
  return useContext(OpenConversationContext);
}

/**
 * An "open this chat" control that switches threads in place inside the shell
 * and falls back to a real navigation everywhere else. Renders a <button> in
 * the first case because there is no URL to hand to the browser — nothing to
 * middle-click or copy — and a <Link> in the second, where there is.
 */
export function OpenConversationLink({
  conversationId,
  className,
  title,
  ariaLabel,
  children,
}: {
  conversationId: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const open = useOpenConversation();

  if (open) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        aria-label={ariaLabel}
        onClick={(e) => {
          // These controls sit inside clickable rows on both surfaces; without
          // this the row's own handler also fires.
          e.preventDefault();
          e.stopPropagation();
          open(conversationId);
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <Link
      href={`/inbox?c=${encodeURIComponent(conversationId)}`}
      className={className}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}
