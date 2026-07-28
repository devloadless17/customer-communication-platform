"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  FileText,
  Loader2,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
} from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  RecordingPlayer,
  TranscriptPanel,
} from "@/features/calls/call-artifacts";
import { toast } from "@/lib/toast";
import { useCallApi } from "@/features/calls/call-provider";
import { AccountLabel } from "@/features/channels/components/account-label";
import type { Channel } from "@ccp/shared/types";

/** Mirrors TeamCallRow in apps/api/src/calls/calls.service.ts. */
interface CallRow {
  id: string;
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  direction: "in" | "out";
  status: "ringing" | "in_progress" | "completed" | "missed" | "rejected" | "failed";
  initiatedByName: string | null;
  answeredByName: string | null;
  ringingAt: string;
  /** The call's channel — lets the row apply the standard "only show the
   *  account when this CHANNEL has more than one" rule, instead of guessing
   *  from whichever accounts appear in the current page. */
  channel: Channel;
  durationSeconds: number | null;
  connected: boolean;
  /** Opaque payload from the call button that produced an inbound call. */
  ctaPayload: string | null;
  /** Opaque payload from the wa.me/call deep link that produced it. */
  deeplinkPayload: string | null;
  /** True once the call's opted-in recording is stored and streamable. */
  hasRecording: boolean;
  /** True once the call's opted-in transcript document is stored. */
  hasTranscript: boolean;
  /** WHICH of our accounts on the channel this call was on (the thread's). */
  accountId: string | null;
  /** That account named for a human — the Settings label, else the number. */
  accountName: string | null;
  /** Auto-detected spoken language of the transcript (ISO 639, e.g. "ar"). */
  transcriptLanguage: string | null;
  /** Why a FAILED call failed, from the provider's terminate webhook. */
  errorTitle: string | null;
}

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

  // Fetch the current page whenever filters or the page number change. A
  // request token drops a slow earlier response so a fast filter/page switch
  // can't be overwritten by a stale one.
  useEffect(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    void (async () => {
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
          setError("Couldn't load calls");
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
        if (reqId === reqIdRef.current) setError("Couldn't load calls");
      }
    })().finally(() => {
      if (reqId === reqIdRef.current) setLoading(false);
    });
    // reloadNonce lets the error-state Retry re-run this effect.
  }, [appliedQ, from, to, page, reloadNonce]);

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
            <CallRowItem
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

type Tone = "neutral" | "good" | "warn" | "danger";

/** Direction + status → icon, one-line label, tone, and the attributed agent. */
function describe(row: CallRow): {
  Icon: typeof Phone;
  label: string;
  tone: Tone;
  actor: string | null;
} {
  const inbound = row.direction === "in";
  switch (row.status) {
    case "ringing":
    case "in_progress":
      return {
        Icon: inbound ? PhoneIncoming : PhoneOutgoing,
        label: inbound ? "Incoming call" : "Outgoing call",
        tone: "neutral",
        actor: inbound ? null : row.initiatedByName,
      };
    case "rejected":
      return {
        Icon: PhoneOff,
        label: inbound ? "Declined" : "Customer declined",
        tone: "danger",
        actor: inbound ? null : row.initiatedByName,
      };
    case "failed":
      return {
        Icon: PhoneOff,
        label: "Couldn't connect",
        tone: "danger",
        actor: inbound ? null : row.initiatedByName,
      };
    case "missed":
    case "completed":
    default:
      if (!row.connected) {
        return {
          Icon: inbound ? PhoneMissed : PhoneOutgoing,
          label: inbound ? "Missed call" : "No answer",
          tone: "warn",
          actor: inbound ? null : row.initiatedByName,
        };
      }
      return {
        Icon: inbound ? PhoneIncoming : PhoneOutgoing,
        label: inbound ? "Incoming call" : "Outgoing call",
        tone: "good",
        // Connected: outbound → who placed it; inbound → who answered.
        actor: inbound ? row.answeredByName : row.initiatedByName,
      };
  }
}

const TONE_RING: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-success-bg text-success-fg",
  warn: "bg-warning-bg text-warning-fg",
  danger: "bg-destructive/10 text-destructive",
};

function CallRowItem({
  row,
  first,
  canCall,
  calling,
  onCallBack,
}: {
  row: CallRow;
  first: boolean;
  canCall: boolean;
  calling: boolean;
  /** Does this workspace hold more than one account on the channel? Drives
   *  whether the "via <number>" fact is worth the pixels. */
  onCallBack: () => void;
}) {
  const { Icon, label, tone, actor } = describe(row);
  const name = row.contactName?.trim() || row.contactPhone || "Unknown contact";
  // Recording player / transcript panel, revealed on demand — nothing is
  // fetched until the agent asks for it.
  const [showPlayer, setShowPlayer] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  return (
    <li
      data-call-row=""
      className={cn(
        "flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40",
        !first && "border-t border-border",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          TONE_RING[tone],
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {row.contactPhone && row.contactName && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {row.contactPhone}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{label}</span>
          {actor && (
            <>
              <span className="opacity-50">·</span>
              <span className="font-medium text-foreground/70">{actor}</span>
            </>
          )}
          {row.durationSeconds !== null && row.durationSeconds > 0 && (
            <>
              <span className="opacity-50">·</span>
              <span className="tabular-nums">{formatDuration(row.durationSeconds)}</span>
            </>
          )}
          {/* WHICH of our numbers. Renders only when the CHANNEL actually has
              more than one account — on a single-number workspace it is noise,
              and on a multi-number one two calls from the same customer to two
              different numbers were indistinguishable in this log.
              `fallbackName` keeps a since-disconnected account named rather
              than silently re-attributing the call. */}
          <AccountLabel
            channel={row.channel}
            accountId={row.accountId}
            fallbackName={row.accountName}
            variant="inline"
            verb="Received on"
          />
          {row.status === "failed" && row.errorTitle && (
            <>
              <span className="opacity-50">·</span>
              <span className="min-w-0 truncate">{row.errorTitle}</span>
            </>
          )}
          {/* Origin attribution: which call button / deep link produced this
              inbound call. The payload is the campaign's own opaque tag, so
              show it verbatim in the tooltip and keep the label generic. */}
          {(row.ctaPayload ?? row.deeplinkPayload) && (
            <>
              <span className="opacity-50">·</span>
              <span
                className="rounded bg-muted px-1 py-px text-2xs"
                title={row.ctaPayload ?? row.deeplinkPayload ?? undefined}
              >
                {row.ctaPayload ? "via call button" : "via call link"}
              </span>
            </>
          )}
        </div>
      </div>

      <LocalTime
        iso={row.ringingAt}
        format="listTime"
        className="shrink-0 text-2xs tabular-nums text-muted-foreground"
      />

      <div className="flex shrink-0 items-center gap-1">
        {row.hasRecording && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8", showPlayer && "text-primary")}
            title="Play recording"
            aria-label="Play recording"
            aria-pressed={showPlayer}
            onClick={() => setShowPlayer((v) => !v)}
          >
            <AudioLines className="size-4" />
          </Button>
        )}
        {row.hasTranscript && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8", showTranscript && "text-primary")}
            title={`Transcript${row.transcriptLanguage ? ` (${row.transcriptLanguage.toUpperCase()})` : ""}`}
            aria-label="Show transcript"
            aria-pressed={showTranscript}
            onClick={() => setShowTranscript((v) => !v)}
          >
            <FileText className="size-4" />
          </Button>
        )}
        <Button asChild variant="ghost" size="icon" title="Open chat" className="size-8">
          <Link href={`/inbox?c=${row.conversationId}`} aria-label="Open chat">
            <MessageSquare className="size-4" />
          </Link>
        </Button>
        {canCall && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Call back"
            aria-label="Call back"
            disabled={calling}
            onClick={onCallBack}
          >
            {calling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Phone className="size-4" />
            )}
          </Button>
        )}
      </div>

      {showPlayer && (
        <div className="basis-full pl-12">
          <RecordingPlayer callId={row.id} />
        </div>
      )}

      {showTranscript && (
        <div className="basis-full pl-12">
          <TranscriptPanel callId={row.id} />
        </div>
      )}
    </li>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
