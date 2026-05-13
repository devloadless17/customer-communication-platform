/**
 * Contacts skeleton — toolbar + table-like rows. The contacts page has a
 * dense table; matching it keeps the eye anchored while data loads.
 */
export default function ContactsLoading() {
  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="h-7 w-32 animate-pulse rounded bg-muted/60" />
          <div className="h-5 w-14 animate-pulse rounded-full bg-muted/40" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-24 animate-pulse rounded-md bg-muted/40" />
          <div className="h-9 w-24 animate-pulse rounded-md bg-muted/40" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted/50" />
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-border px-6 py-3">
        <div className="h-8 w-72 animate-pulse rounded-md bg-muted/50" />
        <div className="h-8 w-24 animate-pulse rounded-md bg-muted/40" />
      </div>

      <div className="flex-1 overflow-hidden px-6 py-4">
        <div className="flex flex-col gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 rounded-md border border-border bg-card px-4 py-3"
            >
              <div className="size-4 animate-pulse rounded bg-muted/40" />
              <div className="size-9 animate-pulse rounded-full bg-muted/50" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-3.5 w-44 animate-pulse rounded bg-muted/60" />
                <div className="h-2.5 w-32 animate-pulse rounded bg-muted/40" />
              </div>
              <div className="h-3 w-24 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted/40" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-muted/30" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
