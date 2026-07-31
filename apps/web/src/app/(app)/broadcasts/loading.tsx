import { Skeleton } from "@/components/ui/skeleton";

/**
 * Broadcasts entry skeleton — quiet header + row shells mirroring the list the
 * page hands off to, so navigation paints immediately instead of freezing the
 * previous route while the server fan-out resolves.
 */
export default function BroadcastsLoading() {
  return (
    <div className="flex h-full flex-col gap-4 p-6" aria-busy="true">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-32 rounded-lg bg-muted/60" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full bg-muted/60" />
        ))}
      </div>
      <span className="sr-only">Loading broadcasts…</span>
    </div>
  );
}
