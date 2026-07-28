"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
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

/**
 * How one template performs over time — Meta's own daily figures.
 *
 * Lives in the template drawer rather than on its own route because that is
 * where someone already is when the question occurs to them ("is this template
 * actually working?"). A separate page would mean navigating away from the
 * thing being asked about.
 *
 * Grouped bars, not lines: the reader's job here is comparing magnitudes within
 * a day (how much of what we sent was delivered, and how much of that was
 * read), and bars make that comparison directly. Lines would imply a continuous
 * quantity and invite reading the gaps as trends.
 */

interface Day {
  date: string;
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  costAmountSpent: number | null;
  currency: string | null;
}

interface Summary {
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  /** Per-button click totals over the window; null when Meta reported none. */
  clickedButtons: Array<{
    type: string;
    buttonContent: string | null;
    count: number;
  }> | null;
  costAmountSpent: number | null;
  costPerDelivered: number | null;
  currency: string | null;
  days: number;
}

/** Same labels the campaign report uses — the two surfaces must agree. */
const CLICK_TYPE_LABELS: Record<string, string> = {
  url_button: "clicks",
  unique_url_button: "unique clicks",
  quick_reply_button: "taps",
};

const SERIES = [
  { key: "sent", label: "Sent", color: SERIES_COLORS[0] },
  { key: "delivered", label: "Delivered", color: SERIES_COLORS[1] },
  { key: "read", label: "Read", color: SERIES_COLORS[2] },
] as const;

const RANGES = [7, 30, 90] as const;
const HEIGHT = 200;

export function TemplateInsights({ templateId }: { templateId: string }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [notSynced, setNotSynced] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(
    async (windowDays: number) => {
      try {
        const res = await apiFetch(
          `/api/workspace/whatsapp/templates/${templateId}/analytics?days=${windowDays}`,
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          // A template Meta hasn't approved yet genuinely has no id to query.
          // Saying so beats an empty chart that reads as "nobody engaged".
          if (body.error === "template_not_synced") setNotSynced(true);
          return;
        }
        const body = (await res.json()) as { days: Day[]; summary: Summary };
        setDays(body.days);
        setSummary(body.summary);
      } catch {
        // Keep whatever is on screen; the next action reconciles.
      }
    },
    [templateId],
  );

  useEffect(() => {
    void load(range);
  }, [load, range]);

  function refresh() {
    startTransition(async () => {
      const res = await apiFetch(
        `/api/workspace/whatsapp/templates/${templateId}/analytics/refresh?days=${range}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        toast.error(
          body.error === "template_insights_not_enabled"
            ? "Turn on template analytics in Settings → WhatsApp first."
            : body.error === "template_not_synced"
              ? "This template isn't approved by Meta yet."
              : body.error === "whatsapp_not_configured"
                ? `This account's WhatsApp connection is missing something — check Settings → WhatsApp. (${body.detail ?? "no detail"})`
                : // Meta's own sentence when we have it — same rule as the
                  // campaign report panel: a reason the operator can act on.
                  body.detail
                  ? `Meta refused the fetch: ${body.detail}`
                  : `Couldn't fetch from Meta (HTTP ${res.status}).`,
        );
        return;
      }
      const body = (await res.json()) as { rows: number };
      if (body.rows === 0) toast.warning("Meta has no data for this window yet.");
      else toast.success(`Updated ${body.rows} day${body.rows === 1 ? "" : "s"}`);
      await load(range);
    });
  }

  const data = useMemo(
    () =>
      (days ?? []).map((d) => ({
        ...d,
        // Nulls must not plot as zero — an unreported day is a GAP in the bar
        // series, which is visually honest, where a zero bar would assert
        // "nobody read it".
        read: d.read ?? undefined,
        label: new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
      })),
    [days],
  );

  if (notSynced) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Meta hasn&apos;t approved this template yet, so it has no analytics.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={
                range === r
                  ? "cursor-pointer rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-2xs font-medium"
                  : "cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              }
            >
              {r}d
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={pending}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Fetch
        </Button>
      </div>

      {summary && summary.days > 0 && (
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <Stat label="Sent" value={summary.sent.toLocaleString()} />
          <Stat label="Delivered" value={summary.delivered.toLocaleString()} />
          <Stat
            label="Read"
            value={summary.read?.toLocaleString() ?? null}
            nullReason="Meta reports reads for 7 days only"
          />
        </dl>
      )}

      {summary && summary.clickedButtons && summary.clickedButtons.length > 0 && (
        <ul className="mt-3 space-y-1">
          {summary.clickedButtons.map((b, i) => (
            <li
              key={`${b.type}-${b.buttonContent ?? i}`}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
            >
              <span className="min-w-0 truncate">{b.buttonContent ?? "Button"}</span>
              <span className="shrink-0 tabular-nums font-medium">
                {b.count.toLocaleString()}{" "}
                <span className="font-normal text-muted-foreground">
                  {CLICK_TYPE_LABELS[b.type] ?? b.type.replaceAll("_", " ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3" style={{ height: HEIGHT }}>
        <ClientOnly height={HEIGHT}>
          {days === null ? (
            <div className="h-full animate-pulse rounded-lg bg-muted/30" />
          ) : data.length === 0 ? (
            <ChartEmpty message="Nothing stored for this window. Press Fetch to pull it from Meta." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} // left:-16 clipped the y-axis labels ("500" rendered as "00").
                // Matches the delivery curve, which sits at -8/44 and renders whole.
                margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={24} />
                <YAxis {...AXIS_PROPS} tickFormatter={compactNumber} width={44} />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <ChartTooltipBody
                        label={String(label)}
                        rows={SERIES.map((s) => {
                          const row = payload[0]?.payload as Record<string, number | undefined>;
                          const v = row?.[s.key];
                          return {
                            label: s.label,
                            // Honest in the tooltip too — "Not reported", not 0.
                            value: v === undefined ? "Not reported" : v.toLocaleString(),
                            color: s.color,
                          };
                        })}
                      />
                    ) : null
                  }
                />
                {SERIES.map((s) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    fill={s.color}
                    // 4px rounded data-end, anchored to the baseline.
                    radius={[4, 4, 0, 0]}
                    maxBarSize={18}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </ClientOnly>
      </div>
      <ChartLegend series={SERIES.map((s) => ({ label: s.label, color: s.color }))} />
    </div>
  );
}

function Stat({
  label,
  value,
  nullReason,
}: {
  label: string;
  value: string | null;
  nullReason?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/20 px-3 py-2">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">
        {value ?? (
          <span className="text-xs font-normal text-muted-foreground">Not reported</span>
        )}
      </dd>
      {value === null && nullReason && (
        <p className="mt-0.5 text-4xs leading-tight text-muted-foreground/80">{nullReason}</p>
      )}
    </div>
  );
}
