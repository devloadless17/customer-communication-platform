"use client";

/**
 * Campaign report — the delivery funnel, what went wrong, and what to do next.
 *
 * The governing idea: every block owns a primary ACTION. A number that doesn't
 * lead somewhere is a scoreboard, and scoreboards get looked at once. So each
 * funnel stage deep-links the recipient table filtered to exactly those people,
 * and each diagnostic card states why something happened plus the one thing to
 * do about it.
 *
 * The funnel is a horizontal bar CASCADE, not a trapezoid "funnel chart". The
 * information an operator actually needs is the DROP-OFF between stages, which
 * a cascade shows directly and a trapezoid obscures. It's also plain CSS +
 * framer-motion (already a dependency, already driving the progress bar), so
 * live updates animate for free.
 */

import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Info } from "lucide-react";

import { cn } from "@ccp/shared/utils";

export interface BroadcastReportDto {
  broadcastId: string;
  funnel: {
    targeted: number;
    pending: number;
    failedAtSend: number;
    sent: number;
    delivered: number;
    read: number;
    undelivered: number;
    accepted: number;
    reached: number;
    neverReceived: number;
    replied: number;
    clicked: number;
    optedOut: number;
    suppressed: number;
  };
  rates: {
    deliveryRate: number | null;
    readRate: number | null;
    failureRate: number | null;
    replyRate: number | null;
    clickRate: number | null;
  };
  benchmark: { deliveryRate: number | null; readRate: number | null; campaigns: number } | null;
  cost: { billable: number; byCategory: Array<{ category: string; count: number }> };
  failures: Array<{
    errorCode: string;
    label: string;
    count: number;
    bucket: "retryable" | "permanent" | "suppress";
    sampleMessage: string | null;
  }>;
  diagnostics: Array<{
    severity: "warn" | "info";
    code: string;
    title: string;
    detail: string;
    action?: { label: string; filter?: string };
  }>;
  throughput: {
    startedAt: string | null;
    completedAt: string | null;
    durationSec: number | null;
    perMinute: number | null;
  };
  generatedAt: string;
}

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** Bucket → what the operator can do. Drives the chip copy in the failure table. */
const BUCKET_COPY: Record<string, { label: string; tone: string }> = {
  retryable: {
    label: "Can retry",
    tone: "border-warning-border bg-warning-bg text-warning-fg",
  },
  permanent: {
    label: "Clean list",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  suppress: {
    label: "Don't retry",
    tone: "border-border bg-muted/40 text-muted-foreground",
  },
};

export function BroadcastReport({
  report,
  onFilter,
}: {
  report: BroadcastReportDto;
  /** Deep-link the recipient table to a segment — the funnel's whole point. */
  onFilter?: (filter: string) => void;
}) {
  const { funnel, rates, benchmark, failures, diagnostics } = report;

  // Cascade stages. Each carries the filter that isolates its population, so a
  // stage is one click from "who exactly are these people".
  const stages = [
    { key: "targeted", label: "Targeted", value: funnel.targeted, filter: "outcome=all", tone: "bg-muted-foreground/40" },
    { key: "accepted", label: "Accepted by Meta", value: funnel.accepted, filter: "outcome=accepted", tone: "bg-info-fg/60" },
    { key: "reached", label: "Reached the phone", value: funnel.reached, filter: "outcome=delivered", tone: "bg-success-fg/70" },
    { key: "read", label: "Read", value: funnel.read, filter: "outcome=read", tone: "bg-primary/70" },
  ];
  const max = Math.max(funnel.targeted, 1);

  return (
    <div className="space-y-6">
      {/* ── Diagnostics: the actionability layer. Renders nothing when clean, so
             a healthy campaign shows no noise at all. ─────────────────────── */}
      {diagnostics.length > 0 && (
        <div className="space-y-2">
          {diagnostics.map((d) => (
            <div
              key={d.code}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-xs",
                d.severity === "warn"
                  ? "border-warning-border bg-warning-bg text-warning-fg"
                  : "border-border bg-muted/30 text-foreground",
              )}
            >
              <div className="flex items-start gap-2">
                {d.severity === "warn" ? (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{d.title}</p>
                  <p className="mt-0.5 opacity-80">{d.detail}</p>
                  {d.action && (
                    <button
                      type="button"
                      onClick={() => d.action?.filter && onFilter?.(d.action.filter)}
                      disabled={!d.action.filter}
                      className="mt-1.5 inline-flex items-center gap-1 font-medium underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                    >
                      {d.action.label}
                      {d.action.filter && <ArrowRight className="size-3" />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Funnel cascade ─────────────────────────────────────────────────── */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Delivery funnel
          </h3>
          {rates.deliveryRate !== null && (
            <span className="text-2xs text-muted-foreground">
              {pct(rates.deliveryRate)} delivered
              {benchmark?.deliveryRate != null && (
                <> · avg {pct(benchmark.deliveryRate)} over {benchmark.campaigns}</>
              )}
            </span>
          )}
        </div>
        <div className="space-y-1.5">
          {stages.map((s, i) => {
            const prev = i > 0 ? stages[i - 1]!.value : null;
            const drop = prev !== null ? prev - s.value : null;
            return (
              <div key={s.key}>
                <button
                  type="button"
                  onClick={() => onFilter?.(s.filter)}
                  className="group flex w-full items-center gap-3 text-left"
                >
                  <span className="w-36 shrink-0 truncate text-xs text-muted-foreground group-hover:text-foreground">
                    {s.label}
                  </span>
                  <span className="relative h-6 flex-1 overflow-hidden rounded bg-muted/50">
                    <motion.span
                      className={cn("absolute inset-y-0 left-0 rounded", s.tone)}
                      initial={false}
                      animate={{ width: `${(s.value / max) * 100}%` }}
                      transition={{ duration: 0.4 }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs font-medium tabular-nums">
                    {s.value.toLocaleString()}
                  </span>
                </button>
                {/* The drop-off between stages is the actual signal — surface it
                    explicitly rather than making the operator subtract. */}
                {drop !== null && drop > 0 && (
                  <div className="ml-36 pl-3 text-3xs text-muted-foreground">
                    ↓ {drop.toLocaleString()} lost here
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Engagement + cost. Rates are against people who actually RECEIVED
             the message: a reply rate over the full audience would flatter a
             campaign that mostly failed to deliver. ─────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => onFilter?.("outcome=replied")}
          className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40"
        >
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Replied</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">
            {funnel.replied.toLocaleString()}
          </div>
          <div className="text-3xs text-muted-foreground">{pct(rates.replyRate)} of delivered</div>
        </button>
        <button
          type="button"
          onClick={() => onFilter?.("outcome=clicked")}
          className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40"
        >
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Tapped a button</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">
            {funnel.clicked.toLocaleString()}
          </div>
          <div className="text-3xs text-muted-foreground">{pct(rates.clickRate)} of delivered</div>
        </button>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Billable</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">
            {report.cost.billable.toLocaleString()}
          </div>
          <div className="truncate text-3xs text-muted-foreground">
            {report.cost.byCategory.map((c) => c.category).join(", ") || "conversations"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Opted out</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">
            {funnel.optedOut.toLocaleString()}
          </div>
          <div className="text-3xs text-muted-foreground">
            {funnel.suppressed > 0
              ? `${funnel.suppressed.toLocaleString()} pre-suppressed`
              : "excluded from future sends"}
          </div>
        </div>
      </div>

      {/* ── Never received: the question clients actually ask ──────────────── */}
      {funnel.neverReceived > 0 && (
        <button
          type="button"
          onClick={() => onFilter?.("outcome=never_received")}
          className="flex w-full items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-left transition-colors hover:bg-destructive/10"
        >
          <div>
            <p className="text-xs font-medium text-destructive">
              {funnel.neverReceived.toLocaleString()} never received the message
            </p>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {funnel.failedAtSend.toLocaleString()} rejected before sending ·{" "}
              {funnel.undelivered.toLocaleString()} accepted but undeliverable
            </p>
          </div>
          <ArrowRight className="size-4 shrink-0 text-destructive" />
        </button>
      )}

      {/* ── Failure breakdown, bucketed by what to do about it ─────────────── */}
      {failures.length > 0 && (
        <div>
          <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Why messages failed
          </h3>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border">
                {failures.map((f) => {
                  const chip = BUCKET_COPY[f.bucket] ?? BUCKET_COPY.permanent!;
                  return (
                    <tr key={f.errorCode} className="hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => onFilter?.(`errorCode=${f.errorCode}`)}
                          className="text-left font-medium hover:underline"
                        >
                          {f.label}
                        </button>
                        {f.sampleMessage && (
                          <p className="mt-0.5 truncate text-3xs text-muted-foreground">
                            {f.sampleMessage}
                          </p>
                        )}
                      </td>
                      <td className="w-24 px-3 py-2">
                        <span className={cn("rounded-full border px-1.5 py-0.5 text-3xs font-medium", chip.tone)}>
                          {chip.label}
                        </span>
                      </td>
                      <td className="w-16 px-3 py-2 text-right font-medium tabular-nums">
                        {f.count.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
