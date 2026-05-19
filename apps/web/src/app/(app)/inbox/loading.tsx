/**
 * Inbox loading shell — renders inside `app/(app)/layout.tsx`'s children
 * slot, AFTER the AppRail. The shared (app) layout keeps the AppRail
 * mounted across every suspense boundary, so clicking the Inbox icon
 * from any other section no longer flashes a white screen — only the
 * area to the right of the rail swaps to this skeleton, then to the
 * real shell.
 *
 * The columns below mirror inbox-shell's responsive widths so when the
 * real shell mounts there's no horizontal jump.
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

      {/* Conversation list column — w-64 (~256px) below md+, w-64 (~256px)
          at lg, w-80 (~320px) at xl+ — mirrors conversation-list.tsx
          so there's no horizontal jump when the real shell hydrates. */}
      <div className="flex h-full w-64 shrink-0 flex-col border-r border-border xl:w-80">
        <div className="border-b border-border px-3 py-3">
          <div className="h-8 w-full animate-pulse rounded-md bg-muted" />
        </div>
        <div className="flex flex-col gap-0.5 p-1.5">
          {Array.from({ length: 10 }, (_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-md px-2 py-3"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-4/5 animate-pulse rounded bg-muted/70" />
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
