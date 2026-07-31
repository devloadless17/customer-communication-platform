"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Sheet } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  AXIS_PROPS,
  ChartEmpty,
  ChartLegend,
  ChartTooltipBody,
  ClientOnly,
  GRID_PROPS,
  SERIES_COLORS,
  compactNumber,
} from "@/features/charts/chart-primitives";
import { MiniStat, fillDays, fmtDuration } from "@/features/reports/report-primitives";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { initials } from "@ccp/shared/utils";
import type { TeamReportAgent, TeamReportAgentDetail } from "@ccp/shared/dtos";

/**
 * The table row's drill-down: one agent's numbers plus their own per-day
 * series, in a slide-over so the manager can peek and move to the next row
 * without losing the table. The daily series is fetched lazily on first open
 * and cached per (agent, range, scope) — re-opening is instant, changing the
 * range naturally invalidates.
 */

const AGENT_SERIES = [
  { key: "messagesSent", label: "Messages sent", color: SERIES_COLORS[0] },
  { key: "conversationsClosed", label: "Closed", color: SERIES_COLORS[1] },
] as const;

const CHART_HEIGHT = 180;

export function AgentDetailSheet({
  agent,
  avatarUrl,
  range,
  accountId,
  onClose,
}: {
  /** Null = closed. */
  agent: TeamReportAgent | null;
  avatarUrl: string | null;
  range: { from: Date; to: Date };
  accountId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TeamReportAgentDetail | null>(null);
  const [error, setError] = useState(false);
  // Per-mount cache: (userId, range, scope) → detail. The range key uses the
  // instants so a range flip is a different key, matching the table's data.
  const cacheRef = useRef(new Map<string, TeamReportAgentDetail>());

  const cacheKey = agent
    ? `${agent.userId}|${range.from.toISOString()}|${range.to.toISOString()}|${accountId ?? ""}`
    : null;

  useEffect(() => {
    if (!agent || !cacheKey) return;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setDetail(cached);
      setError(false);
      return;
    }
    let cancelled = false;
    setDetail(null);
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
        const res = await fetchWithSessionGuard(
          `/api/reports/team/agents/${encodeURIComponent(agent.userId)}?${qs}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = (await res.json()) as TeamReportAgentDetail;
        cacheRef.current.set(cacheKey, body);
        if (!cancelled) setDetail(body);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent, cacheKey, range, accountId]);

  const daily = useMemo(
    () =>
      detail
        ? fillDays(detail.daily, range.from, range.to, ["messagesSent", "conversationsClosed"])
        : [],
    [detail, range],
  );

  // The sheet renders from the table row immediately (`agent`); only the daily
  // chart waits on the drill-down fetch. No blank panel while the network runs.
  const a = agent;

  return (
    <Sheet
      open={a !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      side="right"
      contentClassName="w-full max-w-md overflow-y-auto"
      labelledBy="agent-detail-title"
    >
      {a && (
        <div className="flex flex-col gap-5 p-5">
          <div className="flex items-center gap-3 pr-8">
            <Avatar className="size-10 shrink-0">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={a.name ?? ""} /> : null}
              <AvatarFallback seed={a.userId} className="text-xs">
                {initials(a.name || a.email || "?")}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h2 id="agent-detail-title" className="truncate text-base font-semibold">
                {a.name ?? "Former member"}
                {a.deactivated && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 align-middle text-3xs font-normal text-muted-foreground">
                    deactivated
                  </span>
                )}
              </h2>
              {a.role && (
                <p className="truncate text-xs text-muted-foreground">
                  {roleLabel(a.role)}
                  {a.email ? ` · ${a.email}` : ""}
                </p>
              )}
              {a.onlineMinutes != null && (
                <p className="text-xs text-muted-foreground">
                  Online {fmtDuration(a.onlineMinutes * 60)} in this range
                </p>
              )}
            </div>
          </div>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Conversations
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <MiniStat label="Assigned" value={compactNumber(a.conversations.assigned)} />
              <MiniStat label="Closed" value={compactNumber(a.conversations.closed)} />
              <MiniStat label="Open now" value={compactNumber(a.conversations.openNow)} />
              <MiniStat label="First replies" value={compactNumber(a.conversations.firstReplies)} />
              <MiniStat
                label="Median FRT"
                value={fmtDuration(a.conversations.medianFirstResponseSec)}
                hint={
                  a.conversations.avgFirstResponseSec != null
                    ? `avg ${fmtDuration(a.conversations.avgFirstResponseSec)}`
                    : undefined
                }
              />
              <MiniStat
                label="Median resolution"
                value={fmtDuration(a.conversations.medianResolutionSec)}
                hint={
                  a.conversations.avgResolutionSec != null
                    ? `avg ${fmtDuration(a.conversations.avgResolutionSec)}`
                    : undefined
                }
              />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Messages
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <MiniStat label="Sent" value={compactNumber(a.messages.sent)} />
              <MiniStat label="Notes" value={compactNumber(a.messages.notesAuthored)} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Calls
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <MiniStat label="Placed" value={compactNumber(a.calls.placed)} />
              <MiniStat label="Answered" value={compactNumber(a.calls.answered)} />
              <MiniStat
                label="Talk time"
                value={fmtDuration(a.calls.talkTimeTotalSec)}
                hint={
                  a.calls.talkTimeAvgSec != null
                    ? `avg ${fmtDuration(a.calls.talkTimeAvgSec)}`
                    : undefined
                }
              />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tickets
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <MiniStat label="Created" value={compactNumber(a.tickets.created)} />
              <MiniStat label="Resolved" value={compactNumber(a.tickets.resolved)} />
              <MiniStat
                label="SLA breached"
                value={compactNumber(
                  a.tickets.firstResponseBreached + a.tickets.resolutionBreached,
                )}
                hint={
                  a.tickets.firstResponseBreached + a.tickets.resolutionBreached > 0
                    ? `${a.tickets.firstResponseBreached} first response · ${a.tickets.resolutionBreached} resolution`
                    : undefined
                }
              />
              <MiniStat label="Open assigned" value={compactNumber(a.tickets.openAssignedNow)} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Per day
            </h3>
            {error ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                Couldn&apos;t load the daily series. Close and reopen to retry.
              </p>
            ) : (
              <>
                <ClientOnly height={CHART_HEIGHT}>
                  {detail === null ? (
                    <div className="h-full animate-pulse rounded-lg bg-muted/30" />
                  ) : detail.daily.length === 0 ? (
                    <ChartEmpty message="No activity in this range." />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={daily}
                        margin={{ top: 4, right: 8, bottom: 0, left: -16 }}
                        barCategoryGap="25%"
                        barGap={2}
                      >
                        <CartesianGrid {...GRID_PROPS} />
                        <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={28} />
                        <YAxis
                          {...AXIS_PROPS}
                          tickFormatter={compactNumber}
                          width={40}
                          allowDecimals={false}
                        />
                        <Tooltip
                          cursor={{ fill: "var(--accent)", opacity: 0.35 }}
                          content={({ active, payload, label }) =>
                            active && payload?.length ? (
                              <ChartTooltipBody
                                label={String(label)}
                                rows={AGENT_SERIES.map((s) => ({
                                  label: s.label,
                                  value: String(
                                    (payload.find((p) => p.dataKey === s.key)?.value as number) ??
                                      0,
                                  ),
                                  color: s.color,
                                }))}
                              />
                            ) : null
                          }
                        />
                        {AGENT_SERIES.map((s) => (
                          <Bar
                            key={s.key}
                            dataKey={s.key}
                            fill={s.color}
                            radius={[3, 3, 0, 0]}
                            maxBarSize={16}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </ClientOnly>
                <ChartLegend
                  series={AGENT_SERIES.map((s) => ({ label: s.label, color: s.color }))}
                />
              </>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
