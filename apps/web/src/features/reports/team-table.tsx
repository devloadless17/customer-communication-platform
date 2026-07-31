"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PanelEmpty, PanelSkeleton, fmtDuration } from "@/features/reports/report-primitives";
import { compactNumber } from "@/features/charts/chart-primitives";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { cn, initials } from "@ccp/shared/utils";
import type { TeamReportAgent } from "@ccp/shared/dtos";

/**
 * The central per-agent table: grouped column headers (Conversations |
 * Messages | Calls | Tickets), client-side sorting, sticky identity column,
 * totals footer. Row click opens the drill-down sheet.
 *
 * Sorting is client-side by contract — the DTO's `agents` array is unsorted.
 * Medians sort null-last in either direction ("no data" is never "fastest").
 */

type ColumnDef = {
  key: string;
  label: string;
  /** Value used for sorting AND (via fmt) rendering. */
  get: (a: TeamReportAgent) => number | null;
  fmt: "int" | "duration";
  /** Summable into the totals footer? Medians and averages are not. */
  sum: boolean;
  /** Render a left group-divider border on this column. */
  groupStart?: boolean;
};

const GROUPS: Array<{ label: string; cols: ColumnDef[] }> = [
  {
    label: "Conversations",
    cols: [
      { key: "assigned", label: "Assigned", get: (a) => a.conversations.assigned, fmt: "int", sum: true, groupStart: true },
      { key: "closed", label: "Closed", get: (a) => a.conversations.closed, fmt: "int", sum: true },
      { key: "openNow", label: "Open now", get: (a) => a.conversations.openNow, fmt: "int", sum: true },
      { key: "firstReplies", label: "First replies", get: (a) => a.conversations.firstReplies, fmt: "int", sum: true },
      { key: "medianFrt", label: "Median FRT", get: (a) => a.conversations.medianFirstResponseSec, fmt: "duration", sum: false },
    ],
  },
  {
    label: "Messages",
    cols: [
      { key: "sent", label: "Sent", get: (a) => a.messages.sent, fmt: "int", sum: true, groupStart: true },
      { key: "notes", label: "Notes", get: (a) => a.messages.notesAuthored, fmt: "int", sum: true },
    ],
  },
  {
    label: "Calls",
    cols: [
      { key: "callsPlaced", label: "Placed", get: (a) => a.calls.placed, fmt: "int", sum: true, groupStart: true },
      { key: "callsAnswered", label: "Answered", get: (a) => a.calls.answered, fmt: "int", sum: true },
      { key: "talkTime", label: "Talk time", get: (a) => a.calls.talkTimeTotalSec, fmt: "duration", sum: true },
    ],
  },
  {
    label: "Tickets",
    cols: [
      { key: "ticketsCreated", label: "Created", get: (a) => a.tickets.created, fmt: "int", sum: true, groupStart: true },
      { key: "ticketsResolved", label: "Resolved", get: (a) => a.tickets.resolved, fmt: "int", sum: true },
      {
        key: "breached",
        label: "Breached",
        get: (a) => a.tickets.firstResponseBreached + a.tickets.resolutionBreached,
        fmt: "int",
        sum: true,
      },
    ],
  },
  {
    label: "Time",
    cols: [
      {
        key: "online",
        label: "Online",
        // Ledger minutes → seconds for fmtDuration; null = not tracked (the
        // sampler predates no data), which must not render as "0s online".
        get: (a) => (a.onlineMinutes == null ? null : a.onlineMinutes * 60),
        fmt: "duration",
        sum: true,
        groupStart: true,
      },
    ],
  },
];

const ALL_COLS: ColumnDef[] = GROUPS.flatMap((g) => g.cols);

function fmtCell(col: ColumnDef, value: number | null): string {
  if (col.fmt === "duration") return fmtDuration(value);
  return value == null ? "—" : compactNumber(value);
}

export function TeamTable({
  agents,
  avatarById,
  loading,
  onSelect,
}: {
  agents: TeamReportAgent[];
  avatarById: Map<string, string | null>;
  loading: boolean;
  onSelect: (agent: TeamReportAgent) => void;
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "sent",
    dir: "desc",
  });

  const sorted = useMemo(() => {
    const col = ALL_COLS.find((c) => c.key === sort.key) ?? ALL_COLS[0]!;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...agents].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      // Null-last in either direction: "no data" is neither fastest nor most.
      if (av == null && bv == null) return (a.name ?? "").localeCompare(b.name ?? "");
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir || (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [agents, sort]);

  const totals = useMemo(
    () =>
      new Map(
        ALL_COLS.map((c) => {
          if (!c.sum) return [c.key, null] as const;
          const values = agents.map((a) => c.get(a));
          // All-null stays null ("not tracked", e.g. Online before the
          // sampler had data) — a fake 0 total misreads as "nobody was on".
          if (values.every((v) => v == null)) return [c.key, null] as const;
          return [c.key, values.reduce((n: number, v) => n + (v ?? 0), 0)] as const;
        }),
      ),
    [agents],
  );

  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  if (loading) return <PanelSkeleton rows={6} />;
  if (agents.length === 0)
    return <PanelEmpty message="No agent activity in this range yet." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[64rem] text-sm">
        <caption className="sr-only">
          Per-agent activity: conversations, messages, calls and tickets over the
          selected range. Click a column header to sort; click a row for the
          agent&apos;s details.
        </caption>
        <thead>
          <tr className="border-b border-border/60 text-2xs uppercase tracking-wider text-muted-foreground">
            <th className="sticky left-0 z-10 bg-card" aria-hidden />
            {GROUPS.map((g) => (
              <th
                key={g.label}
                colSpan={g.cols.length}
                scope="colgroup"
                className="border-l border-border/60 px-2 pb-1.5 pt-2 text-left font-semibold"
              >
                {g.label}
              </th>
            ))}
          </tr>
          <tr className="border-b border-border text-2xs uppercase tracking-wider text-muted-foreground">
            <th className="sticky left-0 z-10 bg-card py-2 pr-2 text-left font-semibold">
              Agent
            </th>
            {ALL_COLS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn(
                    "py-2 text-right font-semibold",
                    c.groupStart && "border-l border-border/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-0.5 px-2 uppercase tracking-wider transition-colors hover:text-foreground",
                      active && "text-foreground",
                    )}
                  >
                    {c.label}
                    {active &&
                      (sort.dir === "desc" ? (
                        <ChevronDown className="size-3" aria-hidden />
                      ) : (
                        <ChevronUp className="size-3" aria-hidden />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((a) => (
            <tr
              key={a.userId}
              onClick={() => onSelect(a)}
              className="cursor-pointer transition-colors hover:bg-muted/30"
            >
              <td className="sticky left-0 z-10 min-w-52 bg-card py-2 pr-2">
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-7 shrink-0">
                    {avatarById.get(a.userId) ? (
                      <AvatarImage src={avatarById.get(a.userId)!} alt={a.name ?? ""} />
                    ) : null}
                    <AvatarFallback seed={a.userId} className="text-3xs">
                      {initials(a.name || a.email || "?")}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(a);
                        }}
                        className="cursor-pointer truncate text-left font-medium hover:underline"
                      >
                        {a.name ?? <span className="text-muted-foreground">Former member</span>}
                      </button>
                      {a.deactivated && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                          deactivated
                        </span>
                      )}
                    </div>
                    {a.role && (
                      <div className="truncate text-2xs text-muted-foreground">
                        {roleLabel(a.role)}
                        {a.email ? ` · ${a.email}` : ""}
                      </div>
                    )}
                  </div>
                </div>
              </td>
              {ALL_COLS.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "px-2 py-2 text-right tabular-nums",
                    c.groupStart && "border-l border-border/60",
                  )}
                >
                  {fmtCell(c, c.get(a))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-muted/30 font-medium">
            <td className="sticky left-0 z-10 bg-muted/30 py-2 pr-2 text-muted-foreground backdrop-blur">
              Total
            </td>
            {ALL_COLS.map((c) => {
              const total = totals.get(c.key) ?? null;
              return (
                <td
                  key={c.key}
                  className={cn(
                    "px-2 py-2 text-right tabular-nums",
                    c.groupStart && "border-l border-border/60",
                  )}
                >
                  {total == null ? "—" : c.fmt === "duration" ? fmtDuration(total) : compactNumber(total)}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
