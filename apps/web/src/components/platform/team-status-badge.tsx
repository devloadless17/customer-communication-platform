import { CheckCircle2, Clock, ShieldX } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { OrgStatus } from "@ccp/shared/types";

/**
 * Org-approval status pill, shared by the platform Organizations list + detail.
 * Presentational only (no hooks) so it renders as a server component.
 */
const STYLES: Record<
  OrgStatus,
  { label: string; className: string; Icon: typeof Clock }
> = {
  pending: {
    label: "Pending",
    className:
      "border-warning-border bg-warning-bg text-warning-fg",
    Icon: Clock,
  },
  active: {
    label: "Active",
    className:
      "border-success-border bg-success-bg text-success-fg",
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
  status: OrgStatus;
  className?: string;
}) {
  const s = STYLES[status];
  const Icon = s.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium",
        s.className,
        className,
      )}
    >
      <Icon className="size-3" />
      {s.label}
    </span>
  );
}
