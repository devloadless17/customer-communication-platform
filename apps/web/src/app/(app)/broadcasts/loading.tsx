/**
 * Broadcasts skeleton — header with tabs, then a list of broadcast rows.
 */
export default function BroadcastsLoading() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-8 w-28 animate-pulse rounded-md bg-muted/50" />
          <div className="h-8 w-20 animate-pulse rounded-md bg-muted/40" />
        </div>
        <div className="h-9 w-36 animate-pulse rounded-md bg-muted/50" />
      </header>

      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <div className="size-9 animate-pulse rounded-md bg-muted/50" />
              <div className="flex flex-col gap-1.5">
                <div className="h-3.5 w-48 animate-pulse rounded bg-muted/60" />
                <div className="h-2.5 w-36 animate-pulse rounded bg-muted/40" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-5 w-20 animate-pulse rounded-full bg-muted/40" />
              <div className="size-8 animate-pulse rounded-md bg-muted/30" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
