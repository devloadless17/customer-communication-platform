/**
 * Inbox loading shell. Renders while the RSC at /inbox is gathering data
 * (session + 8 catalogs + active thread). Without this Next.js shows
 * either a blank screen or the previous route until the entire RSC payload
 * is ready, which on a hard refresh is the felt latency that drove the
 * "list flashes empty" perf finding.
 *
 * The skeleton mirrors the real inbox layout (AppSidebar column,
 * conversation list column, thread workspace pane) at fixed widths so
 * when the real shell mounts there's no layout shift.
 */
export default function Loading() {
  return (
    <div
      aria-busy
      aria-label="Loading inbox"
      className="flex h-svh w-full overflow-hidden bg-background text-foreground"
    >
      {/* AppSidebar column — 64px chrome */}
      <div className="hidden h-full w-16 shrink-0 border-r border-border bg-muted/30 md:block" />

      {/* Conversation list column — `w-95` (~380px) matches the real list
          in conversation-list.tsx exactly so there's no horizontal jump
          the moment the real shell hydrates. */}
      <div className="flex h-full w-95 shrink-0 flex-col border-r border-border">
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
