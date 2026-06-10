import { CheckCircle2, Clock, ShieldX } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { TeamStatus } from "@ccp/shared/types";

/**
 * Org-approval status pill, shared by the platform Organizations list + detail.
 * Presentational only (no hooks) so it renders as a server component.
 */
const STYLES: Record<
  TeamStatus,
  { label: string; className: string; Icon: typeof Clock }
> = {
  pending: {
    label: "Pending",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    Icon: Clock,
  },
  active: {
    label: "Active",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  suspended: {
    label: "Suspended",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    Icon: ShieldX,
  },
};

export function TeamStatusBadge({
  status,
  className,
}: {
  status: TeamStatus;
  className?: string;
}) {
  const s = STYLES[status];
  const Icon = s.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.className,
        className,
      )}
    >
      <Icon className="size-3" />
      {s.label}
    </span>
  );
}
