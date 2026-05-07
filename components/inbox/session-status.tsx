"use client";

import { cn } from "@/lib/utils";

/**
 * Connection status of the WhatsApp session (Evolution instance). Real wiring
 * lands Week 3 — for now we accept a static prop so the chrome is right.
 */
export function SessionStatus({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-sidebar-border bg-background/40 px-2.5 py-1.5">
      <span className="relative flex size-2">
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-75",
            connected ? "bg-emerald-500 animate-ping" : "bg-destructive",
          )}
        />
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            connected ? "bg-emerald-500" : "bg-destructive",
          )}
        />
      </span>
      <span className="text-xs font-medium">
        {connected ? "Session connected" : "Session disconnected"}
      </span>
      <span className="ml-auto text-[10px] font-mono text-muted-foreground">+44 79 11…</span>
    </div>
  );
}
