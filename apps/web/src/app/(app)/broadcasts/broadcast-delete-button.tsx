"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { toast } from "@/lib/toast";

/**
 * Per-row delete button for the broadcasts list. Server-component page
 * keeps the table render; this client island handles the confirm + DELETE.
 *
 * The page calls `router.refresh()` after a successful delete to pull the
 * fresh list — no socket event for broadcast deletes today (it's an
 * agent-initiated action, not a live feed).
 */
export function BroadcastDeleteButton({
  broadcastId,
  templateName,
  status,
}: {
  broadcastId: string;
  templateName: string;
  status: string;
}) {
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, setPending] = useState(false);

  const disabled = status === "running" || status === "queued" || pending;

  async function run() {
    const ok = await confirm({
      title: `Delete the broadcast for "${templateName}"?`,
      description:
        "The audit row and per-recipient delivery status will be removed. The messages it sent stay in your inbox history.",
      confirmLabel: "Delete broadcast",
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      const res = await fetch(`/api/broadcasts/${broadcastId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        toast.error("Couldn't delete broadcast", {
          description:
            [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Broadcast deleted");
      softRefresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={run}
        disabled={disabled}
        title={
          status === "running" || status === "queued"
            ? "Wait for the broadcast to finish"
            : "Delete this broadcast"
        }
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        aria-label="Delete broadcast"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
      </button>
      {confirmDialog}
    </div>
  );
}
