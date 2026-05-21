/**
 * Placeholder rows shown on first load and on filter change — calmer than a
 * centered spinner because the list keeps its shape while data arrives.
 */
export function ContactRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <ul className="animate-pulse divide-y divide-border">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-2.5">
          <span className="size-4 shrink-0 rounded bg-muted" />
          <span className="size-8 shrink-0 rounded-full bg-muted" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-40 max-w-[60%] rounded bg-muted" />
            <span className="h-2.5 w-24 max-w-[35%] rounded bg-muted/70" />
          </div>
          <span className="hidden h-5 w-16 rounded-full bg-muted sm:block" />
        </li>
      ))}
    </ul>
  );
}
