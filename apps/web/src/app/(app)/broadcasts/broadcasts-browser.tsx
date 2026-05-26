"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  List,
  Search,
} from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import type { BroadcastListItem } from "@/lib/api/queries";

import { BroadcastStatusBadge } from "./broadcast-status-badge";
import { BroadcastDeleteButton } from "./broadcast-delete-button";

/**
 * Client shell for the broadcasts page. SSR seeds `initial`; this island owns
 * the status-filter rail, search, and the Table/Calendar view toggle. Status
 * filtering + search refetch server-side (`/api/broadcasts?status=&search=`)
 * so the list reflects ALL matching rows, not just the seeded slice.
 *
 * Plain React + a debounced fetch — no React Query, matching the app's stack.
 */

export type BroadcastStatusFilter =
  | "all"
  | "scheduled"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type BroadcastView = "table" | "calendar";

const VALID_STATUSES: ReadonlySet<BroadcastStatusFilter> = new Set([
  "all",
  "scheduled",
  "queued",
  "running",
  "completed",
  "failed",
]);

export const BROADCASTS_STATUS_COOKIE = "broadcasts-status";
export const BROADCASTS_SEARCH_COOKIE = "broadcasts-search";
export const BROADCASTS_VIEW_COOKIE = "broadcasts-view";

/** Parse the persisted status cookie. Defaults to "all" on missing / invalid. */
export function parseBroadcastStatus(raw: string | undefined): BroadcastStatusFilter {
  if (raw && VALID_STATUSES.has(raw as BroadcastStatusFilter)) {
    return raw as BroadcastStatusFilter;
  }
  return "all";
}

/** Parse the persisted view cookie. Defaults to "table". */
export function parseBroadcastView(raw: string | undefined): BroadcastView {
  return raw === "calendar" ? "calendar" : "table";
}

const FILTERS: { id: BroadcastStatusFilter; label: string; dot: string }[] = [
  { id: "all", label: "All", dot: "bg-sky-500" },
  { id: "scheduled", label: "Scheduled", dot: "bg-indigo-500" },
  { id: "queued", label: "Queued", dot: "bg-muted-foreground" },
  { id: "running", label: "In progress", dot: "bg-emerald-400" },
  { id: "completed", label: "Completed", dot: "bg-emerald-600" },
  { id: "failed", label: "Failed", dot: "bg-destructive" },
];

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function writeCookie(name: string, value: string) {
  // `encodeURIComponent` on values so a search with `;` or `=` doesn't break
  // the cookie header. The cookies are reserved for THIS surface; no
  // collision with the inbox's cookies (different names).
  const v = encodeURIComponent(value);
  document.cookie = `${name}=${v}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

export function BroadcastsBrowser({
  initial,
  canManage,
  initialFilter = "all",
  initialSearch = "",
  initialView = "table",
}: {
  initial: BroadcastListItem[];
  canManage: boolean;
  /** SSR-seeded from the `broadcasts-status` cookie. The seed `initial` was
   *  fetched for this exact filter so the first paint is correct. */
  initialFilter?: BroadcastStatusFilter;
  /** SSR-seeded from the `broadcasts-search` cookie. Same as above —
   *  `initial` was fetched matching this string. */
  initialSearch?: string;
  /** SSR-seeded from the `broadcasts-view` cookie. View is purely visual
   *  (table vs calendar render of the same rows), so no refetch tied to it. */
  initialView?: BroadcastView;
}) {
  const [rows, setRows] = useState<BroadcastListItem[]>(initial);
  const [filter, setFilterState] = useState<BroadcastStatusFilter>(initialFilter);
  const [search, setSearchState] = useState(initialSearch);
  const [view, setViewState] = useState<BroadcastView>(initialView);
  const [loading, setLoading] = useState(false);

  // Cookie-writing wrappers. Keep the state + cookie in lockstep; SSR reads
  // the cookie on the next request so a hard refresh restores the same view.
  const setFilter = (next: BroadcastStatusFilter) => {
    setFilterState(next);
    writeCookie(BROADCASTS_STATUS_COOKIE, next);
  };
  const setSearch = (next: string) => {
    setSearchState(next);
    writeCookie(BROADCASTS_SEARCH_COOKIE, next);
  };
  const setView = (next: BroadcastView) => {
    setViewState(next);
    writeCookie(BROADCASTS_VIEW_COOKIE, next);
  };

  // Debounced server refetch on filter/search change. Skip the very first run
  // (SSR `initial` was fetched matching the persisted filter + search, so
  // they're already current).
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (search.trim()) params.set("search", search.trim());
      const qs = params.toString();
      void apiFetch(`/api/broadcasts${qs ? `?${qs}` : ""}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ broadcasts: BroadcastListItem[] }>) : null))
        .then((body) => {
          if (cancelled || !body) return;
          setRows(body.broadcasts);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [filter, search]);

  return (
    <div className="flex flex-col gap-4">
      {/* Controls: filter rail + search + view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.id
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", f.dot)} />
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or template…"
              className="w-56 rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setView("table")}
              aria-label="Table view"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                view === "table"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <List className="size-3.5" />
              Table
            </button>
            <button
              type="button"
              onClick={() => setView("calendar")}
              aria-label="Calendar view"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                view === "calendar"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarDays className="size-3.5" />
              Calendar
            </button>
          </div>
        </div>
      </div>

      {view === "table" ? (
        <TableView rows={rows} canManage={canManage} loading={loading} />
      ) : (
        <CalendarView rows={rows} />
      )}
    </div>
  );
}

function TableView({
  rows,
  canManage,
  loading,
}: {
  rows: BroadcastListItem[];
  canManage: boolean;
  loading: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
        {loading ? "Loading…" : "No broadcasts match this filter."}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-xl border border-border bg-card transition-opacity",
        loading && "opacity-60",
      )}
    >
      <table className="w-full min-w-180 text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">Broadcast</th>
            <th className="px-4 py-2.5 text-left font-medium">Audience</th>
            <th className="px-4 py-2.5 text-left font-medium">Status</th>
            <th className="px-4 py-2.5 text-left font-medium">Progress</th>
            <th className="px-4 py-2.5 text-left font-medium">When</th>
            <th className="px-4 py-2.5 text-right font-medium" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr
              key={b.id}
              className="border-b border-border last:border-b-0 hover:bg-accent/30"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/broadcasts/${b.id}`}
                  className="font-medium text-foreground hover:text-primary"
                >
                  {b.name || b.templateName}
                </Link>
                <div className="text-[11px] text-muted-foreground">
                  {b.name ? `${b.templateName} · ` : ""}
                  {b.templateLanguage} · by {b.createdByName}
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {b.audienceMode === "all"
                  ? `All (${b.totalCount})`
                  : `${b.totalCount} selected`}
              </td>
              <td className="px-4 py-3">
                <BroadcastStatusBadge status={b.status} />
              </td>
              <td className="px-4 py-3">
                <ProgressBar sent={b.sentCount} failed={b.failedCount} total={b.totalCount} />
              </td>
              <td className="px-4 py-3 text-[12px] text-muted-foreground">
                {b.status === "scheduled" && b.scheduledAt ? (
                  <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                    <CalendarDays className="size-3.5" />
                    <LocalTime iso={b.scheduledAt} format="listTime" />
                  </span>
                ) : (
                  <LocalTime iso={b.createdAt} format="listTime" />
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <div className="inline-flex items-center gap-1">
                  {canManage && (
                    <Link
                      href={`/broadcasts/new?from=${b.id}`}
                      aria-label="Duplicate broadcast"
                      title="Duplicate"
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Copy className="size-3.5" />
                    </Link>
                  )}
                  {canManage && (
                    <BroadcastDeleteButton
                      broadcastId={b.id}
                      templateName={b.name || b.templateName}
                      status={b.status}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Month calendar. Places SCHEDULED broadcasts on their scheduledAt day, and
 * non-scheduled ones on their createdAt day, so the month gives an at-a-glance
 * picture of upcoming sends + recent activity (Respond.io-style).
 */
function CalendarView({ rows }: { rows: BroadcastListItem[] }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Bucket broadcasts by local YYYY-MM-DD of their relevant date.
  const byDay = useMemo(() => {
    const map = new Map<string, BroadcastListItem[]>();
    for (const b of rows) {
      const iso = b.status === "scheduled" && b.scheduledAt ? b.scheduledAt : b.createdAt;
      const d = new Date(iso);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    return map;
  }, [rows]);

  const year = month.getFullYear();
  const monthIdx = month.getMonth();
  const firstDay = new Date(year, monthIdx, 1);
  const startWeekday = firstDay.getDay(); // 0 = Sun
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const todayKey = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
  })();

  // 6 rows × 7 cols grid; leading blanks for the first-week offset.
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = firstDay.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="text-sm font-semibold">{monthLabel}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth(new Date(year, monthIdx - 1, 1))}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const t = new Date();
              setMonth(new Date(t.getFullYear(), t.getMonth(), 1));
            }}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth(new Date(year, monthIdx + 1, 1))}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="bg-muted/40 py-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) {
            return <div key={`b${i}`} className="min-h-20 bg-background/40" />;
          }
          const key = `${year}-${monthIdx}-${day}`;
          const items = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          return (
            <div key={key} className="min-h-20 bg-background p-1">
              <div
                className={cn(
                  "mb-1 inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                  isToday ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {day}
              </div>
              <div className="flex flex-col gap-0.5">
                {items.slice(0, 3).map((b) => (
                  <Link
                    key={b.id}
                    href={`/broadcasts/${b.id}`}
                    title={b.name || b.templateName}
                    className={cn(
                      "truncate rounded px-1 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80",
                      b.status === "scheduled"
                        ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                        : b.status === "failed"
                          ? "bg-destructive/15 text-destructive"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {b.name || b.templateName}
                  </Link>
                ))}
                {items.length > 3 && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    +{items.length - 3} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({
  sent,
  failed,
  total,
}: {
  sent: number;
  failed: number;
  total: number;
}) {
  if (total === 0) {
    return <span className="text-[12px] text-muted-foreground">—</span>;
  }
  const sentPct = Math.round((sent / total) * 100);
  const failedPct = Math.round((failed / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="flex h-full">
          <div className="h-full bg-emerald-500" style={{ width: `${sentPct}%` }} />
          <div className="h-full bg-destructive" style={{ width: `${failedPct}%` }} />
        </div>
      </div>
      <div className="tabular-nums text-[12px] text-muted-foreground">
        {sent + failed}/{total}
      </div>
    </div>
  );
}
