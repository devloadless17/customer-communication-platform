"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Loader2, WifiOff } from "lucide-react";

import { useConnectionStatus } from "@/hooks/use-connection-status";
import { cn } from "@ccp/shared/utils";

/**
 * Top-of-app banner showing realtime/network state. Hidden when everything's
 * fine; slides down when the socket drops or the browser goes offline.
 *
 * Recovery refetch lives ON the per-route hooks (`useConversationEvents` for
 * the active thread, `useTeamEvents` for the inbox list). The banner used
 * to also call `router.refresh()` here on recovery, but that fired in
 * PARALLEL with the per-route full-refetch — every reconnect doubled the
 * recovery payload AND defeated the jitter the per-route refetch deliberately
 * applies. The per-route paths cover the full surface; this banner is now
 * purely visual.
 */
export function ConnectionBanner() {
  const { state } = useConnectionStatus({});

  const visible = state !== "online";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={state}
          role="status"
          aria-live="polite"
          initial={{ y: -32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -32, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className={cn(
            "absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium shadow-xs",
            state === "offline"
              ? "bg-destructive text-destructive-foreground"
              : "bg-amber-500 text-white",
          )}
        >
          {state === "offline" ? (
            <>
              <WifiOff className="size-3.5" />
              <span>You&apos;re offline — sending is paused</span>
            </>
          ) : (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span>Reconnecting…</span>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
