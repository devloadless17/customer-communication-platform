"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Phone } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import {
  CallHistoryRow,
  type CallHistoryRowData,
} from "@/features/calls/components/call-history-row";
import { toast } from "@/lib/toast";
import { useCallApi } from "@/features/calls/call-provider";

/**
 * Mirrors TeamCallRow in apps/api/src/calls/calls.service.ts — the shared row
 * shape plus the contact fields only the team-wide page carries.
 */
type CallRow = CallHistoryRowData & {
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
};

const PAGE = 25;

export function CallsHistory({ canCall }: { canCall: boolean }) {
  const [rows, setRows] = useState<CallRow[]>([]);
  // NOTE: this used to derive "is the workspace multi-account?" from whichever
  // accounts appeared in the CURRENT page of 25 rows. A page whose calls all
  // happened to be on one number rendered no attribution at all, so the label
  // vanished and reappeared as you paged — and a page from a genuinely
  // single-account workspace was indistinguishable from one that just hadn't
  // shown the second number yet. `AccountLabel` now answers it from the
  // workspace directory, which doesn't change per page.
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [callingId, setCallingId] = useState<string | null>(null);
  // Filters: free-text (contact name OR phone) + a ringingAt date range. `q` is
  // the live input; `appliedQ` is debounced so we don't refetch on every key.
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const reqIdRef = useRef(0);
  const call = useCallApi();

  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const hasFilters = appliedQ !== "" || from !== "" || to !== "";
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE));

  // A filter change always resets to page 1 — page N of the old filtered set is
  // meaningless against the new one (and would likely be out of range).
  useEffect(() => {
    setPage(1);
  }, [appliedQ, from, to]);

  // Fetch the current page. A request token drops a slow earlier response so a
  // fast filter/page switch can't be overwritten by a stale one.
  //
  // `silent` skips the loading flag: a live refresh triggered by a call ending
  // must not dim the table the agent is reading. Same request, same token
  // discipline — only the chrome differs.
  const fetchPage = useCallback(
    async ({ silent }: { silent?: boolean } = {}) => {
      const reqId = ++reqIdRef.current;
      if (!silent) setLoading(true);
      try {
        const p = new URLSearchParams({ take: String(PAGE), page: String(page) });
        if (appliedQ) p.set("q", appliedQ);
        // Date inputs are local calendar days; widen to the full local day and
        // send ISO so the server filters ringingAt in the agent's timezone.
        if (from) p.set("from", new Date(`${from}T00:00:00`).toISOString());
        if (to) p.set("to", new Date(`${to}T23:59:59.999`).toISOString());
        const res = await apiFetch(`/api/calls?${p.toString()}`);
        if (reqId !== reqIdRef.current) return; // superseded by a newer fetch
        if (!res.ok) {
          // A failed BACKGROUND refresh must not replace good rows with an
          // error screen — the agent didn't ask for it and the next frame or
          // interaction retries. Only a fetch the agent triggered reports.
          if (!silent) setError("Couldn't load calls");
          return;
        }
        const json = (await res.json()) as {
          items: CallRow[];
          totalCount?: number;
        };
        if (reqId !== reqIdRef.current) return;
        setError(null);
        setRows(json.items);
        if (json.totalCount != null) setTotalCount(json.totalCount);
      } catch {
        // Network error / aborted json — surface it rather than silently
        // leaving the previous page's rows (or a blank list) with no feedback.
        if (reqId === reqIdRef.current && !silent) setError("Couldn't load calls");
      } finally {
        // NOT gated on `silent`. A silent refresh bumps the request token, so
        // it can supersede a user-initiated fetch that is still in flight —
        // and that fetch then returns without clearing the flag it set. If the
        // silent winner didn't clear it too, the table would stay dimmed
        // forever. Redundant when nothing was loading; React bails on a
        // same-value setState.
        if (reqId === reqIdRef.current) setLoading(false);
      }
    },
    [appliedQ, from, to, page],
  );

  // Re-fetch whenever filters or the page number change.
  // reloadNonce lets the error-state Retry re-run this effect.
  useEffect(() => {
    void fetchPage();
  }, [fetchPage, reloadNonce]);

  // Artifacts land AFTER the call ends — often while this page is open,
  // showing the very call the agent just hung up. Patch the row in place off
  // the team-wide `call:artifacts` frame rather than refetching the page: no
  // scroll jump, no re-sort, and the play/transcript buttons simply appear.
  // A row not on the current page is nobody's concern; the fetch that brings
  // it in carries the same flags.
  useEffect(() => {
    const socket = getClientSocket();
    const onArtifacts: Parameters<typeof socket.on<"call:artifacts">>[1] = (p) => {
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === p.callId);
        if (idx < 0) return prev;
        const row = prev[idx]!;
        if (
          row.hasRecording === p.hasRecording &&
          row.hasTranscript === p.hasTranscript &&
          row.transcriptLanguage === p.transcriptLanguage
        ) {
          return prev;
        }
        const next = prev.slice();
        next[idx] = {
          ...row,
          hasRecording: p.hasRecording,
          hasTranscript: p.hasTranscript,
          transcriptLanguage: p.transcriptLanguage,
        };
        return next;
      });
    };
    socket.on("call:artifacts", onArtifacts);
    return () => {
      socket.off("call:artifacts", onArtifacts);
    };
  }, []);

  // A call that ENDS while this page is open belongs at the top of it. Only
  // page 1 of an unfiltered list can receive it — on page 3, or under a filter
  // the new call may not even match, a silent re-fetch would either do nothing
  // or yank the rows the agent is reading out from under them.
  //
  // Deliberately a re-fetch, not a client-side prepend: the row carries
  // server-resolved attribution (agent names, account label, connected) that
  // the terminal frame doesn't. Debounced so a burst of endings coalesces.
  const liveRefreshable = page === 1 && !hasFilters;
  useEffect(() => {
    if (!liveRefreshable) return;
    const socket = getClientSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onEnded = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fetchPage({ silent: true }), 400);
    };
    socket.on("call:ended", onEnded);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off("call:ended", onEnded);
    };
  }, [liveRefreshable, fetchPage]);

  const goToPage = (next: number) => {
    setPage(Math.min(Math.max(1, next), pageCount));
    // Jump the viewport back to the top so the new page starts at row 1.
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };

  const callBack = async (row: CallRow) => {
    setCallingId(row.id);
    try {
      const res = await call.initiateOutbound(
        row.conversationId,
        row.contactName ?? "Customer",
        // The row knows both, so the live panel can name the number this call
        // goes out FROM without waiting on a frame.
        row.channel,
        row.accountId,
      );
      if (!res.ok) {
        toast.error(
          "Couldn't start the call — the customer may need to message you again first.",
        );
      }
    } finally {
      setCallingId(null);
    }
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Calls</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Your team&apos;s WhatsApp call history — who called, when, and how it
          ended. Calls made with recording turned on keep their audio and
          transcript here for a limited time (see Settings → WhatsApp →
          Calling); other calls store no audio.
        </p>
      </header>

      {/* Filters: search by name/phone + a ringing-date range. Changing any one
          debounced-refetches page 1 (keyset pagination then walks the filtered
          set). */}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex min-w-55 flex-1 flex-col gap-1">
          <label htmlFor="calls-q" className="text-2xs font-medium text-muted-foreground">
            Search
          </label>
          <input
            id="calls-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or phone number"
            className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-hidden focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-foreground/10"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="calls-from" className="text-2xs font-medium text-muted-foreground">
            From
          </label>
          <input
            id="calls-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-hidden focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-foreground/10"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="calls-to" className="text-2xs font-medium text-muted-foreground">
            To
          </label>
          <input
            id="calls-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-hidden focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-foreground/10"
          />
        </div>
        {(q !== "" || from !== "" || to !== "") && (
          <Button
            variant="ghost"
            onClick={() => {
              setQ("");
              setFrom("");
              setTo("");
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {error && rows.length === 0 ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 py-16 text-center text-sm">
          <p className="text-destructive">{error}.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            Try again
          </Button>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <Phone className="mx-auto mb-2 size-6 opacity-40" />
          {hasFilters
            ? "No calls match your filters."
            : "No calls yet. Inbound and outbound WhatsApp calls will show up here."}
        </div>
      ) : (
        // Keep rows mounted + dimmed during a page/filter refetch instead of
        // blanking to a spinner — no full-height flash or layout jump.
        <ul
          className={cn(
            "overflow-hidden rounded-lg border border-border transition-opacity",
            loading && "pointer-events-none opacity-60",
          )}
        >
          {rows.map((row, i) => (
            <CallHistoryRow
              key={row.id}
              row={row}
              first={i === 0}
              canCall={canCall}
              calling={callingId === row.id}
              onCallBack={() => void callBack(row)}
            />
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <Pagination
          className="mt-4"
          page={page}
          pageCount={pageCount}
          onPageChange={goToPage}
          totalCount={totalCount}
          pageSize={PAGE}
          itemNoun="calls"
        />
      )}
    </div>
  );
}
