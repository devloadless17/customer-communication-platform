"use client";

import { cn } from "@/lib/utils";

/**
 * Live websocket connection indicator — green pulse while the realtime
 * channel is up, red dot when it has dropped. The label tells the agent
 * whether what they're seeing is fresh.
 */
export function SessionStatus({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-sidebar-border bg-background/40 px-2.5 py-1.5">
      <span className="relative flex size-2">
        {connected && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            connected ? "bg-emerald-500" : "bg-destructive",
          )}
        />
      </span>
      <span className="text-xs font-medium">
        {connected ? "Realtime connected" : "Reconnecting…"}
      </span>
    </div>
  );
}
