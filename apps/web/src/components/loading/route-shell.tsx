/**
 * Generic route-loading skeleton.
 *
 * Layout-agnostic placeholder used by every top-level segment's
 * `loading.tsx`. Mirrors the broad shape of an app shell (sidebar +
 * content column with a header strip + body lines) so a hard nav into
 * any route paints immediately instead of going blank while the RSC
 * gathers data.
 *
 * For routes with a more specific layout (the inbox, for example), use
 * a custom skeleton that mirrors that layout exactly — this is the
 * fallback for routes that don't justify their own.
 */
export function RouteShellSkeleton({
  withSidebarRail = true,
  bodyLines = 6,
}: {
  /** Show the slim app-sidebar column on the left. */
  withSidebarRail?: boolean;
  /** Number of placeholder body rows. */
  bodyLines?: number;
}) {
  return (
    <div
      aria-busy
      aria-label="Loading"
      className="flex h-svh w-full overflow-hidden bg-background text-foreground"
    >
      {withSidebarRail && (
        <div className="hidden h-full w-16 shrink-0 border-r border-border bg-muted/30 md:block" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="ml-auto h-8 w-24 animate-pulse rounded-md bg-muted/70" />
        </div>
        <div className="flex flex-1 flex-col gap-4 px-6 py-6">
          {Array.from({ length: bodyLines }, (_, i) => (
            <div
              key={i}
              className="flex items-center gap-3"
              style={{ width: `${100 - i * 4}%` }}
            >
              <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
