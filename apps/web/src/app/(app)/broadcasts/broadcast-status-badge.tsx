import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  ClockArrowUp,
  Loader2,
  PauseCircle,
} from "lucide-react";

import { cn } from "@ccp/shared/utils";

/**
 * Visual chip for a Broadcast.status value. Server component — no animations,
 * the loader icon spins via Tailwind's `animate-spin`.
 *
 * `failedCount` / `totalCount` refine the terminal `completed` case: a run that
 * "completed" but had failures must NOT read as a clean green success (the
 * source of "it says Completed so I thought it sent"). All-failed → red,
 * partial → amber, clean → green.
 */
export function BroadcastStatusBadge({
  status,
  failedCount = 0,
  totalCount = 0,
}: {
  status: string;
  failedCount?: number;
  totalCount?: number;
}) {
  const { Icon, tone, label, spin } = mapStatus(status, failedCount, totalCount);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-2xs font-medium",
        tone,
      )}
    >
      <Icon className={cn("size-3 shrink-0", spin && "animate-spin")} />
      {label}
    </span>
  );
}

function mapStatus(status: string, failedCount: number, totalCount: number) {
  switch (status) {
    case "scheduled":
      // Future send; a delayed job fires it at scheduledAt. Indigo to read as
      // "planned / upcoming", distinct from the gray of queued (about to run).
      return {
        Icon: CalendarClock,
        tone: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
        label: "Scheduled",
        spin: false,
      };
    case "queued":
      return {
        Icon: ClockArrowUp,
        tone: "border-border bg-muted/40 text-muted-foreground",
        label: "Queued",
        spin: false,
      };
    case "running":
      return {
        Icon: Loader2,
        tone: "border-info-border bg-info-bg text-info-fg",
        label: "Sending",
        spin: true,
      };
    case "completed": {
      // All recipients failed → this is really a failure; don't paint it green.
      if (failedCount > 0 && totalCount > 0 && failedCount >= totalCount) {
        return {
          Icon: CircleSlash,
          tone: "border-destructive/30 bg-destructive/10 text-destructive",
          label: totalCount > 1 ? "All failed" : "Failed",
          spin: false,
        };
      }
      // Some failed → amber "N failed" so it's visibly not a clean success.
      if (failedCount > 0) {
        return {
          Icon: AlertTriangle,
          tone: "border-warning-border bg-warning-bg text-warning-fg",
          label: `Completed · ${failedCount} failed`,
          spin: false,
        };
      }
      return {
        Icon: CheckCircle2,
        tone: "border-success-border bg-success-bg text-success-fg",
        label: "Completed",
        spin: false,
      };
    }
    case "failed":
      // Set by the runner when every recipient failed (or a whole-broadcast
      // pre-flight error). Mirror the completed-all-failed wording: "All failed"
      // for a multi-recipient run, "Failed" for a single.
      return {
        Icon: CircleSlash,
        tone: "border-destructive/30 bg-destructive/10 text-destructive",
        label: totalCount > 1 ? "All failed" : "Failed",
        spin: false,
      };
    case "canceled":
      return {
        Icon: CircleSlash,
        tone: "border-border bg-muted/40 text-muted-foreground",
        label: "Canceled",
        spin: false,
      };
    case "paused":
      // Auto-paused by graceful shutdown — boot reconciler will resume
      // automatically on next restart. Amber to communicate "in-flight,
      // waiting" without the alarm of red/failed.
      return {
        Icon: PauseCircle,
        tone: "border-warning-border bg-warning-bg text-warning-fg",
        label: "Paused (auto-resumes)",
        spin: false,
      };
    default:
      return {
        Icon: ClockArrowUp,
        tone: "border-border bg-muted/40 text-muted-foreground",
        label: status,
        spin: false,
      };
  }
}
