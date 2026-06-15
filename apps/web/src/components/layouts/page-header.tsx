import type { ReactNode } from "react";

import { cn } from "@ccp/shared/utils";

export interface PageHeaderProps {
  /** Rendered as the page <h1>. Keep it equal to the nav label for parity. */
  title: string;
  /** Optional muted line under the title. */
  description?: ReactNode;
  /** Optional right-aligned slot — usually a <Button> (e.g. "Add tag"). */
  action?: ReactNode;
  className?: string;
}

/**
 * One header for every settings/admin sub-page. Settles the three competing
 * h1 conventions (`text-2xl`, `text-xl tracking-tight`, `text-lg`) on the
 * denser `text-xl font-semibold tracking-tight` so sibling pages stop jumping
 * size as you navigate the sub-sidebar.
 *
 * Layout: flex row — title block on the left (`min-w-0` so a long title
 * truncates instead of shoving the action off-screen), action pinned right
 * (`shrink-0`). When there's no action it collapses to a plain title block.
 */
export function PageHeader({
  title,
  description,
  action,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn("flex items-start justify-between gap-3", className)}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
