"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { motion } from "framer-motion";

import { getClientSocket } from "@/lib/socket/client";
import { cn, formatListTime, formatPhone } from "@/lib/utils";
import { BroadcastStatusBadge } from "../broadcast-status-badge";

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
  templateId: string;
  templateName: string;
  templateLanguage: string;
  audienceMode: string;
  variables: unknown;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  lastError: string | null;
  createdByName: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  recipients: BroadcastRecipientDto[];
}

export interface BroadcastRecipientDto {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  conversationId: string | null;
  status: string;
  externalId: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

const POLL_INTERVAL_MS = 2000;

export function BroadcastDetail({ initial }: { initial: BroadcastDetailDto }) {
  const [data, setData] = useState(initial);

  // Shared refresher so both the socket listeners and the poll go through
  // the same code path. Inside a ref so the socket effect can call it
  // without restarting on every render.
  const cancelledRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    try {
      const res = await fetch(`/api/broadcasts/${data.id}`);
      if (!res.ok) return;
      const json = (await res.json()) as { broadcast?: BroadcastDetailDto };
      if (cancelledRef.current || !json.broadcast) return;
      setData(json.broadcast);
    } catch {
      // Best effort — transient network blips just skip a tick.
    }
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
      void refreshRef.current();
    };
    const onProgress: Parameters<typeof socket.on<"broadcast:progress">>[1] = (
      payload,
    ) => {
      if (payload.broadcastId !== broadcastId) return;
      // Apply the summary counters immediately so the progress bar moves
      // without waiting on the follow-up fetch. The fetch will land within
      // a tick and refresh the recipient table too.
      setData((prev) => ({
        ...prev,
        sentCount: payload.sentCount,
        failedCount: payload.failedCount,
        totalCount: payload.totalCount,
      }));
      void refreshRef.current();
    };

    socket.on("broadcast:status", onStatus);
    socket.on("broadcast:progress", onProgress);
    return () => {
      socket.off("broadcast:status", onStatus);
      socket.off("broadcast:progress", onProgress);
    };
  }, [data.id]);

  // Poll fallback — defence in depth if the socket connection drops mid-
  // send. Stops once the broadcast finishes.
  useEffect(() => {
    cancelledRef.current = false;
    if (data.status !== "queued" && data.status !== "running") return;
    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(timer);
    };
  }, [data.status, data.id]);

  const variables = parseVariables(data.variables);
  const remaining = data.totalCount - data.sentCount - data.failedCount;
  const progressPct =
    data.totalCount === 0
      ? 0
      : Math.round(((data.sentCount + data.failedCount) / data.totalCount) * 100);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.templateName}
          </h1>
          <BroadcastStatusBadge status={data.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span>Language: {data.templateLanguage}</span>
          <span>·</span>
          <span>By {data.createdByName}</span>
          <span>·</span>
          <span>{formatListTime(data.createdAt)}</span>
          {data.completedAt && (
            <>
              <span>·</span>
              <span>Finished {formatListTime(data.completedAt)}</span>
            </>
          )}
        </div>
      </header>

      {data.lastError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-medium">Broadcast failed</div>
            <div className="mt-0.5 wrap-break-word font-mono text-[11px]">
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
            className="h-full bg-emerald-500"
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
      <div className="text-[11px] text-muted-foreground">
        {progressPct}% processed
        {(data.status === "queued" || data.status === "running") && " · updates live"}
      </div>

      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border bg-muted/30 px-4 py-3">
          <div className="text-sm font-semibold">Template snapshot</div>
          <div className="text-[11px] text-muted-foreground">
            Captured at the moment the broadcast was created — even if the
            template gets edited in WhatsApp Manager, this is what was sent.
          </div>
        </header>
        <div className="px-4 py-4">
          {(variables.header || variables.body.length > 0) && (
            <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-[12px]">
              {variables.header !== undefined && (
                <div className="flex flex-col">
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Header
                  </dt>
                  <dd className="font-mono">{variables.header || "—"}</dd>
                </div>
              )}
              {variables.body.map((v, i) => (
                <div key={i} className="flex flex-col">
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {`{{${i + 1}}}`}
                  </dt>
                  <dd className="font-mono">{v || "—"}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Recipients</div>
            <div className="text-[11px] text-muted-foreground">
              Per-recipient delivery status. Click a row to jump to its
              conversation.
            </div>
          </div>
        </header>
        <div className="max-h-120 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Contact</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">When</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.recipients.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/30"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.contactName}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatPhone(r.contactPhone)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <RecipientStatusPill recipient={r} />
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
                    {r.sentAt ? formatListTime(r.sentAt) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.conversationId ? (
                      <Link
                        href={`/inbox/${r.conversationId}`}
                        className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
                      >
                        Open chat
                        <ExternalLink className="size-3" />
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
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
      ? "border-emerald-500/30 bg-emerald-500/5"
      : tone === "destructive"
        ? "border-destructive/30 bg-destructive/5"
        : tone === "amber"
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-border bg-muted/20";
  return (
    <div className={cn("flex flex-col gap-1 rounded-xl border px-4 py-3", toneClass)}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
      <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-3.5" />
        Sent
      </span>
    );
  }
  if (recipient.status === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[12px] text-destructive"
        title={recipient.errorMessage ?? undefined}
      >
        <XCircle className="size-3.5" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
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
