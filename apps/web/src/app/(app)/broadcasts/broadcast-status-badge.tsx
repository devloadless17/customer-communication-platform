import {
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
 */
export function BroadcastStatusBadge({ status }: { status: string }) {
  const { Icon, tone, label, spin } = mapStatus(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
        tone,
      )}
    >
      <Icon className={cn("size-3", spin && "animate-spin")} />
      {label}
    </span>
  );
}

function mapStatus(status: string) {
  switch (status) {
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
        tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        label: "Sending",
        spin: true,
      };
    case "completed":
      return {
        Icon: CheckCircle2,
        tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        label: "Completed",
        spin: false,
      };
    case "failed":
      return {
        Icon: CircleSlash,
        tone: "border-destructive/30 bg-destructive/10 text-destructive",
        label: "Failed",
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
        tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
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
