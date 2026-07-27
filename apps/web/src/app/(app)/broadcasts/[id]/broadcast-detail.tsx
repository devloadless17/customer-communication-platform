"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Octagon,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { motion } from "framer-motion";

import { LocalTime } from "@/components/local-time";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { cn, formatPhone } from "@ccp/shared/utils";
import { BroadcastStatusBadge } from "../broadcast-status-badge";
import { BroadcastReport, type BroadcastReportDto } from "./broadcast-report";

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
}

const POLL_INTERVAL_MS = 2000;

type RecipientStatusFilter = "all" | "failed" | "sent" | "queued";

const RECIPIENT_STATUS_TABS: { value: RecipientStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "sent", label: "Sent" },
  { value: "queued", label: "Queued" },
];

export function BroadcastDetail({ initial }: { initial: BroadcastDetailDto }) {
  const { confirm, confirmDialog } = useConfirm();
  const [data, setData] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  // "Load more" recipients beyond the inline 500-row cap on the detail get().
  // Status tabs filter the paged fetch server-side so an operator can isolate
  // failures on a mass-failure broadcast (where they're what matters). These
  // extra pages are appended below the inline `data.recipients`; the tabs reset
  // the paging cursor and re-fetch from the chosen status.
  const [statusFilter, setStatusFilter] = useState<RecipientStatusFilter>("all");
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
        "Sending stops immediately. Recipients already delivered to stay sent — WhatsApp can't unsend them. The rest won't receive the message.",
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
  // status-filtered) and APPEND to extraRecipients. `cursor === null` starts a
  // fresh page (a just-selected status tab); otherwise it continues after the
  // given id. The server orders failed → sent → queued, matching the inline
  // get(), so a status-less ("all") page picks up right after the inline 500.
  async function fetchRecipientPage(
    cursor: string | null,
    filter: RecipientStatusFilter,
    append: boolean,
  ) {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (filter !== "all") params.set("status", filter);
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

  // Status tab switch. `all` shows the inline first-500 (no fetch needed unless
  // the operator loads more); a specific status does a fresh server-filtered
  // fetch that REPLACES the appended set.
  function selectStatus(next: RecipientStatusFilter) {
    if (next === statusFilter) return;
    setStatusFilter(next);
    setExtraRecipients([]);
    setMoreCursor(null);
    if (next !== "all") void fetchRecipientPage(null, next, false);
  }

  // "Load more". In `all` mode the first page continues after the last inline
  // recipient (seed the cursor from it); subsequent pages use the server's
  // nextCursor. Filtered modes always page off the current cursor.
  function loadMore() {
    const seedCursor =
      statusFilter === "all" && moreCursor === null && extraRecipients.length === 0
        ? (data.recipients.at(-1)?.id ?? null)
        : moreCursor;
    void fetchRecipientPage(seedCursor, statusFilter, true);
  }

  // Whether more rows can be paged. In `all` mode we always allow the first
  // "Load more" (the inline set was truncated); after that, the server cursor
  // decides. In a filtered mode, the cursor decides from the first fetch.
  const canLoadMore =
    statusFilter === "all"
      ? data.recipientsTruncated &&
        (moreCursor !== null || extraRecipients.length === 0)
      : moreCursor !== null;

  // Recipients to render: inline-500 + appended in `all` mode; only the
  // server-filtered page in a specific-status mode. While a broadcast runs,
  // the status-grouped inline top-500 re-shuffles on each debounced refresh,
  // so a previously appended "Load more" row can flip status and re-enter the
  // inline set — dedupe by id (prefer the fresher inline row) to avoid
  // duplicate React keys and doubled rows.
  const visibleRecipients =
    statusFilter === "all"
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
    if (!live) return;
    const t = window.setInterval(() => void reportRef.current(), 8_000);
    return () => window.clearInterval(t);
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
      : `Free-form · ${data.channel}`;
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
          <span>Language: {data.templateLanguage}</span>
          <span>·</span>
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
            ? " · paused — WhatsApp connection error; fix the connection and it will auto-resume"
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
              // table below. Today the table filters by send-side status; the
              // richer outcome buckets land with the filter model in a later
              // phase, so map what we can and always scroll the user to the
              // list rather than silently doing nothing.
              const value = filter.split("=")[1] ?? "all";
              if (filter.startsWith("outcome=")) {
                if (value === "failed" || value === "never_received") setStatusFilter("failed");
                else if (value === "all") setStatusFilter("all");
              } else if (filter.startsWith("errorCode=")) {
                // Per-error-code buckets are all failures — map to the failed
                // tab (a truthful superset) so the click actually narrows the
                // table instead of only scrolling.
                setStatusFilter("failed");
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
            (variables.header || variables.body.length > 0) && (
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
            )
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
          {/* Status tabs only matter once the inline set was truncated — under
              500 recipients the full set is already on screen. */}
          {data.recipientsTruncated && (
            <div className="inline-flex w-fit rounded-lg border border-border bg-background p-0.5 text-xs">
              {RECIPIENT_STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => selectStatus(tab.value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium transition-colors",
                    statusFilter === tab.value
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </header>
        <div className="max-h-120 overflow-auto">
          <table className="w-full min-w-140 text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Contact</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">When</th>
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
                    colSpan={4}
                    className="px-4 py-8 text-center text-xs text-muted-foreground"
                  >
                    No {statusFilter === "all" ? "" : `${statusFilter} `}recipients.
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

function parseVariables(v: unknown): { body: string[]; header?: string } {
  if (typeof v !== "object" || v === null) return { body: [] };
  const obj = v as { body?: unknown; header?: unknown };
  const body = Array.isArray(obj.body)
    ? obj.body.filter((x): x is string => typeof x === "string")
    : [];
  const header = typeof obj.header === "string" ? obj.header : undefined;
  return { body, ...(header ? { header } : {}) };
}
