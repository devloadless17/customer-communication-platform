"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Loader2,
  Megaphone,
  Octagon,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { motion } from "framer-motion";

import { LocalTime } from "@/components/local-time";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";
import { BROWSER_API_BASE } from "@/lib/api/browser-base";
import { getClientSocket } from "@/lib/socket-client";
import { cn, formatPhone } from "@ccp/shared/utils";
import { BroadcastStatusBadge } from "@/features/broadcasts/components/broadcast-status-badge";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";
import { BroadcastReport, type BroadcastReportDto } from "@/features/broadcasts/components/broadcast-report";

/**
 * Broadcast detail client component.
 *
 * Two parallel update channels:
 *   - `broadcast:status` / `broadcast:progress` socket events from the
 *     server's broadcast runner — usually arrive within a tick of the
 *     underlying state change. Triggers an immediate /api/broadcasts/<id>
 *     refresh so the per-recipient table follows along (the socket
 *     summaries don't carry that detail).
 *   - A 2s poll on `/api/broadcasts/<id>` while the broadcast is queued or
 *     running, as a defence-in-depth for any client whose socket dropped
 *     mid-send.
 *
 * Once status flips to `completed` / `failed`, the poll stops; the socket
 * listeners stay subscribed so a late-arriving event still applies (e.g.
 * an admin retry kicking the broadcast back to `running`).
 */

export interface BroadcastDetailDto {
  id: string;
  status: string;
  name: string | null;
  /** Groups this send with its siblings — the rollup page's join key. */
  campaignName: string | null;
  // freeform / People (customer-mode) broadcasts have no template — these are
  // null for them; the message is carried by `kind` + `bodyText` instead.
  kind: "template" | "freeform";
  channel: string;
  targetMode: "contact" | "customer";
  bodyText: string | null;
  scheduledAt: string | null;
  templateId: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  /** The template's message text from the catalog (variables are the true
   *  snapshot; the body is looked up so the card can show the message as the
   *  customer saw it). Null for freeform campaigns or a deleted template. */
  templateBody: string | null;
  audienceMode: string;
  variables: unknown;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  /** Retryable failures only — excludes cancel-finalized recipients (retryFailed
   *  ignores those, so gating the Retry button on the raw failedCount 409s). */
  genuineFailedCount: number;
  lastError: string | null;
  createdByName: string;
  /** The account this campaign went out from; null when since disconnected. */
  channelConnectionId: string | null;
  accountName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  recipients: BroadcastRecipientDto[];
  /** Server-side flag: true when the inline recipient set was truncated
   *  to the first N. Use `/api/broadcasts/:id/recipients?cursor=` to page
   *  the rest. */
  recipientsTruncated?: boolean;
  recipientsShown?: number;
}

export interface BroadcastRecipientDto {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  conversationId: string | null;
  status: string;
  externalId: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  /** The engagement trail — read/replied/clicked per person, from webhooks. */
  deliveryState: string;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  clickedAt: string | null;
  clickedOptionId: string | null;
  errorCode: string | null;
}

const POLL_INTERVAL_MS = 2000;

/**
 * The drill-down vocabulary — the SAME outcome buckets the report's funnel,
 * the CSV export and /v1 use, served by one where-clause on the server. This
 * is what turns "Read 4,120" from a scoreboard into a list of actual people.
 */
type RecipientOutcomeFilter =
  | "all"
  | "delivered"
  | "read"
  | "replied"
  | "clicked"
  | "never_received"
  | "pending";

const RECIPIENT_OUTCOME_TABS: { value: RecipientOutcomeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "delivered", label: "Delivered" },
  { value: "read", label: "Read" },
  { value: "replied", label: "Replied" },
  { value: "clicked", label: "Clicked" },
  { value: "never_received", label: "Never received" },
  { value: "pending", label: "Pending" },
];

export function BroadcastDetail({ initial }: { initial: BroadcastDetailDto }) {
  const { confirm, confirmDialog } = useConfirm();
  const [data, setData] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  // "Load more" recipients beyond the inline 500-row cap on the detail get().
  // Outcome tabs filter the paged fetch server-side so an operator can pull
  // exactly "who replied" on a 100k-recipient campaign without the browser
  // ever holding the audience. These pages are appended below the inline
  // `data.recipients`; the tabs reset the paging cursor and re-fetch.
  const [statusFilter, setStatusFilter] = useState<RecipientOutcomeFilter>("all");
  // Set by the failure table's deep links ("who hit THIS error") — composes
  // with the outcome filter server-side.
  const [errorCodeFilter, setErrorCodeFilter] = useState<string | null>(null);
  const [extraRecipients, setExtraRecipients] = useState<BroadcastRecipientDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Re-queue + re-run only the failed recipients. Server flips the broadcast
  // back to `running`; the socket `broadcast:status` echo refreshes the page.
  async function retryFailed() {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await apiFetch(`/api/broadcasts/${data.id}/retry`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        setRetryError(body.detail ?? body.error ?? "Couldn't retry");
        return;
      }
      await refreshRef.current();
    } catch {
      setRetryError("Network error");
    } finally {
      setRetrying(false);
    }
  }

  // Stop an in-flight (or still-scheduled) broadcast. The backend CAS-flips it
  // to `canceled` and the runner bails between recipients; already-sent
  // messages stay sent (WhatsApp can't unsend). Behind a destructive confirm —
  // it's an irreversible stop, not a delete.
  async function cancelBroadcast() {
    if (canceling) return;
    const ok = await confirm({
      title: "Stop this broadcast?",
      description:
        `Sending stops immediately. Recipients already delivered to stay sent — ${(CHANNEL_LABEL as Record<string, string>)[data.channel] ?? "the channel"} can't unsend them. The rest won't receive the message.`,
      confirmLabel: "Stop broadcast",
      destructive: true,
    });
    if (!ok) return;
    setCanceling(true);
    try {
      const res = await apiFetch(`/api/broadcasts/${data.id}/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        toast.error("Couldn't stop broadcast", {
          description: body.detail ?? body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Broadcast stopped");
      await refreshRef.current();
    } catch {
      toast.error("Couldn't stop broadcast", { description: "Network error" });
    } finally {
      setCanceling(false);
    }
  }

  // Fetch one page of recipients from /recipients (cursor-paged, optionally
  // outcome-filtered) and APPEND to extraRecipients. `cursor === null` starts a
  // fresh page (a just-selected tab); otherwise it continues after the given
  // id. The server orders failed → sent → queued in `all` mode, matching the
  // inline get(), so an unfiltered page picks up right after the inline 500.
  async function fetchRecipientPage(
    cursor: string | null,
    filter: RecipientOutcomeFilter,
    errorCode: string | null,
    append: boolean,
  ) {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (filter !== "all") params.set("outcome", filter);
      if (errorCode) params.set("errorCode", errorCode);
      const res = await apiFetch(
        `/api/broadcasts/${data.id}/recipients?${params.toString()}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        setMoreError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as {
        recipients: BroadcastRecipientDto[];
        nextCursor: string | null;
      };
      setExtraRecipients((prev) => (append ? [...prev, ...json.recipients] : json.recipients));
      setMoreCursor(json.nextCursor);
    } catch {
      setMoreError("Network error");
    } finally {
      setLoadingMore(false);
    }
  }

  // Tab switch. `all` (with no error-code narrowing) shows the inline
  // first-500; anything else does a fresh server-filtered fetch that REPLACES
  // the appended set — always server-side, so a 100k campaign and a 20-person
  // one drill down through the same code path.
  function selectFilter(next: RecipientOutcomeFilter, errorCode: string | null = null) {
    if (next === statusFilter && errorCode === errorCodeFilter) return;
    setStatusFilter(next);
    setErrorCodeFilter(errorCode);
    setExtraRecipients([]);
    setMoreCursor(null);
    if (next !== "all" || errorCode) void fetchRecipientPage(null, next, errorCode, false);
  }

  const unfiltered = statusFilter === "all" && !errorCodeFilter;

  // "Load more". In unfiltered mode the first page continues after the last
  // inline recipient (seed the cursor from it); subsequent pages use the
  // server's nextCursor. Filtered modes always page off the current cursor.
  function loadMore() {
    const seedCursor =
      unfiltered && moreCursor === null && extraRecipients.length === 0
        ? (data.recipients.at(-1)?.id ?? null)
        : moreCursor;
    void fetchRecipientPage(seedCursor, statusFilter, errorCodeFilter, true);
  }

  // Whether more rows can be paged. Unfiltered: always allow the first
  // "Load more" (the inline set was truncated); after that, the server cursor
  // decides. In a filtered mode, the cursor decides from the first fetch.
  const canLoadMore = unfiltered
    ? data.recipientsTruncated &&
      (moreCursor !== null || extraRecipients.length === 0)
    : moreCursor !== null;

  // Recipients to render: inline-500 + appended in unfiltered mode; only the
  // server-filtered page in a drill-down mode. While a broadcast runs,
  // the status-grouped inline top-500 re-shuffles on each debounced refresh,
  // so a previously appended "Load more" row can flip status and re-enter the
  // inline set — dedupe by id (prefer the fresher inline row) to avoid
  // duplicate React keys and doubled rows.
  const visibleRecipients = unfiltered
    ? (() => {
        const inlineIds = new Set(data.recipients.map((r) => r.id));
        return [...data.recipients, ...extraRecipients.filter((r) => !inlineIds.has(r.id))];
      })()
    : extraRecipients;

  // Shared refresher so both the socket listeners and the poll go through
  // the same code path. Inside a ref so the socket effect can call it
  // without restarting on every render.
  const cancelledRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    try {
      const res = await apiFetch(`/api/broadcasts/${data.id}`);
      if (!res.ok) return;
      const json = (await res.json()) as { broadcast?: BroadcastDetailDto };
      if (cancelledRef.current || !json.broadcast) return;
      setData(json.broadcast);
    } catch {
      // Best effort — transient network blips just skip a tick.
    }
  };

  // The campaign report (funnel, failure buckets, diagnostics) is a SEPARATE
  // fetch from the detail poll above on purpose: it runs aggregate queries, and
  // the detail endpoint is polled every 2s while sending. Refreshed on mount, on
  // a much slower cadence while the campaign is live, and once more when it
  // finishes — delivery and read receipts keep arriving for hours after the last
  // send, so the final numbers are not known at completion time.
  const [report, setReport] = useState<BroadcastReportDto | null>(null);

  // Bucket sizes for the recipient tabs, straight off the funnel this page
  // already fetched — no extra queries. Each entry mirrors the server's
  // outcome clause exactly (delivered = reached = delivered+read; pending =
  // the not-yet-final states pending+sent+held), so a tab's count and its
  // filtered list can never disagree.
  const outcomeCounts: Record<RecipientOutcomeFilter, number> | null = report
    ? {
        all: data.totalCount,
        delivered: report.funnel.reached,
        read: report.funnel.read,
        replied: report.funnel.replied,
        clicked: report.funnel.clicked,
        never_received: report.funnel.neverReceived,
        pending: report.funnel.pending + report.funnel.sent + report.funnel.held,
      }
    : null;

  // "Export what I'm looking at" — the export endpoint speaks the same
  // outcome/errorCode vocabulary as the table, so the file matches the view.
  const exportParams = new URLSearchParams({
    ...(statusFilter !== "all" ? { outcome: statusFilter } : {}),
    ...(errorCodeFilter ? { errorCode: errorCodeFilter } : {}),
  }).toString();
  const exportHref = `${BROWSER_API_BASE}/api/broadcasts/${data.id}/export${
    exportParams ? `?${exportParams}` : ""
  }`;
  // Bumped after a Meta analytics fetch so the delivery curve refetches in step
  // with the report rather than holding a snapshot from before it.
  const [reportRefreshKey, setReportRefreshKey] = useState(0);
  const reportRef = useRef<() => Promise<void>>(async () => {});
  reportRef.current = async () => {
    try {
      const res = await apiFetch(`/api/broadcasts/${data.id}/report`);
      if (!res.ok) return;
      const json = (await res.json()) as { report?: BroadcastReportDto };
      if (cancelledRef.current || !json.report) return;
      setReport(json.report);
    } catch {
      // Advisory surface — a failed fetch just leaves the previous numbers.
    }
  };
  useEffect(() => {
    void reportRef.current();
    const live =
      data.status === "queued" || data.status === "running" || data.status === "materializing";
    if (live) {
      const t = window.setInterval(() => void reportRef.current(), 8_000);
      return () => window.clearInterval(t);
    }
    // The send finishing is not the campaign finishing: delivered/read/replied
    // keep arriving from status webhooks for DAYS afterwards, and a frozen
    // report reads as "nobody engaged" when the truth is "you're looking at a
    // snapshot". Keep a gentle poll while the tab is actually visible, bounded
    // to the engagement tail (7 days past completion) — after that the numbers
    // genuinely stop moving and polling would be waste.
    const completedAt = data.completedAt ? Date.parse(data.completedAt) : null;
    const inTail =
      completedAt === null || Date.now() - completedAt < 7 * 86_400_000;
    if (!inTail) return;
    const tick = () => {
      if (document.visibilityState === "visible") void reportRef.current();
    };
    const t = window.setInterval(tick, 30_000);
    // Coming back to the tab after a while shows fresh numbers immediately
    // instead of waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void reportRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.id, data.status]);

  // Debounced refresh used by the socket progress handler. A 10k-recipient
  // broadcast fires ~25 progress events/s (one per send, see broadcast-
  // runner.ts). Calling `refreshRef.current()` directly on each one fans
  // out to ~25 full GETs per second against the detail endpoint — each of
  // which joins recipients + contacts. That hammered the server during a
  // big broadcast.
  //
  // The counters move instantly from the socket payload below; the table
  // refresh just needs to land "eventually" so per-recipient status (sent,
  // failed, externalId) catches up. Trailing-debounce 800ms is a good
  // perceptual floor — the bar updates every event, the table catches up
  // 4-5x slower. Leading-edge fire on the first event so a single send
  // doesn't wait for the trailing window.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAtRef = useRef(0);
  const REFRESH_LEADING_MIN_MS = 400;
  const REFRESH_TRAILING_MS = 800;
  const requestDebouncedRefresh = () => {
    const now = Date.now();
    if (now - lastRefreshAtRef.current >= REFRESH_LEADING_MIN_MS && !refreshTimerRef.current) {
      lastRefreshAtRef.current = now;
      void refreshRef.current();
      return;
    }
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      lastRefreshAtRef.current = Date.now();
      void refreshRef.current();
    }, REFRESH_TRAILING_MS);
  };

  // Socket fast-path. Stays subscribed for the lifetime of the detail page
  // — a late `broadcast:status` after the poll stopped is still applied.
  useEffect(() => {
    const socket = getClientSocket();
    const broadcastId = data.id;

    const onStatus: Parameters<typeof socket.on<"broadcast:status">>[1] = (
      payload,
    ) => {
      if (payload.broadcastId !== broadcastId) return;
      // Status flips are rare (queued → running → completed|failed) and
      // each one needs the full broadcast row to reflect lastError +
      // startedAt + completedAt. Refresh directly, no debounce.
      void refreshRef.current();
    };
    const onProgress: Parameters<typeof socket.on<"broadcast:progress">>[1] = (
      payload,
    ) => {
      if (payload.broadcastId !== broadcastId) return;
      // Apply the summary counters immediately so the progress bar moves
      // without waiting on the follow-up fetch. Counter-only patch — no
      // recipient table fetch in the synchronous path.
      setData((prev) => ({
        ...prev,
        sentCount: payload.sentCount,
        failedCount: payload.failedCount,
        totalCount: payload.totalCount,
      }));
      // Recipient table catches up via the debounced refresh — see the
      // rationale on requestDebouncedRefresh above.
      requestDebouncedRefresh();
    };

    socket.on("broadcast:status", onStatus);
    socket.on("broadcast:progress", onProgress);
    return () => {
      socket.off("broadcast:status", onStatus);
      socket.off("broadcast:progress", onProgress);
      // Don't leave a queued debounced refresh pointing at a torn-down
      // component — the tab might be on another broadcast by the time it
      // fires, and the stale setData would clobber whatever it loaded.
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [data.id]);

  // Poll fallback — defence in depth if the socket connection drops mid-
  // send. Stops once the broadcast finishes. `paused` is included because
  // it's not terminal — the api boot reconciler will auto-resume on next
  // restart, flipping the row through queued → running and we want the UI
  // to catch the transition without a manual refresh.
  useEffect(() => {
    cancelledRef.current = false;
    if (
      data.status !== "materializing" &&
      data.status !== "queued" &&
      data.status !== "running" &&
      data.status !== "paused"
    )
      return;
    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(timer);
    };
  }, [data.status, data.id]);

  const variables = parseVariables(data.variables);
  // Title: prefer the operator-set name, then the template name, then a human
  // fallback for freeform broadcasts (which have neither). `targetMode ===
  // "customer"` marks a HISTORICAL campaign from the removed omnichannel
  // "best channel" mode (2026-07-27) — it still renders, clearly labeled.
  const isFreeform = data.kind === "freeform" || data.targetMode === "customer";
  const fallbackTitle =
    data.targetMode === "customer"
      ? "Best channel (legacy)"
      : `Free-form · ${(CHANNEL_LABEL as Record<string, string>)[data.channel] ?? data.channel}`;
  const title = data.name || data.templateName || fallbackTitle;
  const remaining = data.totalCount - data.sentCount - data.failedCount;
  const progressPct =
    data.totalCount === 0
      ? 0
      : Math.round(((data.sentCount + data.failedCount) / data.totalCount) * 100);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {data.name && data.templateName && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                Template: {data.templateName}
              </div>
            )}
            {data.campaignName && (
              // The reverse of the rollup page's per-send links: from one send
              // to the campaign it belongs to. Without this, the rollup is
              // only findable by someone who already knows it exists.
              <Link
                href={`/reports/campaigns/${encodeURIComponent(data.campaignName)}`}
                className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Megaphone className="size-3 shrink-0" />
                <span className="truncate">Campaign: {data.campaignName}</span>
              </Link>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Stop is only meaningful while the broadcast can still send —
                scheduled (not fired yet), queued/running (mid-send), or paused
                (will auto-resume). The backend allows cancel in all of these. */}
            {(data.status === "scheduled" ||
              data.status === "materializing" ||
              data.status === "queued" ||
              data.status === "running" ||
              data.status === "paused") && (
              <button
                type="button"
                onClick={() => void cancelBroadcast()}
                disabled={canceling}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
              >
                {canceling ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Octagon className="size-3.5" />
                )}
                Stop broadcast
              </button>
            )}
            {/* Retry only makes sense on a finished broadcast that has REAL
                (retryable) failures. Gated on genuineFailedCount — the raw
                failedCount includes cancel-finalized recipients that
                retryFailed() excludes, so gating on it showed a button that
                409s ("no failed recipients") on a canceled broadcast. */}
            {data.genuineFailedCount > 0 &&
              (data.status === "completed" ||
                data.status === "failed" ||
                data.status === "canceled") && (
                <button
                  type="button"
                  onClick={() => void retryFailed()}
                  disabled={retrying}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60"
                >
                  {retrying ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  Retry {data.genuineFailedCount} failed
                </button>
              )}
            <BroadcastStatusBadge status={data.status} failedCount={data.failedCount} totalCount={data.totalCount} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {/* Free-form and legacy rows have no template language — omitting
              beats a dangling "Language: ·". */}
          {data.templateLanguage && (
            <>
              <span>Language: {data.templateLanguage}</span>
              <span>·</span>
            </>
          )}
          {/* Sender identity. Absent for legacy rows (pre-account-stamping,
              removed best-channel campaigns) and numbers since disconnected —
              omitting beats guessing there. */}
          {data.accountName && (
            <>
              <span>Sent from {data.accountName}</span>
              <span>·</span>
            </>
          )}
          <span>By {data.createdByName}</span>
          <span>·</span>
          <LocalTime iso={data.createdAt} format="listTime" />
          {data.status === "scheduled" && data.scheduledAt && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                <CalendarClock className="size-3.5" />
                Sends <LocalTime iso={data.scheduledAt} format="listTime" />
              </span>
            </>
          )}
          {data.completedAt && (
            <>
              <span>·</span>
              <span>Finished <LocalTime iso={data.completedAt} format="listTime" /></span>
            </>
          )}
        </div>
        {retryError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs text-destructive"
          >
            {retryError}
          </div>
        )}
      </header>

      {data.lastError && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
            data.status === "paused"
              ? "border-warning-border bg-warning-bg text-warning-fg"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-medium">
              {data.status === "paused" ? "Broadcast paused" : "Broadcast failed"}
            </div>
            <div className="mt-0.5 wrap-break-word font-mono text-2xs">
              {data.lastError}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Stat label="Recipients" value={data.totalCount.toString()} />
        <Stat
          label="Sent"
          value={data.sentCount.toString()}
          tone="emerald"
        />
        <Stat
          label="Failed"
          value={data.failedCount.toString()}
          tone={data.failedCount > 0 ? "destructive" : "muted"}
        />
        <Stat
          label="Remaining"
          value={Math.max(remaining, 0).toString()}
          tone={remaining > 0 ? "amber" : "muted"}
        />
      </div>

      <div className="overflow-hidden rounded-full bg-muted">
        <motion.div
          className="h-2 flex"
          initial={false}
          transition={{ duration: 0.4 }}
        >
          <motion.div
            className="h-full bg-success-fg"
            animate={{ width: `${data.totalCount === 0 ? 0 : (data.sentCount / data.totalCount) * 100}%` }}
            transition={{ duration: 0.4 }}
          />
          <motion.div
            className="h-full bg-destructive"
            animate={{ width: `${data.totalCount === 0 ? 0 : (data.failedCount / data.totalCount) * 100}%` }}
            transition={{ duration: 0.4 }}
          />
        </motion.div>
      </div>
      <div className="text-2xs text-muted-foreground">
        {data.status === "materializing"
          ? `Preparing ${data.totalCount.toLocaleString()} recipients — sending starts automatically`
          : `${progressPct}% processed`}
        {(data.status === "queued" || data.status === "running") && " · updates live"}
        {data.status === "paused" &&
          (data.lastError
            ? ` · paused — ${(CHANNEL_LABEL as Record<string, string>)[data.channel] ?? "channel"} connection error; fix the connection and it will auto-resume`
            : " · paused for server restart, will auto-resume")}
      </div>

      {/* Campaign report. Sits directly under the progress bar because the
          operator's questions are, in order: did it work → what went wrong and
          what do I do → who do I follow up with. The template snapshot is audit
          material, so it moves below this. */}
      {report && report.funnel.targeted > 0 && (
        <section className="rounded-xl border border-border bg-card p-4">
          <BroadcastReport
            report={report}
            hasTemplate={!isFreeform}
            // Without these the Meta panel fetched successfully and then went on
            // showing "Nothing fetched yet" until a manual page reload — the
            // button appeared broken while working perfectly. A completed
            // campaign stops polling (see the effect above), so nothing else
            // would have re-pulled the report.
            refreshKey={reportRefreshKey}
            onRefreshed={() => {
              void reportRef.current();
              setReportRefreshKey((k) => k + 1);
            }}
            onFilter={(filter) => {
              // Deep-link a funnel stage / failure bucket into the recipient
              // table below — the server speaks the same outcome vocabulary,
              // so every number in the report is one click from the actual
              // people behind it.
              const value = filter.split("=")[1] ?? "all";
              if (filter.startsWith("outcome=")) {
                const known = RECIPIENT_OUTCOME_TABS.some((t) => t.value === value);
                // `accepted`/`undelivered` have no tab of their own — map to
                // the closest truthful superset rather than doing nothing.
                const mapped: RecipientOutcomeFilter = known
                  ? (value as RecipientOutcomeFilter)
                  : value === "undelivered" || value === "failed"
                    ? "never_received"
                    : "all";
                selectFilter(mapped);
              } else if (filter.startsWith("errorCode=")) {
                // "Who hit THIS error" — server-filtered by normalized code.
                selectFilter("all", value);
              }
              document.getElementById("broadcast-recipients")?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
          />
        </section>
      )}

      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border bg-muted/30 px-4 py-3">
          <div className="text-sm font-semibold">
            {isFreeform ? "Message snapshot" : "Template snapshot"}
          </div>
          <div className="text-2xs text-muted-foreground">
            {isFreeform
              ? "The message that was sent to each recipient, captured at send time."
              : "Captured at the moment the broadcast was created — even if the template gets edited in WhatsApp Manager, this is what was sent."}
          </div>
        </header>
        <div className="px-4 py-4">
          {isFreeform ? (
            // Freeform / People broadcasts have no template variables — show the
            // actual message body (previously rendered nowhere, so these
            // broadcasts had a blank snapshot card).
            <p className="whitespace-pre-wrap break-words text-sm">
              {data.bodyText || (
                <span className="text-muted-foreground">No message body.</span>
              )}
            </p>
          ) : (
            <>
              {/* The message as the customer saw it: the catalog body with
                  this campaign's variable values substituted in. Without this
                  a zero-variable template rendered a completely EMPTY card —
                  a snapshot section with nothing in it reads as data loss. */}
              {data.templateBody ? (
                <p className="mb-3 whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-3 text-sm">
                  {substituteTemplateBody(data.templateBody, variables.body)}
                </p>
              ) : (
                variables.body.length === 0 &&
                !variables.header && (
                  <p className="mb-3 text-xs text-muted-foreground">
                    This template has no variables — the approved template text
                    was sent to every recipient exactly as-is.
                  </p>
                )
              )}
              {(variables.header || variables.body.length > 0) && (
              <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
                {variables.header !== undefined && (
                  <div className="flex flex-col">
                    <dt className="text-3xs uppercase tracking-wide text-muted-foreground">
                      Header
                    </dt>
                    <dd className="font-mono">{variables.header || "—"}</dd>
                  </div>
                )}
                {variables.body.map((v, i) => (
                  <div key={i} className="flex flex-col">
                    <dt className="text-3xs uppercase tracking-wide text-muted-foreground">
                      {`{{${i + 1}}}`}
                    </dt>
                    <dd className="font-mono">{v || "—"}</dd>
                  </div>
                ))}
              </dl>
              )}
            </>
          )}
        </div>
      </section>

      <section id="broadcast-recipients" className="rounded-xl border border-border bg-card">
        <header className="flex flex-col gap-3 border-b border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold">Recipients</div>
            <div className="text-2xs text-muted-foreground">
              Per-recipient delivery status. Click a row to jump to its
              conversation.
              {data.recipientsTruncated
                ? ` ${data.totalCount} total — paged below.`
                : null}
            </div>
          </div>
          {/* Outcome tabs — the funnel's numbers as PEOPLE. Always shown (a
              20-recipient campaign still wants "who replied"); every tab is a
              server-side filter, so a 100k campaign drills down through the
              same bounded pages as a small one. Counts come from the report's
              funnel — already on this page, zero extra queries — so at 10k
              replies the operator sees the size of a bucket BEFORE opening it
              and exports the full list instead of scrolling it. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex w-fit flex-wrap rounded-lg border border-border bg-background p-0.5 text-xs">
              {RECIPIENT_OUTCOME_TABS.map((tab) => {
                const count = outcomeCounts?.[tab.value];
                return (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => selectFilter(tab.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-medium transition-colors",
                      statusFilter === tab.value && !errorCodeFilter
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.label}
                    {count !== undefined && count > 0 && (
                      <span className="ml-1 tabular-nums opacity-60">
                        {count.toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {errorCodeFilter && (
              <button
                type="button"
                onClick={() => selectFilter("all")}
                className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-2xs font-medium text-warning-fg"
                title="Clear this error filter"
              >
                Error: {errorCodeFilter}
                <span aria-hidden>×</span>
              </button>
            )}
            {/* Same filter vocabulary server-side, so "export what I'm looking
                at" is exact — the 10k-replies answer is this file, not 50
                clicks of Load more. */}
            <a
              href={exportHref}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              download
            >
              <Download className="size-3" />
              Export CSV
            </a>
          </div>
        </header>
        <div className="max-h-120 overflow-auto">
          <table className="w-full min-w-140 text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Contact</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Engagement</th>
                <th className="px-4 py-2.5 text-left font-medium">Sent</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleRecipients.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border last:border-b-0 transition-colors hover:bg-accent/50"
                >
                  <td className="max-w-0 px-4 py-2.5">
                    <div className="truncate font-medium">{r.contactName}</div>
                    <div className="truncate text-2xs tabular-nums text-muted-foreground">
                      {formatPhone(r.contactPhone)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <RecipientStatusPill recipient={r} />
                  </td>
                  <td className="px-4 py-2.5">
                    <RecipientEngagement recipient={r} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {r.sentAt ? <LocalTime iso={r.sentAt} format="listTime" /> : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.conversationId ? (
                      <Link
                        href={`/inbox/${r.conversationId}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        Open chat
                        <ExternalLink className="size-3" />
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
              {visibleRecipients.length === 0 && !loadingMore && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-xs text-muted-foreground"
                  >
                    {statusFilter === "all"
                      ? "No recipients."
                      : `No recipients in “${
                          RECIPIENT_OUTCOME_TABS.find((t) => t.value === statusFilter)?.label ??
                          statusFilter
                        }” yet.`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(canLoadMore || loadingMore || moreError) && (
          <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-3">
            {moreError && (
              <div role="alert" className="text-2xs text-destructive">
                {moreError}
              </div>
            )}
            {canLoadMore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60"
              >
                {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </section>
      {confirmDialog}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "emerald" | "destructive" | "amber";
}) {
  const toneClass =
    tone === "emerald"
      ? "border-success-border bg-success-bg"
      : tone === "destructive"
        ? "border-destructive/30 bg-destructive/5"
        : tone === "amber"
          ? "border-warning-border bg-warning-bg"
          : "border-border bg-muted/20";
  return (
    <div className={cn("flex flex-col gap-1 rounded-xl border px-4 py-3", toneClass)}>
      <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="tabular-nums text-2xl font-semibold">{value}</div>
    </div>
  );
}

/**
 * The per-person engagement trail: how far this recipient got, with WHEN at
 * each step. This is what the funnel's aggregate numbers are made of — an
 * operator drilling into "Read 4,120" sees each person's read time here.
 * Renders the FURTHEST milestone first (replied ⊃ read ⊃ delivered); a plain
 * dash for a recipient with no engagement signal yet, which is honest for a
 * just-sent or failed row.
 */
function RecipientEngagement({ recipient: r }: { recipient: BroadcastRecipientDto }) {
  const steps: Array<{ label: string; iso: string; tone: string }> = [];
  if (r.repliedAt) steps.push({ label: "Replied", iso: r.repliedAt, tone: "text-primary" });
  if (r.clickedAt)
    steps.push({
      label: r.clickedOptionId ? `Clicked “${r.clickedOptionId}”` : "Clicked",
      iso: r.clickedAt,
      tone: "text-primary",
    });
  if (r.readAt) steps.push({ label: "Read", iso: r.readAt, tone: "text-success-fg" });
  else if (r.deliveredAt)
    steps.push({ label: "Delivered", iso: r.deliveredAt, tone: "text-muted-foreground" });
  if (steps.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {steps.map((s) => (
        <span key={s.label} className={cn("inline-flex items-baseline gap-1.5 text-xs", s.tone)}>
          <span className="font-medium">{s.label}</span>
          <span className="text-2xs text-muted-foreground">
            <LocalTime iso={s.iso} format="listTime" />
          </span>
        </span>
      ))}
    </div>
  );
}

function RecipientStatusPill({
  recipient,
}: {
  recipient: BroadcastRecipientDto;
}) {
  if (recipient.status === "sent") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success-fg">
        <CheckCircle2 className="size-3.5" />
        Sent
      </span>
    );
  }
  if (recipient.status === "failed") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <XCircle className="size-3.5" />
          Failed
        </span>
        {/* Surface the actual reason INLINE (was a hover-only tooltip nobody
            could find). For a broadcast that "Completed" with an all-red bar,
            this is where the real cause lives — e.g. Meta's
            "131030: Recipient phone number not in allowed list" (app still in
            development mode → real numbers rejected). */}
        {recipient.errorMessage && (
          <span
            className="max-w-[280px] truncate text-2xs text-muted-foreground"
            title={recipient.errorMessage}
          >
            {recipient.errorMessage}
          </span>
        )}
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Clock className="size-3.5" />
      Queued
    </span>
  );
}

/**
 * Compose the message the customer saw: replace the template's placeholder
 * tokens with this campaign's variable values, IN ORDER. Token-order (not
 * token-name) substitution handles positional `{{1}}` and named `{{code}}`
 * bodies with the same code path — the stored values array is ordered either
 * way. A token past the values array stays visible as-is, which is honest
 * (it's what an unfilled variable would have looked like).
 */
function substituteTemplateBody(body: string, values: string[]): string {
  let i = 0;
  return body.replace(/\{\{\s*[^{}]+\s*\}\}/g, (token) => {
    const v = values[i++];
    return v !== undefined && v !== "" ? v : token;
  });
}

function parseVariables(v: unknown): { body: string[]; header?: string } {
  if (typeof v !== "object" || v === null) return { body: [] };
  const obj = v as { body?: unknown; header?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  return { body, ...(header ? { header } : {}) };
}
