/**
 * Inbox shell skeleton — fires on a cold navigation to /inbox while the
 * server layout awaits session + conversations + members + snippets + stages.
 * Matches the production three-pane layout (sidebar, conversation list,
 * main) so the swap-in lands without a layout shift.
 */
export default function InboxLoading() {
  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      {/* Sidebar pane */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <div className="size-8 shrink-0 animate-pulse rounded-lg bg-muted/50" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
            <div className="h-2 w-16 animate-pulse rounded bg-muted/30" />
          </div>
        </div>
        <div className="flex flex-col gap-3 px-3 pt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 px-1">
              <div className="size-4 animate-pulse rounded bg-muted/40" />
              <div
                className="h-3 animate-pulse rounded bg-muted/40"
                style={{ width: 56 + ((i * 23) % 64) }}
              />
            </div>
          ))}
        </div>
      </aside>

      {/* Conversation list pane */}
      <div className="flex w-95 shrink-0 flex-col bg-background">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 pt-4 pb-3">
          <div className="flex flex-col gap-1.5">
            <div className="h-3.5 w-24 animate-pulse rounded bg-muted/60" />
            <div className="h-2.5 w-32 animate-pulse rounded bg-muted/30" />
          </div>
          <div className="size-8 animate-pulse rounded-md bg-muted/30" />
        </header>
        <div className="px-3 pt-3 pb-2">
          <div className="h-9 w-full animate-pulse rounded-md bg-muted/30" />
        </div>
        <ul className="flex flex-col gap-0.5 px-1.5 pb-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <li key={i} className="flex items-start gap-3 rounded-md px-2.5 py-2.5">
              <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted/50" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <div
                    className="h-3 animate-pulse rounded bg-muted/60"
                    style={{ width: 80 + ((i * 17) % 80) }}
                  />
                  <div className="ml-auto h-2 w-10 animate-pulse rounded bg-muted/30" />
                </div>
                <div
                  className="h-2.5 animate-pulse rounded bg-muted/30"
                  style={{ width: 120 + ((i * 31) % 120) }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Main pane — empty placeholder. Inbox/page (empty state) shows here once
          the layout resolves; the conversation page replaces it on click. */}
      <main className="flex-1 border-l border-border bg-background" />
    </div>
  );
}
