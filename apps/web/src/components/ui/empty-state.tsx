import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@ccp/shared/utils";

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Lucide icon rendered in the soft chip at the top of the column. */
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional CTA rendered below the copy — usually a <Button> (or asChild link). */
  action?: React.ReactNode;
}

/**
 * Centered empty-state column matching the rich first-run pattern used by
 * broadcasts / workflows: a soft primary icon chip, a muted title/description,
 * and an optional CTA. Wrap it in (or pass via className) whatever surface the
 * caller wants — dashed border card, plain region, etc. Defaults to a dashed
 * card so a bare <EmptyState /> already looks finished.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" />
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        {description && (
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
