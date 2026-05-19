/**
 * Settings page skeleton — the sidebar is in the layout and stays put;
 * only the main panel needs a placeholder.
 */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted/40" />
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-muted/40" />
            <div className="h-9 w-full animate-pulse rounded-md bg-muted/50" />
          </div>
        ))}
        <div className="mt-2 flex justify-end">
          <div className="h-9 w-28 animate-pulse rounded-md bg-muted/50" />
        </div>
      </div>
    </div>
  );
}
