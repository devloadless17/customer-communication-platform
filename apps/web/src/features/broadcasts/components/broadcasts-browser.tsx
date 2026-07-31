"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  List,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import type { BroadcastListItem } from "@/lib/api/queries";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";

import { BroadcastStatusBadge } from "@/features/broadcasts/components/broadcast-status-badge";
import { BroadcastDeleteButton } from "@/features/broadcasts/components/broadcast-delete-button";

/**
 * Client shell for the broadcasts page. SSR seeds `initial`; this island owns
 * the status-filter rail, search, and the Table/Calendar view toggle. Status
 * filtering + search refetch server-side (`/api/broadcasts?status=&search=`)
 * so the list reflects ALL matching rows, not just the seeded slice.
 *
 * Plain React + a debounced fetch — no React Query, matching the app's stack.
 */

import {
  BROADCASTS_SEARCH_COOKIE,
  BROADCASTS_STATUS_COOKIE,
  BROADCASTS_VIEW_COOKIE,
  type BroadcastStatusFilter,
  type BroadcastView,
} from "@/features/broadcasts/lib/broadcasts-cookies";

// Dot fills mirror the BroadcastStatusBadge tone trios so a status reads the
// same in the filter rail as on the row chip (no raw emerald/sky literals —
// those don't track dark mode the way the OKLCH tokens do). `scheduled` keeps
// its deliberate indigo identity (matches the badge + calendar pills).
const FILTERS: { id: BroadcastStatusFilter; label: string; dot: string }[] = [
  { id: "all", label: "All", dot: "bg-info-fg" },
  { id: "scheduled", label: "Scheduled", dot: "bg-indigo-500" },
  { id: "queued", label: "Queued", dot: "bg-muted-foreground" },
  { id: "running", label: "In progress", dot: "bg-info-fg" },
  // Both reachable states an operator PUT a campaign into (Stop button →
  // canceled; connection/template fault → paused) — without chips, the
  // campaign they just acted on was unfindable by status.
  { id: "paused", label: "Paused", dot: "bg-warning-fg" },
  { id: "completed", label: "Completed", dot: "bg-success-fg" },
  { id: "failed", label: "Failed", dot: "bg-destructive" },
  { id: "canceled", label: "Canceled", dot: "bg-muted-foreground" },
];

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const BROADCASTS_PAGE_SIZE = 25;

function writeCookie(name: string, value: string) {
  // `encodeURIComponent` on values so a search with `;` or `=` doesn't break
  // the cookie header. The cookies are reserved for THIS surface; no
  // collision with the inbox's cookies (different names).
  const v = encodeURIComponent(value);
  document.cookie = `${name}=${v}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

export function BroadcastsBrowser({
  initial,
  initialTotalCount = null,
  canManage,
  initialFilter = "all",
  initialSearch = "",
  initialView = "table",
  channel = null,
}: {
  initial: BroadcastListItem[];
  /** SSR-computed total matching the seeded filter — drives the page count so
   *  the first paint shows the numbered control without a round-trip. */
  initialTotalCount?: number | null;
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
  /**
   * Scope the history to one channel.
   * Read from the URL by the page so a shared link keeps its scope.
   */
  channel?: string | null;
}) {
  const [rows, setRows] = useState<BroadcastListItem[]>(initial);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState<number | null>(initialTotalCount);
  const [filter, setFilterState] = useState<BroadcastStatusFilter>(initialFilter);
  const [search, setSearchState] = useState(initialSearch);
  const [view, setViewState] = useState<BroadcastView>(initialView);
  const [loading, setLoading] = useState(false);

  // Optimistically drop a deleted row. DELETE emits no socket event (it's an
  // agent action, not a live feed) and `router.refresh()` reseeds the SSR
  // `initial` prop that this `useState(initial)` ignores — so without this the
  // deleted row lingers until a filter change or hard reload.
  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((b) => b.id !== id));
  }, []);

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

  // Track the current filter+search in refs so the socket-driven refetch
  // (which we want to fire WITHOUT re-running the debounce effect on every
  // event) reads the latest values without re-subscribing every change.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // `?channel=` comes from the channel-scoped Outreach nav. A ref (not a dep)
  // for the same reason as `filter`: the fetcher reads the latest value without
  // being re-created, and the effect below drives WHEN it re-runs.
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const searchRef = useRef(search);
  searchRef.current = search;
  // Current page mirrored so the stable `refetch` (and the socket-driven
  // refetch) fetch the page the user is on without re-subscribing.
  const pageRef = useRef(page);
  pageRef.current = page;

  // Monotonic request sequence shared by BOTH the filter-change refetch and the
  // socket-driven refetch. AbortController cancels a request we KNOW is stale,
  // but the two effects only cancel their own tickets — a socket refetch under
  // the old filter is never aborted when the user flips the filter chip, so a
  // slow response could resolve last and clobber `setRows` with wrong-filter
  // rows. Gate every `setRows` on "am I still the latest request".
  const seqRef = useRef(0);

  const refetch = useCallback((opts?: { showLoading?: boolean }) => {
    if (opts?.showLoading !== false) setLoading(true);
    const seq = ++seqRef.current;
    const params = new URLSearchParams();
    // Outreach is scoped per channel, so the history is too: a WhatsApp
    // campaign and a Messenger one are different work and don't belong in one
    // mixed table.
    if (channelRef.current) params.set("channel", channelRef.current);
    if (filterRef.current !== "all") params.set("status", filterRef.current);
    if (searchRef.current.trim()) params.set("search", searchRef.current.trim());
    params.set("page", String(pageRef.current));
    params.set("take", String(BROADCASTS_PAGE_SIZE));
    const qs = params.toString();
    // AbortController so cancel() actually aborts the in-flight HTTP
    // request — not just suppresses the setState. Under a 10k-recipient
    // broadcast the socket fires progress events every ~40ms; the prior
    // flag-only cancel let dozens of GETs race on the wire before they
    // resolved + got dropped, even though setRows was idempotent.
    const controller = new AbortController();
    const promise = apiFetch(`/api/broadcasts${qs ? `?${qs}` : ""}`, {
      signal: controller.signal,
    })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              broadcasts: BroadcastListItem[];
              totalCount?: number;
            }>)
          : null,
      )
      .then((body) => {
        if (controller.signal.aborted || !body) return;
        // A newer refetch started while this one was on the wire — its rows
        // reflect the current filter/search/page, so drop this stale response.
        if (seq !== seqRef.current) return;
        setRows(body.broadcasts);
        if (body.totalCount != null) setTotalCount(body.totalCount);
      })
      .catch((err: unknown) => {
        // AbortError is the cancel path — silent. Anything else is a real
        // network/parse failure; the next event re-triggers, so swallow.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          // intentionally no-op; mirrors useConversationCounts' silent
          // failure posture for socket-driven refetches.
        }
      })
      .finally(() => {
        // Only the latest request owns the loading flag — a superseded response
        // must not clear the spinner while a newer fetch is still in flight.
        if (!controller.signal.aborted && seq === seqRef.current) setLoading(false);
      });
    return { promise, cancel: () => controller.abort() };
  }, []);

  // A filter/search change resets to page 1 (page N of the old set is
  // meaningless). Skip the seeded initial mount.
  const firstResetRef = useRef(true);
  useEffect(() => {
    if (firstResetRef.current) {
      firstResetRef.current = false;
      return;
    }
    setPage(1);
  }, [filter, search]);

  // Server refetch on filter / search / page change. Skip the very first run
  // ONLY when the SSR seeded the total count (so the numbered control can paint
  // immediately) — otherwise fetch on mount to fill it in. Debounce ONLY the
  // typed search — a filter-chip or page-number click fetches immediately so it
  // feels instant. When a filter change resets page N→1, this effect's cleanup
  // cancels the stale page-N ticket before it fires.
  const firstRef = useRef(initialTotalCount != null);
  const prevSearchRef = useRef(search);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      prevSearchRef.current = search;
      return;
    }
    const searchChanged = prevSearchRef.current !== search;
    prevSearchRef.current = search;
    const delay = searchChanged ? 250 : 0;
    let ticket: { cancel: () => void } | null = null;
    const t = window.setTimeout(() => {
      ticket = refetch();
    }, delay);
    return () => {
      ticket?.cancel();
      window.clearTimeout(t);
    };
  }, [filter, search, page, refetch]);

  // Live sync with teammate actions. broadcast:status fires on every flip
  // (scheduled → queued → running → completed/failed/canceled, plus the new
  // create-path emit). broadcast:progress fires while a broadcast is
  // streaming. Both trigger the SAME coalesced refetch: a burst of
  // progress events during a 10k blast collapses into a single GET. The
  // refetch silently re-applies the current filter+search so a teammate
  // completing a broadcast removes it from the "In progress" filter and
  // adds it to "Completed" without a manual F5.
  useEffect(() => {
    const socket = getClientSocket();
    let pending: number | null = null;
    let lastTicket: { cancel: () => void } | null = null;
    const schedule = () => {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        lastTicket?.cancel();
        lastTicket = refetch({ showLoading: false });
      }, 300);
    };
    socket.on("broadcast:status", schedule);
    socket.on("broadcast:progress", schedule);
    return () => {
      socket.off("broadcast:status", schedule);
      socket.off("broadcast:progress", schedule);
      if (pending !== null) window.clearTimeout(pending);
      lastTicket?.cancel();
    };
  }, [refetch]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
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
              <span className={cn("size-2 shrink-0 rounded-full", f.dot)} />
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, template, or account…"
              aria-label="Search broadcasts by name or template"
              className="h-9 pl-8"
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
        <TableView
          rows={rows}
          canManage={canManage}
          loading={loading}
          filtered={filter !== "all" || search.trim().length > 0}
          onDeleted={removeRow}
        />
      ) : (
        <CalendarView rows={rows} />
      )}

      {/* Numbered pagination — table view only (the calendar groups scheduled
          sends by month, not by page). */}
      {view === "table" && rows.length > 0 && (
        <Pagination
          page={page}
          pageCount={Math.max(1, Math.ceil((totalCount ?? rows.length) / BROADCASTS_PAGE_SIZE))}
          onPageChange={(next) => {
            setPage(next);
            if (typeof window !== "undefined") window.scrollTo({ top: 0 });
          }}
          totalCount={totalCount ?? undefined}
          pageSize={BROADCASTS_PAGE_SIZE}
          itemNoun="broadcasts"
        />
      )}
    </div>
  );
}

function TableView({
  rows,
  canManage,
  loading,
  filtered,
  onDeleted,
}: {
  rows: BroadcastListItem[];
  canManage: boolean;
  loading: boolean;
  /** A status filter or search is narrowing the list (vs. a true empty list). */
  filtered: boolean;
  /** Optimistically remove a row from the client list on successful delete. */
  onDeleted: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
        {loading ? (
          "Loading…"
        ) : filtered ? (
          "No broadcasts match this filter."
        ) : (
          // No filter active and still empty — guide rather than read as a
          // broken filter. (The SSR page already shows a richer first-run
          // state when the team has never had a broadcast; this covers the
          // in-browser "cleared filter, nothing left" case.)
          <div className="flex flex-col items-center gap-2">
            <span className="font-medium text-foreground">No broadcasts yet</span>
            {canManage && (
              <Link href="/broadcasts/new" className="text-primary hover:underline">
                New broadcast →
              </Link>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card transition-opacity",
        loading && "opacity-60",
      )}
    >
      {/* Stacked card list below sm — the wide table is a sideways-scroll
          strip on phones, so collapse each row into a compact card. */}
      <ul className="divide-y divide-border sm:hidden">
        {rows.map((b) => (
          <li key={b.id} className="flex flex-col gap-2.5 px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  href={`/broadcasts/${b.id}`}
                  className="block truncate font-medium text-foreground hover:text-primary"
                >
                  {broadcastTitle(b)}
                </Link>
                <div className="mt-0.5 truncate text-2xs text-muted-foreground">
                  {b.campaignName ? `${b.campaignName} · ` : ""}
                  {b.name && b.templateName ? `${b.templateName} · ` : ""}
                  {b.templateLanguage ? `${b.templateLanguage} · ` : ""}
                  {b.audienceMode === "all"
                    ? `All (${b.totalCount})`
                    : `${b.totalCount} selected`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <BroadcastStatusBadge status={b.status} failedCount={b.failedCount} totalCount={b.totalCount} />
                {canManage && canRetry(b) && (
                  <BroadcastRetryButton broadcastId={b.id} failedCount={b.failedCount} />
                )}
                {canManage && (
                  <Link
                    href={`/broadcasts/new?from=${b.id}`}
                    aria-label="Duplicate broadcast"
                    title="Duplicate"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
                  >
                    <Copy className="size-3.5" />
                  </Link>
                )}
                {canManage && (
                  <BroadcastDeleteButton
                    broadcastId={b.id}
                    templateName={broadcastTitle(b)}
                    status={b.status}
                    onDeleted={() => onDeleted(b.id)}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
              <ProgressBar sent={b.sentCount} failed={b.failedCount} total={b.totalCount} />
              <span className="shrink-0 text-2xs text-muted-foreground">
                {b.status === "scheduled" && b.scheduledAt ? (
                  <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                    <CalendarDays className="size-3" />
                    <LocalTime iso={b.scheduledAt} format="listTime" />
                  </span>
                ) : (
                  <LocalTime iso={b.createdAt} format="listTime" />
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-180 text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
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
              className="border-b border-border last:border-b-0 hover:bg-accent/50"
            >
              <td className="max-w-0 px-4 py-3">
                <Link
                  href={`/broadcasts/${b.id}`}
                  className="block truncate font-medium text-foreground hover:text-primary"
                >
                  {broadcastTitle(b)}
                </Link>
                <div className="truncate text-2xs text-muted-foreground">
                  {/* Campaign first: it is the grouping an operator scans FOR
                      ("which of these are the spring sale") — the rollup link
                      itself lives on the detail page. */}
                  {b.campaignName ? `${b.campaignName} · ` : ""}
                  {b.name && b.templateName ? `${b.templateName} · ` : ""}
                  {b.templateLanguage ? `${b.templateLanguage} · ` : ""}
                  {/* Sender identity — the first question about a historical
                      campaign once a channel holds several accounts. */}
                  {b.accountName ? `from ${b.accountName} · ` : ""}by {b.createdByName}
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {b.audienceMode === "all"
                  ? `All (${b.totalCount})`
                  : `${b.totalCount} selected`}
              </td>
              <td className="px-4 py-3">
                <BroadcastStatusBadge status={b.status} failedCount={b.failedCount} totalCount={b.totalCount} />
              </td>
              <td className="px-4 py-3">
                <ProgressBar sent={b.sentCount} failed={b.failedCount} total={b.totalCount} />
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
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
                  {canManage && canRetry(b) && (
                    <BroadcastRetryButton broadcastId={b.id} failedCount={b.failedCount} />
                  )}
                  {canManage && (
                    <Link
                      href={`/broadcasts/new?from=${b.id}`}
                      aria-label="Duplicate broadcast"
                      title="Duplicate"
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
                    >
                      <Copy className="size-3.5" />
                    </Link>
                  )}
                  {canManage && (
                    <BroadcastDeleteButton
                      broadcastId={b.id}
                      templateName={broadcastTitle(b)}
                      status={b.status}
                      onDeleted={() => onDeleted(b.id)}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
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
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      {/* Sideways-scroll on phones — 7 columns crush below ~448px, so keep
          each cell ≥64px (min-w-112 = 7 × 64px) and let the strip scroll. */}
      <div className="overflow-x-auto">
      <div className="grid min-w-112 grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="bg-muted/40 py-1.5 text-center text-3xs font-medium uppercase tracking-wide text-muted-foreground"
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
                  "mb-1 inline-flex size-5 items-center justify-center rounded-full text-2xs",
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
                    title={broadcastTitle(b)}
                    className={cn(
                      "truncate rounded px-1 py-0.5 text-3xs font-medium transition-opacity hover:opacity-80",
                      b.status === "scheduled"
                        ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                        : b.status === "failed"
                          ? "bg-destructive/15 text-destructive"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {broadcastTitle(b)}
                  </Link>
                ))}
                {items.length > 3 && (
                  <span className="px-1 text-3xs text-muted-foreground">
                    +{items.length - 3} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

/**
 * Per-row "Retry failed" quick-action. Re-queues just the failed recipients via
 * the SAME endpoint the detail page uses (`POST /api/broadcasts/:id/retry`),
 * saving a hop to the detail view. Only rendered on a TERMINAL broadcast that
 * actually has failures (gated by the caller). The server flips the broadcast
 * back to `running`; the `broadcast:status` socket echo refetches this list, so
 * no manual refresh is needed here.
 */
function BroadcastRetryButton({
  broadcastId,
  failedCount,
}: {
  broadcastId: string;
  failedCount: number;
}) {
  const [retrying, setRetrying] = useState(false);

  async function run() {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await apiFetch(`/api/broadcasts/${broadcastId}/retry`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        toast.error("Couldn't retry broadcast", {
          description: body.detail ?? body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success(
        `Retrying ${failedCount} failed recipient${failedCount === 1 ? "" : "s"}`,
      );
    } catch {
      toast.error("Couldn't retry broadcast", { description: "Network error" });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={retrying}
      title={`Retry ${failedCount} failed recipient${failedCount === 1 ? "" : "s"}`}
      aria-label={`Retry ${failedCount} failed recipient${failedCount === 1 ? "" : "s"}`}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground pointer-coarse:size-9"
    >
      {retrying ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RotateCcw className="size-3.5" />
      )}
    </button>
  );
}

/** Terminal broadcast with at least one failure → retry is meaningful. */
function canRetry(b: BroadcastListItem): boolean {
  return (
    b.failedCount > 0 &&
    (b.status === "completed" || b.status === "failed" || b.status === "canceled")
  );
}

/** Row title: name → templateName → a fallback for freeform broadcasts, which
 *  have no templateName (so the raw `name || templateName` was blank).
 *  `targetMode === "customer"` marks a HISTORICAL campaign from the removed
 *  omnichannel "best channel" mode (2026-07-27) — label it as such rather
 *  than misfiling it under a single channel. */
function broadcastTitle(b: BroadcastListItem): string {
  if (b.name) return b.name;
  if (b.templateName) return b.templateName;
  return b.targetMode === "customer"
    ? "Best channel (legacy)"
    : `Free-form · ${(CHANNEL_LABEL as Record<string, string>)[b.channel] ?? b.channel}`;
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
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const sentPct = Math.round((sent / total) * 100);
  const failedPct = Math.round((failed / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="flex h-full">
          <div className="h-full bg-success-fg" style={{ width: `${sentPct}%` }} />
          <div className="h-full bg-destructive" style={{ width: `${failedPct}%` }} />
        </div>
      </div>
      <div className="tabular-nums text-xs text-muted-foreground">
        {sent + failed}/{total}
      </div>
    </div>
  );
}
