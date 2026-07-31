import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inbox entry skeleton — the boundary the inbox LAYOUT's doc-comment always
 * described ("the page streams in behind `loading.tsx`") but that never
 * existed: entering /inbox blocked navigation on an 11-way server fan-out
 * with the previous route frozen on screen. Mirrors the two panes the page
 * hands off to (conversation list + thread), quiet and geometry-stable so
 * the real content lands without a jump. The sub-sidebar is layout-level and
 * already painted.
 */
function ConversationRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-48 bg-muted/70" />
      </div>
    </div>
  );
}

export default function InboxLoading() {
  return (
    <div className="flex h-full min-w-0 flex-1" aria-busy="true">
      <div className="hidden w-80 shrink-0 flex-col border-r border-border md:flex">
        <div className="border-b border-border px-3 py-3">
          <Skeleton className="h-8 w-full rounded-lg bg-muted/60" />
        </div>
        <div className="flex-1 overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <ConversationRow key={i} />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <Skeleton className="h-4 w-44 bg-muted/60" />
      </div>
      <span className="sr-only">Loading inbox…</span>
    </div>
  );
}
