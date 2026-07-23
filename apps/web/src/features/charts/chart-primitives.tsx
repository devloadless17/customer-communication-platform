"use client";

import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@ccp/shared/utils";

/**
 * Shared chart chrome.
 *
 * THEMING GOES THROUGH CSS VARIABLES, not JS. Recharts wants concrete colour
 * strings for strokes and fills, and the obvious approach — read the theme in
 * React and pass hex down — means every theme toggle repaints through a state
 * update, and server/client can disagree on first paint. Reading
 * `var(--chart-N)` instead lets the browser reflow the colours on a class
 * change with no JS at all.
 *
 * The one place that CANNOT take a var is the tooltip, which we render as our
 * own HTML rather than Recharts' default — so it inherits the app's tokens
 * directly and needs no colour plumbing at all.
 */

/** Series colour by index. Fixed order, never cycled — see the token comment. */
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
] as const;

/**
 * Recessive grid + axis styling, applied identically to every chart so a
 * dashboard reads as one system rather than four charts that happen to be
 * adjacent. Deliberately low-contrast: the data is the subject.
 */
export const AXIS_PROPS = {
  stroke: "var(--border)",
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

export const GRID_PROPS = {
  stroke: "var(--border)",
  strokeDasharray: "3 3",
  vertical: false,
} as const;

/**
 * A titled chart panel with a fixed-height plot area.
 *
 * The height is reserved BEFORE the chart mounts. Recharts measures its
 * container, so a zero-height parent renders nothing and then jumps to full
 * size — the layout shift the §15 "no layout shift, no flicker" rule exists to
 * prevent. Everything lazy below relies on this.
 */
export function ChartPanel({
  title,
  subtitle,
  action,
  height = 240,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  height?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-5", className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      <div className="mt-4" style={{ height }}>
        {children}
      </div>
    </section>
  );
}

/**
 * Legend row. Present whenever there are ≥2 series, so identity is never
 * carried by colour alone — the swatch is a redundant cue beside a text label,
 * not the label itself.
 */
export function ChartLegend({
  series,
}: {
  series: Array<{ label: string; color: string }>;
}) {
  if (series.length < 2) return null;
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {series.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Tooltip body.
 *
 * Our own HTML rather than Recharts' default, for three reasons: it inherits
 * the app's surface + border tokens so it matches every other popover, the
 * VALUES stay in text ink (a coloured swatch carries identity — never coloured
 * numbers), and it costs no colour plumbing.
 */
export function ChartTooltipBody({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ label: string; value: string; color: string }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-lg">
      <p className="text-2xs font-medium">{label}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-2xs">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: r.color }}
            />
            <span className="text-muted-foreground">{r.label}</span>
            <span className="ml-auto tabular-nums font-medium">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Gate that renders children only after mount.
 *
 * Recharts measures the DOM, so it cannot render on the server. Rather than a
 * `useEffect`-set "hydrated" boolean scattered through every chart — the
 * pattern §14 rules out — this is the ONE place that concern lives, and it
 * always reserves the same height its child will occupy.
 */
export function ClientOnly({
  height,
  children,
}: {
  height: number;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div style={{ height }} className="rounded-lg bg-muted/30" aria-hidden />;
  }
  return <>{children}</>;
}

/** Compact number for axes: 12400 → "12.4k". Axis labels must not wrap. */
export function compactNumber(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

/** An empty plot area that says WHY it is empty, never a blank box. */
export function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border">
      <p className="max-w-xs px-4 text-center text-xs text-muted-foreground">{message}</p>
    </div>
  );
}
