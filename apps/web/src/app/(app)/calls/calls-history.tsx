"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
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
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";
import { useCallApi } from "@/features/calls/call-provider";

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
  durationSeconds: number | null;
  connected: boolean;
}

const PAGE = 50;

export function CallsHistory({ canCall }: { canCall: boolean }) {
  const [rows, setRows] = useState<CallRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
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

  const fetchPage = useCallback(
    async (c?: string): Promise<void> => {
      // First-page fetches (initial load / filter change) take a request token
      // so a slow earlier response can't overwrite newer filter results. A
      // `loadMore` (cursor set) rides the current token and is dropped if a
      // filter changed mid-flight (its page belongs to the old result set).
      const isFirst = !c;
      const reqId = isFirst ? ++reqIdRef.current : reqIdRef.current;
      const p = new URLSearchParams({ take: String(PAGE) });
      if (c) p.set("cursor", c);
      if (appliedQ) p.set("q", appliedQ);
      // Date inputs are local calendar days; widen to the full local day and
      // send ISO so the server filters ringingAt in the agent's timezone.
      if (from) p.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) p.set("to", new Date(`${to}T23:59:59.999`).toISOString());
      const res = await apiFetch(`/api/calls?${p.toString()}`);
      if (!res.ok) return;
      const json = (await res.json()) as { items: CallRow[]; cursor: string | null };
      if (reqId !== reqIdRef.current) return; // superseded by a newer filter fetch
      setRows((prev) => (c ? [...prev, ...json.items] : json.items));
      setCursor(json.cursor);
    },
    [appliedQ, from, to],
  );

  // (Re)load page 1 on mount and whenever a filter changes — `fetchPage`'s
  // identity changes with [appliedQ, from, to], so this effect re-runs then.
  useEffect(() => {
    setLoading(true);
    void fetchPage().finally(() => setLoading(false));
  }, [fetchPage]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(cursor);
    } finally {
      setLoadingMore(false);
    }
  };

  const callBack = async (row: CallRow) => {
    setCallingId(row.id);
    try {
      const res = await call.initiateOutbound(
        row.conversationId,
        row.contactName ?? "Customer",
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
          ended. Call audio isn&apos;t recorded: WhatsApp calls are end-to-end
          encrypted and peer-to-peer, so nothing passes through the server.
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

      {loading ? (
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
        <ul className="overflow-hidden rounded-lg border border-border">
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

      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
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
  onCallBack: () => void;
}) {
  const { Icon, label, tone, actor } = describe(row);
  const name = row.contactName?.trim() || row.contactPhone || "Unknown contact";

  return (
    <li
      data-call-row=""
      className={cn(
        "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40",
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
        </div>
      </div>

      <LocalTime
        iso={row.ringingAt}
        format="listTime"
        className="shrink-0 text-2xs tabular-nums text-muted-foreground"
      />

      <div className="flex shrink-0 items-center gap-1">
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
    </li>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
