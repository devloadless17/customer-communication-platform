/**
 * Inbox loading shell — renders inside `app/(app)/layout.tsx`'s children
 * slot, AFTER the AppRail. The shared (app) layout keeps the AppRail
 * mounted across every suspense boundary, so clicking the Inbox icon
 * from any other section no longer flashes a white screen — only the
 * area to the right of the rail swaps to this skeleton, then to the
 * real shell.
 *
 * The columns + per-row heights below mirror inbox-shell + conversation-list
 * exactly so the swap from skeleton → real list has zero vertical jump.
 * If you change the conversation list's header/search/row padding, update
 * the matching offsets here too.
 */
export default function Loading() {
  return (
    <div
      aria-busy
      aria-label="Loading inbox"
      className="flex h-svh w-full overflow-hidden bg-background text-foreground"
    >
      {/* InboxSubSidebar column — only shown at lg+ (1024px); below that
          it lives in the hamburger drawer. w-40 at lg, w-52 at xl+.
          Matches sub-sidebar.tsx. */}
      <div className="hidden h-full shrink-0 border-r border-border bg-muted/20 lg:block lg:w-40 xl:w-52" />

      {/* Conversation list column — width matches conversation-list.tsx
          exactly: w-64 below xl, w-80 at xl+. The inner structure mirrors
          the real list (header → search → rows of ~76px each) so when the
          real shell hydrates there's no vertical jump. */}
      <div className="flex h-full w-full shrink-0 flex-col border-r border-border md:w-64 lg:w-64 xl:w-80">
        {/* Header — matches `px-4 pt-4 pb-3` + h1 + subtitle in conversation-list.tsx. */}
        <div className="border-b border-border px-4 pt-4 pb-3">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="mt-1.5 h-2.5 w-16 animate-pulse rounded bg-muted/60" />
        </div>
        {/* Search input — matches `px-3 pt-3 pb-2` + h-9 input. */}
        <div className="px-3 pt-3 pb-2">
          <div className="h-9 w-full animate-pulse rounded-md bg-muted/60" />
        </div>
        {/* Row container — matches `px-1.5 pb-3` in the scroll viewport. */}
        <div className="flex flex-col gap-0 px-1.5 pb-3">
          {Array.from({ length: 10 }, (_, i) => (
            <div
              key={i}
              // Per-row geometry matches ConversationListItem exactly:
              // gap-3, px-2.5 py-2.5, three stacked lines next to a size-10
              // avatar. Total height settles around 76px so virtualizer
              // measurements line up.
              className="flex gap-3 rounded-lg px-2.5 py-2.5"
            >
              <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="ml-auto h-2.5 w-8 animate-pulse rounded bg-muted/60" />
                </div>
                <div className="h-2.5 w-4/5 animate-pulse rounded bg-muted/60" />
                <div className="mt-0.5 h-2.5 w-1/3 animate-pulse rounded bg-muted/40" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Thread workspace — left empty so the real content paints into a
          quiet pane rather than a flickering skeleton. */}
      <div className="flex min-w-0 flex-1 items-center justify-center text-xs text-muted-foreground/40">
        Loading conversation…
      </div>
    </div>
  );
}
