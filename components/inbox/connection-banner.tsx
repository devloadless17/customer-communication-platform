"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, WifiOff } from "lucide-react";

import { useConnectionStatus } from "@/hooks/use-connection-status";
import { cn } from "@/lib/utils";

/**
 * Top-of-app banner showing realtime/network state. Hidden when everything's
 * fine; slides down when the socket drops or the browser goes offline.
 *
 * On recovery, the banner ALSO calls `router.refresh()`. This re-runs the
 * server components for the active route, which re-fetches the inbox list
 * and the active conversation's most recent messages — closing the
 * "events arrived during the disconnect were silently lost" gap that
 * Socket.io's connectionStateRecovery window doesn't cover for longer drops.
 *
 * Side-effects via the banner (not its own hook) so it only runs on screens
 * that mount it. A background tab with no inbox shouldn't be ping-refreshing
 * the server on every wifi blip.
 */
export function ConnectionBanner() {
  const router = useRouter();
  const { state } = useConnectionStatus({
    onRecovered: () => {
      // Re-fetch server-rendered slices (inbox list + active thread). The
      // socket has already reconnected and re-subscribed by this point;
      // refresh fills in anything that landed during the gap.
      router.refresh();
    },
  });

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
              <span>You&apos;re offline — messages will retry when you reconnect</span>
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
