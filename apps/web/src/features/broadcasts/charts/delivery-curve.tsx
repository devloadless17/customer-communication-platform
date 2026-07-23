"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
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

/**
 * How a campaign actually went, minute by minute.
 *
 * The funnel says WHERE recipients ended up. This says WHEN — and that is the
 * difference between "82% delivered" and "82% delivered, but the last third
 * took four hours because the carrier throttled us". Four cumulative lines
 * because they share one unit (recipients), which is what makes a single y-axis
 * honest here; a second axis would be the classic dual-scale lie.
 */

interface Point {
  t: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

const SERIES = [
  { key: "sent", label: "Sent", color: SERIES_COLORS[0] },
  { key: "delivered", label: "Delivered", color: SERIES_COLORS[1] },
  { key: "read", label: "Read", color: SERIES_COLORS[2] },
  { key: "replied", label: "Replied", color: SERIES_COLORS[3] },
] as const;

const HEIGHT = 240;

export function DeliveryCurve({
  broadcastId,
  /** Re-fetch when the parent's report refreshes, so the two stay in step. */
  refreshKey,
}: {
  broadcastId: string;
  refreshKey?: number;
}) {
  const [points, setPoints] = useState<Point[] | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithSessionGuard(
          `/api/broadcasts/${broadcastId}/timeseries`,
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { points: Point[]; live: boolean };
        if (cancelled) return;
        setPoints(body.points);
        setLive(body.live);
      } catch {
        // Leave the last good curve up; the next refresh reconciles.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [broadcastId, refreshKey]);

  // Time labels are formatted ONCE here rather than in a tick callback that
  // Recharts calls on every render for every tick.
  const data = useMemo(
    () =>
      (points ?? []).map((p) => ({
        ...p,
        label: new Date(p.t).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      })),
    [points],
  );

  return (
    <ChartPanel
      title="Delivery over time"
      subtitle={
        live
          ? "Still sending — the final point is a partial bucket."
          : "Cumulative recipients reached at each point in the send."
      }
      height={HEIGHT}
    >
      <ClientOnly height={HEIGHT}>
        {points === null ? (
          <div className="h-full animate-pulse rounded-lg bg-muted/30" />
        ) : data.length === 0 ? (
          <ChartEmpty message="No sends recorded yet. The curve appears once the first message goes out." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={32} />
              <YAxis {...AXIS_PROPS} tickFormatter={compactNumber} width={44} />
              <Tooltip
                cursor={{ stroke: "var(--border)" }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <ChartTooltipBody
                      label={String(label)}
                      rows={SERIES.map((s) => ({
                        label: s.label,
                        value: (
                          (payload[0]?.payload as Record<string, number>)?.[s.key] ?? 0
                        ).toLocaleString(),
                        color: s.color,
                      }))}
                    />
                  ) : null
                }
              />
              {SERIES.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  // No dot per point: a 120-bucket series would draw 480
                  // markers and read as noise. The hover crosshair gives the
                  // per-point values instead.
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </ClientOnly>
      <ChartLegend series={SERIES.map((s) => ({ label: s.label, color: s.color }))} />
    </ChartPanel>
  );
}
