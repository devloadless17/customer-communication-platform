"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Phone } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { useCallApi } from "@/features/calls/call-provider";
import {
  CallHistoryRow,
  type CallHistoryRowData,
} from "@/features/calls/components/call-history-row";

/**
 * Every call with THIS customer — the panel's fifth record type, alongside
 * details / files / notes / flags.
 *
 * The team-wide Calls page answers "what did the team do today"; this answers
 * the question an agent picking up a thread actually has: "have we spoken to
 * this person before, and what was said?" Filtering the global page down to one
 * customer took a search, a date guess, and a tab switch away from the chat.
 *
 * Rows render through the SHARED `CallHistoryRow`, so the recording player and
 * the transcript are the same ones the Calls page opens — no second
 * implementation of "what does this call mean" to drift.
 *
 * Conversation-scoped, exactly like the sibling tabs: a call belongs to the
 * thread it happened on. A customer linked across channels sees each channel's
 * calls in that channel's thread (the header's linked-channels switcher moves
 * between them).
 */

const PAGE = 25;

export function CallsPanel({
  conversationId,
  contactName,
  canMakeCalls,
}: {
  conversationId: string;
  /** Shown in the live-call panel when calling back from a row. */
  contactName: string;
  /** `calls:make` + the thread-level channel/region gates, resolved by the
   *  shell. False hides every call-back affordance (the history still reads). */
  canMakeCalls: boolean;
}) {
  const [rows, setRows] = useState<CallHistoryRowData[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callingId, setCallingId] = useState<string | null>(null);
  const call = useCallApi();
  // Drops a slow first-page response after the agent switched threads — the
  // panel remounts per conversation, but a StrictMode double-effect or a fast
  // switch can still land an older response last.
  const reqIdRef = useRef(0);

  const load = useCallback(
    async (opts: { cursor?: string | null } = {}) => {
      const reqId = ++reqIdRef.current;
      const params = new URLSearchParams({ take: String(PAGE) });
      if (opts.cursor) params.set("cursor", opts.cursor);
      try {
        const res = await apiFetch(
          `/api/conversations/${conversationId}/calls?${params.toString()}`,
        );
        if (reqId !== reqIdRef.current) return;
        if (!res.ok) throw new Error("Couldn't load calls");
        const body = (await res.json()) as {
          items: CallHistoryRowData[];
          cursor: string | null;
        };
        if (reqId !== reqIdRef.current) return;
        setRows((prev) =>
          opts.cursor && prev ? [...prev, ...body.items] : body.items,
        );
        setCursor(body.cursor);
        setError(null);
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        setError(err instanceof Error ? err.message : "Couldn't load calls");
        // Only blank the list on a FIRST-page failure — a failed "load older"
        // must not throw away the pages the agent is already reading.
        setRows((prev) => (opts.cursor ? prev : []));
      }
    },
    [conversationId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Converge on the calls that concern THIS thread. A call ending refetches the
  // first page (the terminal frame carries none of the server-resolved
  // attribution the row shows); artifacts patch in place, so an agent who just
  // hung up watches the play button appear without the list re-sorting under
  // them or the panel scrolling.
  useEffect(() => {
    const socket = getClientSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (payload: { conversationId?: string }) => {
      if (payload.conversationId && payload.conversationId !== conversationId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    const onArtifacts: Parameters<typeof socket.on<"call:artifacts">>[1] = (p) => {
      if (p.conversationId !== conversationId) return;
      setRows((prev) => {
        if (!prev) return prev;
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
    socket.on("call:ended", refresh);
    socket.on("call:ringing", refresh);
    socket.on("call:artifacts", onArtifacts);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off("call:ended", refresh);
      socket.off("call:ringing", refresh);
      socket.off("call:artifacts", onArtifacts);
    };
  }, [conversationId, load]);

  const callBack = async (row: CallHistoryRowData) => {
    setCallingId(row.id);
    try {
      const res = await call.initiateOutbound(
        conversationId,
        contactName,
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

  const loadOlder = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await load({ cursor });
    } finally {
      setLoadingMore(false);
    }
  };

  if (rows === null) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-xs text-muted-foreground">
        <p>{error}.</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 rounded-md border border-border px-2 py-1 text-2xs font-medium hover:bg-accent"
        >
          Try again
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-xs text-muted-foreground">
        <Phone className="mx-auto mb-2 size-5 opacity-40" />
        No calls with this customer yet. Calls placed from the header — and any
        they make to you — are logged here with their recording.
      </div>
    );
  }

  return (
    <div className="p-2">
      <ul className="overflow-hidden rounded-lg border border-border">
        {rows.map((row, i) => (
          <CallHistoryRow
            key={row.id}
            row={row}
            first={i === 0}
            compact
            canCall={canMakeCalls}
            calling={callingId === row.id}
            onCallBack={() => void callBack(row)}
          />
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={loadingMore}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-2xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          {loadingMore && <Loader2 className="size-3 animate-spin" />}
          Load older calls
        </button>
      )}
    </div>
  );
}
