/**
 * Channel-switch skeleton.
 *
 * `/team/[channelId]` is a dynamic RSC route: three server fetches (channel,
 * message page, pins) run before the page can stream. Without a loading
 * boundary the router held the PREVIOUS channel on screen for that whole
 * round-trip, so a click read as "nothing happened, then everything jumped" —
 * the main reason switching channels felt heavy. The boundary also gives
 * `<Link>` something to prefetch.
 *
 * Deliberately a quiet, low-contrast shell that mirrors the real feed's
 * geometry (header bar, avatar + two text rows per message, composer) so the
 * swap to real content lands in the same places — no layout shift, no flash.
 */
function Row({ short = false }: { short?: boolean }) {
  return (
    <div className="flex gap-3 px-4 py-1.5">
      <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
      <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
        <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        <div
          className="h-3 animate-pulse rounded bg-muted/70"
          style={{ width: short ? "35%" : "62%" }}
        />
      </div>
    </div>
  );
}

export default function ChannelLoading() {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" aria-busy="true">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="size-4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      </div>
      {/* Bottom-anchored: a real feed opens scrolled to the newest message, so
          top-anchored placeholders would visibly jump on hand-off. */}
      <div className="flex flex-1 flex-col justify-end space-y-1 overflow-hidden pb-2">
        <Row />
        <Row short />
        <Row />
        <Row short />
        <Row />
      </div>
      <div className="border-t border-border p-3">
        <div className="h-10 w-full animate-pulse rounded-lg bg-muted/60" />
      </div>
      <span className="sr-only">Loading channel…</span>
    </div>
  );
}
