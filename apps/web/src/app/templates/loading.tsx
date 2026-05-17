/**
 * Templates index skeleton — header, filter toolbar, grid of card placeholders.
 * Matches the real grid (3 cols at lg) so layout doesn't jump on swap.
 */
export default function TemplatesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-2">
        <div className="h-7 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-3.5 w-3/5 animate-pulse rounded bg-muted/40" />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="h-9 w-72 animate-pulse rounded-md bg-muted/50" />
        <div className="h-9 w-72 animate-pulse rounded-md bg-muted/40" />
        <div className="ml-auto flex gap-2">
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted/40" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted/40" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted/50" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="size-7 animate-pulse rounded-md bg-muted/50" />
                <div className="flex flex-col gap-1.5">
                  <div className="h-3.5 w-28 animate-pulse rounded bg-muted/60" />
                  <div className="h-2.5 w-20 animate-pulse rounded bg-muted/40" />
                </div>
              </div>
              <div className="h-4 w-16 animate-pulse rounded-full bg-muted/40" />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-11/12 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-muted/40" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
