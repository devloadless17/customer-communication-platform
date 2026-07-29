"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/layouts/page-header";
import { CHANNEL_LABEL } from "@/features/inbox/components/channel-badge";
import {
  AXIS_PROPS,
  ChartEmpty,
  ChartLegend,
  ChartPanel,
  ChartTooltipBody,
  ClientOnly,
  GRID_PROPS,
  SERIES_COLORS,
  compactNumber,
} from "@/features/charts/chart-primitives";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";
import { cn } from "@ccp/shared/utils";
import type { Channel } from "@ccp/shared/types";
import type { WorkspaceReport } from "@ccp/shared/dtos";

/**
 * Workspace performance dashboard.
 *
 * One GET per range change (`/api/reports/overview` returns every panel), so
 * switching 7d → 30d is a single round-trip. Daily buckets flip at the
 * BROWSER's midnight — the tz travels with the request.
 *
 * Durations render "—" when null: "no data" and "instant" must never look
 * alike (the DTO's contract).
 */

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const VOLUME_SERIES = [
  { key: "inbound", label: "Received", color: SERIES_COLORS[0] },
  { key: "outbound", label: "Sent", color: SERIES_COLORS[1] },
] as const;

const CHART_HEIGHT = 260;

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86_400)}d ${Math.round((sec % 86_400) / 3600)}h`;
}

/** "98%" attainment, or null when the range has no SLA-tracked tickets. */
function slaMet(bucket: { withSla: number; breached: number }): string | null {
  if (bucket.withSla === 0) return null;
  const met = bucket.withSla - bucket.breached;
  return `${Math.round((met / bucket.withSla) * 100)}%`;
}

/** Fill absent days so a quiet weekend renders as zero bars, not a gap the
 *  x-axis silently skips (which would make Mon look adjacent to Fri). */
function fillDays(
  daily: WorkspaceReport["volume"]["daily"],
  from: Date,
  to: Date,
): Array<{ day: string; label: string; inbound: number; outbound: number }> {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: Array<{ day: string; label: string; inbound: number; outbound: number }> = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= to) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${d}`;
    const row = byDay.get(key);
    out.push({
      day: key,
      label: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      inbound: row?.inbound ?? 0,
      outbound: row?.outbound ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function ReportsClient() {
  const [days, setDays] = useState<number>(30);
  // Scope every panel to ONE of the workspace's numbers/Pages. A workspace
  // running a Sales and a Support line is two operations sharing a medium, and
  // a blended first-response time hides one drowning behind the other.
  // Null = the whole workspace, which stays the default.
  const [accountId, setAccountId] = useState<string | null>(null);
  const { all: allAccounts } = useChannelAccounts();
  // Only offer accounts on channels that actually hold more than one — the
  // same "attribution is a disambiguator" rule the inbox chip follows, so a
  // single-number workspace sees no new control at all.
  const scopeAccounts = useMemo(() => {
    const perChannel = new Map<string, number>();
    for (const a of allAccounts) {
      if (a.isActive) perChannel.set(a.channel, (perChannel.get(a.channel) ?? 0) + 1);
    }
    return allAccounts.filter((a) => a.isActive && (perChannel.get(a.channel) ?? 0) > 1);
  }, [allAccounts]);
  const [report, setReport] = useState<WorkspaceReport | null>(null);
  const [error, setError] = useState(false);
  // The range is computed once per selection (not per render) so the request
  // URL is stable and an eslint-exhaustive-deps refetch loop can't start.
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from, to };
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(false);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const qs = new URLSearchParams({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      tz,
      ...(accountId ? { accountId } : {}),
    });
    void (async () => {
      try {
        const res = await fetchWithSessionGuard(`/api/reports/overview?${qs}`);
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = (await res.json()) as WorkspaceReport;
        if (!cancelled) setReport(body);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, accountId]);

  const daily = useMemo(
    () => (report ? fillDays(report.volume.daily, range.from, range.to) : []),
    [report, range],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 md:px-8">
      <PageHeader
        title="Reports"
        description="How the workspace is performing — volumes, response times, agents, SLA, and the AI's share."
        action={
          <div className="flex items-center gap-2">
            {/* Account scope. Hidden entirely unless some channel actually
                holds more than one account — a single-number workspace has
                nothing to disambiguate and the control would be pure noise. */}
            {scopeAccounts.length > 0 && (
              <select
                value={accountId ?? ""}
                onChange={(e) => setAccountId(e.target.value || null)}
                aria-label="Scope the report to one account"
                className="h-8 rounded-lg border border-border bg-card px-2 text-xs"
              >
                <option value="">All accounts</option>
                {scopeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          <div
            role="radiogroup"
            aria-label="Report range"
            className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                role="radio"
                aria-checked={days === r.days}
                onClick={() => setDays(r.days)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  days === r.days
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          </div>
        }
      />

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-6 text-center text-sm text-muted-foreground">
          Couldn&apos;t load the report. Switch the range or reload to retry.
        </div>
      ) : (
        <>
          {/* Headline tiles. */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Received" value={report ? compactNumber(report.volume.inbound) : null} />
            <StatTile label="Sent" value={report ? compactNumber(report.volume.outbound) : null} />
            <StatTile
              label="Conversations opened"
              value={report ? compactNumber(report.volume.conversationsOpened) : null}
            />
            <StatTile
              label="Conversations closed"
              value={report ? compactNumber(report.volume.conversationsClosed) : null}
            />
            <StatTile
              label="Median first response"
              value={report ? fmtDuration(report.firstResponse.medianSec) : null}
              hint={
                report && report.firstResponse.answeredConversations > 0
                  ? `avg ${fmtDuration(report.firstResponse.avgSec)}`
                  : undefined
              }
            />
            <StatTile
              label="Median resolution"
              value={report ? fmtDuration(report.resolution.medianSec) : null}
              hint={
                report && report.resolution.closedConversations > 0
                  ? `avg ${fmtDuration(report.resolution.avgSec)}`
                  : undefined
              }
            />
          </section>

          {/* Daily volume. */}
          <ChartPanel
            title="Messages per day"
            subtitle="Received vs sent, bucketed at your local midnight."
            height={CHART_HEIGHT}
          >
            <ClientOnly height={CHART_HEIGHT}>
              {report === null ? (
                <div className="h-full animate-pulse rounded-lg bg-muted/30" />
              ) : report.volume.inbound + report.volume.outbound === 0 ? (
                <ChartEmpty message="No messages in this range yet — the chart fills in as conversations happen." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={daily}
                    margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
                    barCategoryGap="25%"
                    barGap={2}
                  >
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={28} />
                    <YAxis {...AXIS_PROPS} tickFormatter={compactNumber} width={44} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: "var(--accent)", opacity: 0.35 }}
                      content={({ active, payload, label }) =>
                        active && payload?.length ? (
                          <ChartTooltipBody
                            label={String(label)}
                            rows={VOLUME_SERIES.map((s) => ({
                              label: s.label,
                              value: String(
                                (payload.find((p) => p.dataKey === s.key)?.value as number) ?? 0,
                              ),
                              color: s.color,
                            }))}
                          />
                        ) : null
                      }
                    />
                    {VOLUME_SERIES.map((s) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        fill={s.color}
                        radius={[4, 4, 0, 0]}
                        maxBarSize={22}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ClientOnly>
            <ChartLegend series={VOLUME_SERIES.map((s) => ({ label: s.label, color: s.color }))} />
          </ChartPanel>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* Channel split — a table, not a chart: ≤4 rows of exact numbers. */}
            <Panel title="By channel">
              {report === null ? (
                <PanelSkeleton rows={3} />
              ) : report.channels.length === 0 ? (
                <PanelEmpty message="No messages in this range." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 font-semibold">Channel</th>
                      <th className="py-2 text-right font-semibold">Received</th>
                      <th className="py-2 text-right font-semibold">Sent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.channels.map((c) => (
                      <tr key={c.channel}>
                        <td className="py-2 font-medium">
                          {CHANNEL_LABEL[c.channel as Channel] ?? c.channel}
                        </td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(c.inbound)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(c.outbound)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            {/* Per-ACCOUNT split. Rendered only when the workspace actually
                runs more than one account somewhere — on a single-number
                workspace it would just restate the channel table above.
                Finer than "By channel": Sales and Support are separate
                operations sharing a medium. */}
            {scopeAccounts.length > 0 && (
              <Panel title="By account">
                {report === null ? (
                  <PanelSkeleton rows={3} />
                ) : report.accounts.length === 0 ? (
                  <PanelEmpty message="No messages in this range." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 font-semibold">Account</th>
                        <th className="py-2 text-right font-semibold">Received</th>
                        <th className="py-2 text-right font-semibold">Sent</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {report.accounts.map((a) => (
                        <tr key={a.accountId ?? "unattributed"}>
                          <td className="py-2 font-medium">
                            {/* Traffic whose account was disconnected is
                                LABELLED, not dropped — otherwise the rows stop
                                adding up to the channel table with no cause. */}
                            {a.name ?? (
                              <span className="text-muted-foreground">Unattributed</span>
                            )}
                            <span className="ml-1.5 text-2xs text-muted-foreground">
                              {CHANNEL_LABEL[a.channel as Channel] ?? a.channel}
                            </span>
                          </td>
                          <td className="py-2 text-right tabular-nums">{compactNumber(a.inbound)}</td>
                          <td className="py-2 text-right tabular-nums">{compactNumber(a.outbound)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            )}

            {/* Ticket SLA + AI share, stacked beside the channel table. */}
            <div className="flex flex-col gap-5">
              <Panel title="Ticket SLA">
                {report === null ? (
                  <PanelSkeleton rows={2} />
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <MiniStat label="Tickets created" value={String(report.sla.ticketsCreated)} />
                    <MiniStat
                      label="First-response met"
                      value={slaMet(report.sla.firstResponse) ?? "—"}
                      hint={
                        report.sla.firstResponse.withSla > 0
                          ? `${report.sla.firstResponse.withSla - report.sla.firstResponse.breached} of ${report.sla.firstResponse.withSla}`
                          : "no SLA-tracked tickets"
                      }
                    />
                    <MiniStat
                      label="Resolution met"
                      value={slaMet(report.sla.resolution) ?? "—"}
                      hint={
                        report.sla.resolution.withSla > 0
                          ? `${report.sla.resolution.withSla - report.sla.resolution.breached} of ${report.sla.resolution.withSla}`
                          : "no SLA-tracked tickets"
                      }
                    />
                  </div>
                )}
              </Panel>
              <Panel title="AI share">
                {report === null ? (
                  <PanelSkeleton rows={2} />
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <MiniStat label="AI replies" value={compactNumber(report.ai.aiMessages)} />
                    <MiniStat
                      label="Conversations with AI"
                      value={compactNumber(report.ai.aiConversations)}
                    />
                    <MiniStat
                      label="Handled by AI alone"
                      value={compactNumber(report.ai.aiOnlyConversations)}
                      hint="every reply in range was AI"
                    />
                  </div>
                )}
              </Panel>
            </div>
          </div>

          {/* Per-agent table. */}
          <Panel title="Agents">
            {report === null ? (
              <PanelSkeleton rows={4} />
            ) : report.agents.length === 0 ? (
              <PanelEmpty message="No agent activity in this range." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 font-semibold">Agent</th>
                      <th className="py-2 text-right font-semibold">Messages sent</th>
                      <th className="py-2 text-right font-semibold">Closed</th>
                      <th className="py-2 text-right font-semibold">First replies</th>
                      <th className="py-2 text-right font-semibold">Median first response</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.agents.map((a) => (
                      <tr key={a.userId}>
                        <td className="py-2 font-medium">
                          {a.name ?? <span className="text-muted-foreground">Former member</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(a.messagesSent)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(a.conversationsClosed)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(a.answeredConversations)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtDuration(a.medianFirstResponseSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  /** null = still loading (skeleton). */
  value: string | null;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5">
      {value === null ? (
        <div className="h-7 w-14 animate-pulse rounded bg-muted/40" />
      ) : (
        <div className="tabular-nums text-2xl font-semibold">{value}</div>
      )}
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && value !== null && <div className="text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="tabular-nums text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-2xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-6 animate-pulse rounded bg-muted/30" />
      ))}
    </div>
  );
}

function PanelEmpty({ message }: { message: string }) {
  return <p className="py-4 text-center text-xs text-muted-foreground">{message}</p>;
}
