"use client";

import { useMemo } from "react";

import { Panel, PanelEmpty } from "@/features/reports/report-primitives";
import { compactNumber } from "@/features/charts/chart-primitives";
import type { TeamReport } from "@ccp/shared/dtos";

/**
 * Busiest-hours heatmap: inbound demand by weekday × hour in the viewer's
 * timezone — the staffing question ("when do customers write?") as one glance.
 *
 * Sequential single-hue encoding (magnitude job): cell intensity is the
 * series color mixed toward the surface, scaled by count / max. Exact values
 * are never color-alone — every cell carries an aria-label and a native
 * tooltip, and the scale's ends are labeled under the grid.
 */

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Monday-first display order (business convention); dow values are Postgres
// EXTRACT(dow) with 0 = Sunday.
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function TeamHeatmap({ heatmap }: { heatmap: TeamReport["heatmap"] }) {
  const { byCell, max } = useMemo(() => {
    const byCell = new Map<string, number>();
    let max = 0;
    for (const c of heatmap) {
      byCell.set(`${c.dow}:${c.hour}`, c.inbound);
      if (c.inbound > max) max = c.inbound;
    }
    return { byCell, max };
  }, [heatmap]);

  return (
    <Panel title="Busiest hours">
      <p className="mb-3 text-xs text-muted-foreground">
        Incoming messages by weekday and hour, in your timezone — where the
        color is deepest is when customers write most.
      </p>
      {max === 0 ? (
        <PanelEmpty message="No incoming messages in this range yet." />
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[40rem]">
            {/* A real table, not a div grid: the cells carry exact numbers, so
                a screen reader needs row/column headers to say WHICH hour a
                value belongs to — and `aria-label` is prohibited on a bare
                div anyway (axe: aria-prohibited-attr). `<td>` accepts it. */}
            <table className="w-full table-fixed border-separate border-spacing-px">
              <caption className="sr-only">
                Incoming messages by weekday and hour of day, in your timezone.
              </caption>
              <thead>
                <tr>
                  <th className="w-10" scope="col">
                    <span className="sr-only">Weekday</span>
                  </th>
                  {HOURS.map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="pb-1 text-center text-3xs font-normal text-muted-foreground"
                    >
                      {/* Every 3rd hour is labelled — 24 labels collide at
                          panel width; the rest stay available to a reader. */}
                      <span aria-hidden>{h % 3 === 0 ? h : ""}</span>
                      <span className="sr-only">{String(h).padStart(2, "0")}:00</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DOW_ORDER.map((dow) => (
                  <tr key={dow}>
                    <th
                      scope="row"
                      className="pr-2 text-left text-2xs font-normal text-muted-foreground"
                    >
                      {DOW_LABELS[dow]}
                    </th>
                    {HOURS.map((h) => {
                      const count = byCell.get(`${dow}:${h}`) ?? 0;
                      const pct = count === 0 ? 0 : Math.max(12, Math.round((count / max) * 100));
                      const label = `${DOW_LABELS[dow]} ${String(h).padStart(2, "0")}:00 — ${count.toLocaleString()} incoming`;
                      return (
                        <td
                          key={h}
                          className="h-4 rounded-[3px] p-0"
                          style={{
                            background:
                              count === 0
                                ? "var(--muted)"
                                : `color-mix(in oklab, var(--chart-1) ${pct}%, var(--muted))`,
                          }}
                          title={label}
                          aria-label={label}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex items-center justify-end gap-1.5 text-2xs text-muted-foreground">
              <span>0</span>
              {[20, 45, 70, 100].map((p) => (
                <span
                  key={p}
                  aria-hidden
                  className="size-2.5 rounded-[3px]"
                  style={{
                    background: `color-mix(in oklab, var(--chart-1) ${p}%, var(--muted))`,
                  }}
                />
              ))}
              <span>{compactNumber(max)}</span>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
