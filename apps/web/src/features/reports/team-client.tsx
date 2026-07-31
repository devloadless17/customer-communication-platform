"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
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
import {
  fillDays,
  fmtDuration,
  Panel,
  StatTile,
} from "@/features/reports/report-primitives";
import {
  computeReportRange,
  DEFAULT_RANGE,
  ReportControls,
  type ReportRangeSelection,
} from "@/features/reports/report-controls";
import { TeamHeatmap } from "@/features/reports/team-heatmap";
import { ReportsNav } from "@/features/reports/reports-nav";
import { AgentDetailSheet } from "@/features/reports/agent-detail-sheet";
import { TeamNowStrip, type NowStripMember } from "@/features/reports/team-now-strip";
import { TeamTable } from "@/features/reports/team-table";
import type { TeamLiveSnapshot, TeamReport, TeamReportAgent } from "@ccp/shared/dtos";

/**
 * Team performance page — the per-agent lens on the workspace. Mirrors the
 * overview's data flow: one GET per range/scope change returns everything;
 * daily buckets flip at the BROWSER's midnight (tz travels with the request);
 * durations render "—" when null ("no data" and "instant" must never look
 * alike). The live strip is range-independent and converges through its own
 * socket-debounced snapshot refetch.
 */

const DAILY_SERIES = [
  { key: "messagesSent", label: "Messages sent", color: SERIES_COLORS[0] },
  { key: "conversationsClosed", label: "Closed", color: SERIES_COLORS[1] },
] as const;

const LEADERBOARD_METRICS = [
  { key: "closed", label: "Conversations closed", get: (a: TeamReportAgent) => a.conversations.closed },
  { key: "sent", label: "Messages sent", get: (a: TeamReportAgent) => a.messages.sent },
  { key: "talkTime", label: "Talk time", get: (a: TeamReportAgent) => a.calls.talkTimeTotalSec },
] as const;
type LeaderboardMetricKey = (typeof LEADERBOARD_METRICS)[number]["key"];

const CHART_HEIGHT = 260;
const LEADERBOARD_ROWS = 10;

/**
 * CSV of the full per-agent table (client-side — the data is already in the
 * browser). Durations exported in SECONDS and minutes as raw numbers so the
 * sheet stays sortable; empty cell = null ("no data", never fake 0).
 */
function exportAgentsCsv(report: TeamReport) {
  const esc = (v: string | number | null): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "Agent", "Email", "Role", "Deactivated",
    "Conversations assigned", "Conversations closed", "Open now", "First replies",
    "Median first response (sec)", "Avg first response (sec)",
    "Median resolution (sec)", "Avg resolution (sec)",
    "Messages sent", "Notes",
    "Calls placed", "Calls answered", "Talk time (sec)",
    "Tickets created", "Tickets resolved", "FR SLA breached", "Resolution SLA breached",
    "Open assigned tickets", "Online (min)",
  ];
  const rows = report.agents.map((a) => [
    a.name ?? "Former member", a.email, a.role, a.deactivated ? "yes" : "no",
    a.conversations.assigned, a.conversations.closed, a.conversations.openNow,
    a.conversations.firstReplies,
    a.conversations.medianFirstResponseSec, a.conversations.avgFirstResponseSec,
    a.conversations.medianResolutionSec, a.conversations.avgResolutionSec,
    a.messages.sent, a.messages.notesAuthored,
    a.calls.placed, a.calls.answered, a.calls.talkTimeTotalSec,
    a.tickets.created, a.tickets.resolved,
    a.tickets.firstResponseBreached, a.tickets.resolutionBreached,
    a.tickets.openAssignedNow, a.onlineMinutes,
  ]);
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const fromDay = report.range.from.slice(0, 10);
  const toDay = report.range.to.slice(0, 10);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `team-report_${fromDay}_${toDay}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** An agent with nothing at all in range — hidden from the leaderboard, kept
 *  in the table (a zero row is information there, noise in a chart). */
function hasActivity(a: TeamReportAgent): boolean {
  return (
    a.conversations.assigned +
      a.conversations.closed +
      a.conversations.firstReplies +
      a.messages.sent +
      a.messages.notesAuthored +
      a.calls.placed +
      a.calls.answered +
      a.tickets.created +
      a.tickets.resolved >
    0
  );
}

export function TeamClient({
  workspaceId,
  currentUserId,
  members,
  initialLive,
}: {
  workspaceId: string;
  currentUserId: string;
  members: NowStripMember[];
  initialLive: TeamLiveSnapshot;
}) {
  const [rangeSel, setRangeSel] = useState<ReportRangeSelection>(DEFAULT_RANGE);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [report, setReport] = useState<TeamReport | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<TeamReportAgent | null>(null);
  const [leaderboardMetric, setLeaderboardMetric] = useState<LeaderboardMetricKey>("closed");

  const avatarById = useMemo(
    () => new Map(members.map((m) => [m.userId, m.avatarUrl])),
    [members],
  );

  // Computed once per selection so the request URL is stable and an
  // exhaustive-deps refetch loop can't start (same rule as the overview).
  const range = useMemo(() => computeReportRange(rangeSel), [rangeSel]);

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
        const res = await fetchWithSessionGuard(`/api/reports/team?${qs}`);
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = (await res.json()) as TeamReport;
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
    () =>
      report
        ? fillDays(report.daily, range.from, range.to, ["messagesSent", "conversationsClosed"])
        : [],
    [report, range],
  );

  const activeAgentCount = useMemo(
    () => (report ? report.agents.filter(hasActivity).length : 0),
    [report],
  );

  const leaderboard = useMemo(() => {
    if (!report) return [];
    const metric = LEADERBOARD_METRICS.find((m) => m.key === leaderboardMetric)!;
    return report.agents
      .filter(hasActivity)
      .map((a) => ({
        name: a.name ?? "Former member",
        value: metric.get(a),
      }))
      .sort((x, y) => y.value - x.value)
      .slice(0, LEADERBOARD_ROWS);
  }, [report, leaderboardMetric]);

  const leaderboardLabel = LEADERBOARD_METRICS.find((m) => m.key === leaderboardMetric)!.label;
  const leaderboardIsDuration = leaderboardMetric === "talkTime";
  const fmtLeaderboard = (v: number) =>
    leaderboardIsDuration ? fmtDuration(v) : compactNumber(v);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 md:px-8">
      <ReportsNav />
      <PageHeader
        title="Team"
        description="Who's doing what — live activity plus per-agent conversations, messages, calls and tickets."
        action={
          <ReportControls
            value={rangeSel}
            onChange={setRangeSel}
            accountId={accountId}
            onAccountChange={setAccountId}
          />
        }
      />

      <TeamNowStrip
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        members={members}
        initial={initialLive}
      />

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-6 text-center text-sm text-muted-foreground">
          Couldn&apos;t load the team report. Switch the range or reload to retry.
        </div>
      ) : (
        <>
          {/* Headline tiles. */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile
              label="Active agents"
              value={report ? compactNumber(activeAgentCount) : null}
              hint={report ? `of ${report.agents.length} listed` : undefined}
            />
            <StatTile
              label="Conversations assigned"
              value={report ? compactNumber(report.totals.conversationsAssigned) : null}
            />
            <StatTile
              label="Conversations closed"
              value={report ? compactNumber(report.totals.conversationsClosed) : null}
            />
            <StatTile
              label="Median first response"
              value={report ? fmtDuration(report.totals.firstResponse.medianSec) : null}
              hint={
                report && report.totals.firstResponse.answeredConversations > 0
                  ? `avg ${fmtDuration(report.totals.firstResponse.avgSec)}`
                  : undefined
              }
            />
            <StatTile
              label="Messages sent"
              value={report ? compactNumber(report.totals.messagesSent) : null}
              hint={report && report.totals.notesAuthored > 0 ? `+ ${compactNumber(report.totals.notesAuthored)} notes` : undefined}
            />
            <StatTile
              label="Talk time"
              value={report ? fmtDuration(report.totals.talkTimeTotalSec) : null}
              hint={
                report && report.totals.callsAnswered > 0
                  ? `${compactNumber(report.totals.callsAnswered)} answered · ${compactNumber(report.totals.callsMissed)} missed`
                  : report && report.totals.callsMissed > 0
                    ? `${compactNumber(report.totals.callsMissed)} missed`
                    : undefined
              }
            />
          </section>

          {/* Team output per day. */}
          <ChartPanel
            title="Team activity per day"
            subtitle="Agent-sent messages and closed conversations, bucketed at your local midnight."
            height={CHART_HEIGHT}
          >
            <ClientOnly height={CHART_HEIGHT}>
              {report === null ? (
                <div className="h-full animate-pulse rounded-lg bg-muted/30" />
              ) : report.totals.messagesSent + report.totals.conversationsClosed === 0 ? (
                <ChartEmpty message="No agent activity in this range yet — the chart fills in as the team works." />
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
                            rows={DAILY_SERIES.map((s) => ({
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
                    {DAILY_SERIES.map((s) => (
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
            <ChartLegend series={DAILY_SERIES.map((s) => ({ label: s.label, color: s.color }))} />
          </ChartPanel>

          {/* Leaderboard — who carried the selected metric. */}
          <ChartPanel
            title="Leaderboard"
            subtitle={`Top agents by ${leaderboardLabel.toLowerCase()}.`}
            height={CHART_HEIGHT}
            action={
              <select
                value={leaderboardMetric}
                onChange={(e) => setLeaderboardMetric(e.target.value as LeaderboardMetricKey)}
                aria-label="Leaderboard metric"
                className="h-8 rounded-lg border border-border bg-card px-2 text-xs"
              >
                {LEADERBOARD_METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            }
          >
            <ClientOnly height={CHART_HEIGHT}>
              {report === null ? (
                <div className="h-full animate-pulse rounded-lg bg-muted/30" />
              ) : leaderboard.length === 0 || leaderboard.every((r) => r.value === 0) ? (
                <ChartEmpty message="No agent activity in this range yet." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={leaderboard}
                    layout="vertical"
                    margin={{ top: 4, right: 24, bottom: 0, left: 8 }}
                    barCategoryGap="30%"
                  >
                    <CartesianGrid {...GRID_PROPS} horizontal={false} />
                    <XAxis
                      type="number"
                      {...AXIS_PROPS}
                      tickFormatter={(v: number) => fmtLeaderboard(v)}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      {...AXIS_PROPS}
                      width={120}
                      tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--accent)", opacity: 0.35 }}
                      content={({ active, payload, label }) =>
                        active && payload?.length ? (
                          <ChartTooltipBody
                            label={String(label)}
                            rows={[
                              {
                                label: leaderboardLabel,
                                value: fmtLeaderboard((payload[0]?.value as number) ?? 0),
                                color: SERIES_COLORS[0],
                              },
                            ]}
                          />
                        ) : null
                      }
                    />
                    <Bar dataKey="value" fill={SERIES_COLORS[0]} radius={[0, 4, 4, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ClientOnly>
          </ChartPanel>

          {/* Busiest hours — when do customers write (staffing lens). */}
          {report !== null && <TeamHeatmap heatmap={report.heatmap} />}

          {/* Per-assignment-team rollup. Hidden when the workspace has no
              teams — a one-row table restating the totals is noise. */}
          {report !== null && report.teams.length > 0 && (
            <Panel title="By team">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 font-semibold">Team</th>
                      <th className="py-2 text-right font-semibold">Members</th>
                      <th className="py-2 text-right font-semibold">Assigned</th>
                      <th className="py-2 text-right font-semibold">Closed</th>
                      <th className="py-2 text-right font-semibold">Messages sent</th>
                      <th className="py-2 text-right font-semibold">Calls answered</th>
                      <th className="py-2 text-right font-semibold">Talk time</th>
                      <th className="py-2 text-right font-semibold">Tickets resolved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.teams.map((t) => (
                      <tr key={t.teamId ?? "none"}>
                        <td className="py-2 font-medium">
                          {t.teamId ? (
                            t.name
                          ) : (
                            <span className="text-muted-foreground">{t.name}</span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">{t.memberCount}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(t.assigned)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(t.closed)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(t.messagesSent)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(t.callsAnswered)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtDuration(t.talkTimeTotalSec)}</td>
                        <td className="py-2 text-right tabular-nums">{compactNumber(t.ticketsResolved)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {/* THE table. */}
          <Panel
            title="Agents"
            action={
              report !== null && report.agents.length > 0 ? (
                <button
                  type="button"
                  onClick={() => exportAgentsCsv(report)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Download className="size-3.5" aria-hidden />
                  Export CSV
                </button>
              ) : undefined
            }
          >
            <TeamTable
              agents={report?.agents ?? []}
              avatarById={avatarById}
              loading={report === null}
              onSelect={setSelected}
            />
          </Panel>
        </>
      )}

      <AgentDetailSheet
        agent={selected}
        avatarUrl={selected ? (avatarById.get(selected.userId) ?? null) : null}
        range={range}
        accountId={accountId}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
