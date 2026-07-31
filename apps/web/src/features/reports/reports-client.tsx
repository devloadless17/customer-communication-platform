"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Megaphone } from "lucide-react";
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
import { AcquisitionPanel } from "@/features/reports/acquisition-panel";
import { WhatsappSpendPanel } from "@/features/reports/whatsapp-spend-panel";
import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";
import {
  fillDays,
  fmtDuration,
  MiniStat,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  StatTile,
} from "@/features/reports/report-primitives";
import {
  computeReportRange,
  ReportControls,
  useScopeAccounts,
} from "@/features/reports/report-controls";
import { ReportsNav } from "@/features/reports/reports-nav";
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

const VOLUME_SERIES = [
  { key: "inbound", label: "Received", color: SERIES_COLORS[0] },
  { key: "outbound", label: "Sent", color: SERIES_COLORS[1] },
] as const;

const CHART_HEIGHT = 260;

/** The overview shows the top carriers; the full table lives on /reports/team. */
const AGENT_PREVIEW_ROWS = 5;

/** "98%" attainment, or null when the range has no SLA-tracked tickets. */
function slaMet(bucket: { withSla: number; breached: number }): string | null {
  if (bucket.withSla === 0) return null;
  const met = bucket.withSla - bucket.breached;
  return `${Math.round((met / bucket.withSla) * 100)}%`;
}

export function ReportsClient() {
  const [days, setDays] = useState<number>(30);
  // Scope every panel to ONE of the workspace's numbers/Pages. A workspace
  // running a Sales and a Support line is two operations sharing a medium, and
  // a blended first-response time hides one drowning behind the other.
  // Null = the whole workspace, which stays the default.
  const [accountId, setAccountId] = useState<string | null>(null);
  const { all: allAccounts } = useChannelAccounts();
  const scopeAccounts = useScopeAccounts();
  // Gate the Meta spend panel on actually HAVING WhatsApp. Letting the panel
  // decide for itself meant rendering its header and skeleton, then removing the
  // whole section once Meta answered with no accounts — a visible collapse on a
  // page a Messenger-only workspace has no WhatsApp spend to show on at all.
  const hasWhatsapp = useMemo(
    () => allAccounts.some((a) => a.isActive && a.channel === "whatsapp"),
    [allAccounts],
  );
  const [report, setReport] = useState<WorkspaceReport | null>(null);
  const [error, setError] = useState(false);
  // The range is computed once per selection (not per render) so the request
  // URL is stable and an eslint-exhaustive-deps refetch loop can't start.
  const range = useMemo(() => computeReportRange(days), [days]);

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
    () =>
      report
        ? fillDays(report.volume.daily, range.from, range.to, ["inbound", "outbound"])
        : [],
    [report, range],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 md:px-8">
      <ReportsNav />
      <PageHeader
        title="Reports"
        description="How the workspace is performing — volumes, response times, agents, SLA, and the AI's share."
        action={
          <ReportControls
            days={days}
            onDaysChange={setDays}
            accountId={accountId}
            onAccountChange={setAccountId}
          />
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

          {/* Per-agent preview — the top carriers only. The full sortable
              table (calls, tickets, notes, drill-down) lives on /reports/team;
              duplicating it here would drift as that table grows columns. */}
          <Panel
            title="Agents"
            action={
              <Link
                href="/reports/team"
                className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                View full team report
                <ChevronRight className="size-3.5" />
              </Link>
            }
          >
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
                    {report.agents.slice(0, AGENT_PREVIEW_ROWS).map((a) => (
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
                {report.agents.length > AGENT_PREVIEW_ROWS && (
                  <p className="pt-2 text-2xs text-muted-foreground">
                    Top {AGENT_PREVIEW_ROWS} of {report.agents.length} agents by messages sent.
                  </p>
                )}
              </div>
            )}
          </Panel>
        </>
      )}

      {/* Meta's billing side, on its own request.
          Outside the `report &&` gate deliberately: it reads Meta rather than our
          database, so it is much slower, and holding it behind the main report
          would make the whole page feel as slow as the slowest Graph call. It
          also renders nothing at all when the workspace has no WhatsApp account.
          Not account-scoped by the picker above — these figures are per WhatsApp
          BUSINESS ACCOUNT (the WABA), which is a coarser thing than the per-number
          scope that filters our own message rows. */}
      {hasWhatsapp && <WhatsappSpendPanel days={days} />}

      {/* WHERE customers came from. Not channel-filtered: the whole point is that
          it reads the same across WhatsApp, Messenger and Instagram — a Meta ad
          id means the same thing on all three now, so splitting it per channel
          would hide the campaign that ran on two of them. */}
      <AcquisitionPanel />

      {/* The campaign rollup is a PAGE, not a panel: it is per-campaign and this
          dashboard is per-workspace, so embedding it would need a picker whose
          only job is to pick the thing the next page already asks for. Rendered
          unconditionally — a workspace with no campaigns still needs to find out
          that naming a broadcast is what creates one, and the page says so. */}
      <Link
        href="/reports/campaigns"
        className="flex items-center gap-3 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/40"
      >
        <Megaphone className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Campaigns</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Several broadcasts under one name, read together — by send, by
            account, by failure and by what Meta charged for.
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </div>
  );
}

