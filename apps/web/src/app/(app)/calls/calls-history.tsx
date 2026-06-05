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
  const startedRef = useRef(false);
  const call = useCallApi();

  const fetchPage = useCallback(async (c?: string): Promise<void> => {
    const res = await apiFetch(
      `/api/calls?take=${PAGE}${c ? `&cursor=${encodeURIComponent(c)}` : ""}`,
    );
    if (!res.ok) return;
    const json = (await res.json()) as { items: CallRow[]; cursor: string | null };
    setRows((prev) => (c ? [...prev, ...json.items] : json.items));
    setCursor(json.cursor);
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
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

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <Phone className="mx-auto mb-2 size-6 opacity-40" />
          No calls yet. Inbound and outbound WhatsApp calls will show up here.
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
  good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
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
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {row.contactPhone}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
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
        className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
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
