"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { Button } from "@/components/ui/button";

/**
 * Numbered page control (Prev · 1 2 … N · Next) with an optional
 * "Showing X–Y of N" range label. Backed by offset pagination — the caller
 * owns `page` (1-based) and refetches on `onPageChange`. Renders nothing when
 * there's a single page and no total to summarize.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  totalCount,
  pageSize,
  itemNoun = "items",
  /** Marks the control busy (a refetch is in flight) via `aria-busy`. We do NOT
   *  disable the buttons on this — disabling the just-clicked button drops
   *  keyboard focus to <body> mid-paging; the caller's request-seq guard drops
   *  stale responses instead. */
  disabled = false,
  className,
}: {
  /** Current 1-based page. */
  page: number;
  /** Total number of pages (>= 1). */
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Total matching rows — drives the "of N" summary. */
  totalCount?: number;
  /** Rows per page — needed with `totalCount` for the "X–Y" range. */
  pageSize?: number;
  /** Plural noun for the summary ("contacts", "calls"). */
  itemNoun?: string;
  disabled?: boolean;
  className?: string;
}) {
  // One page and nothing to summarize → no control at all.
  if (pageCount <= 1 && totalCount == null) return null;

  const pages = pageRange(page, pageCount);
  const rangeLabel =
    totalCount != null && pageSize != null && totalCount > 0
      ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalCount)} of ${totalCount}`
      : null;

  return (
    <nav
      aria-label="Pagination"
      aria-busy={disabled}
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <p className="text-xs text-muted-foreground">
        {rangeLabel && (
          <>
            Showing <span className="font-medium text-foreground">{rangeLabel}</span>{" "}
            {itemNoun}
          </>
        )}
      </p>

      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>

          {pages.map((p, i) =>
            p === "…" ? (
              <span
                key={`gap-${i}`}
                className="select-none px-1 text-sm text-muted-foreground"
                aria-hidden
              >
                {"…"}
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "ghost"}
                size="icon-sm"
                className="text-xs tabular-nums"
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p}`}
                onClick={() => onPageChange(p as number)}
              >
                {p}
              </Button>
            ),
          )}

          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </nav>
  );
}

/**
 * Windowed page list with ellipses: always the first + last page, the current
 * page and its immediate neighbors, and "…" for the gaps. ≤7 pages renders
 * every number (no ellipsis needed).
 */
function pageRange(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const out: (number | "…")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) out.push("…");
  for (let p = start; p <= end; p++) out.push(p);
  if (end < total - 1) out.push("…");
  out.push(total);

  return out;
}
