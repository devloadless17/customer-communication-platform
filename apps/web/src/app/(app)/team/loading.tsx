/**
 * Team feed loading shell — the fallback for the team PAGE only. Renders inside
 * `app/(app)/team/layout.tsx`'s `<main>`, AFTER the AppRail (from the (app)
 * layout) AND the channel-list sidebar (from the team layout). Both stay
 * mounted across this suspense boundary, so clicking the Team rail icon — or
 * the `/team` → default-channel redirect — paints the stable rail + channel
 * list immediately and only the feed swaps to this skeleton, then to the real
 * channel. Before this there was no team loading.tsx, so navigation blocked on
 * the redirect + fetches and the whole region appeared at once.
 *
 * Mirrors the channel workspace: header bar → message rows → composer.
 */
export default function TeamLoading() {
  return (
    <div
      aria-busy
      aria-label="Loading channel"
      className="flex h-svh min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      {/* Channel header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="size-4 animate-pulse rounded bg-muted/60" />
        <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
        <div className="ml-auto flex items-center gap-2">
          <div className="size-7 animate-pulse rounded-md bg-muted/40" />
          <div className="size-7 animate-pulse rounded-md bg-muted/40" />
          <div className="h-7 w-20 animate-pulse rounded-md bg-muted/30" />
        </div>
      </div>

      {/* Message feed */}
      <div className="flex flex-1 flex-col justify-end gap-5 overflow-hidden px-4 py-5">
        {[260, 180, 320, 150, 240, 200].map((width, i) => (
          <div key={i} className="flex gap-3">
            <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted/50" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                <div className="h-2.5 w-12 animate-pulse rounded bg-muted/30" />
              </div>
              <div
                className="h-3.5 max-w-full animate-pulse rounded bg-muted/40"
                style={{ width }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-border px-4 py-3">
        <div className="h-11 w-full animate-pulse rounded-lg bg-muted/30" />
      </div>
    </div>
  );
}
