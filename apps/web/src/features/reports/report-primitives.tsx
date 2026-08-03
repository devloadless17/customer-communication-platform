"use client";

/**
 * Shared building blocks for the /reports pages (overview + team). Extracted
 * from reports-client.tsx when /reports/team became a second consumer — the
 * markup is deliberately identical so the two tabs read as one dashboard.
 */

export function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86_400)}d ${Math.round((sec % 86_400) / 3600)}h`;
}

/** Fill absent days so a quiet weekend renders as zero bars, not a gap the
 *  x-axis silently skips (which would make Mon look adjacent to Fri). */
export function fillDays<K extends string>(
  daily: Array<{ day: string } & Record<K, number>>,
  from: Date,
  to: Date,
  keys: readonly K[],
): Array<{ day: string; label: string } & Record<K, number>> {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: Array<{ day: string; label: string } & Record<K, number>> = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  // The last day actually INSIDE the range — the midnight of the instant just
  // before `to`. The two range shapes end differently: a custom range's `to` is
  // the day AFTER the last one selected (`computeReportRange` adds 24h, an
  // exclusive end), while a preset's is simply "now". Comparing a midnight
  // cursor against the raw `to` therefore emitted one extra, always-empty
  // trailing column on every daily chart for a custom range. Stepping back a
  // millisecond first is correct for both without special-casing either.
  const last = new Date(to.getTime() - 1);
  last.setHours(0, 0, 0, 0);
  while (cursor <= last) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${d}`;
    const row = byDay.get(key);
    const filled = {
      day: key,
      label: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    } as { day: string; label: string } & Record<K, number>;
    for (const k of keys) filled[k] = (row?.[k] ?? 0) as (typeof filled)[K];
    out.push(filled);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  /** null = still loading (skeleton). */
  value: string | null;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5">
      {value === null ? (
        <div className="h-7 w-14 animate-pulse rounded bg-muted/40" />
      ) : (
        <div className="tabular-nums text-2xl font-semibold">{value}</div>
      )}
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && value !== null && <div className="text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="tabular-nums text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  /** Optional right-aligned header slot (a link, a metric select). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-6 animate-pulse rounded bg-muted/30" />
      ))}
    </div>
  );
}

export function PanelEmpty({ message }: { message: string }) {
  return <p className="py-4 text-center text-xs text-muted-foreground">{message}</p>;
}
