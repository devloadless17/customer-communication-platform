"use client";

import { useState } from "react";
import { ArrowUpRight, Loader2, Ticket as TicketIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/**
 * The ticket in the URL exists — in ANOTHER workspace this user can open.
 * The normal way here is following an escalation pair across a switch, a
 * shared link from a colleague, or the back button. Offer the one click that
 * fixes it: switch this device's active workspace, then a FULL reload of the
 * same URL (never a soft route — the socket must leave the old `ws:` room).
 */
export function TicketElsewhere({
  workspaceId,
  workspaceName,
  number,
}: {
  workspaceId: string;
  workspaceName: string;
  number: number;
}) {
  const [busy, setBusy] = useState(false);

  async function switchAndOpen() {
    setBusy(true);
    try {
      const res = await apiFetch("/api/workspaces/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) {
        toast.error("Couldn't switch workspace. Please try again.");
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      toast.error("Couldn't switch workspace. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <TicketIcon aria-hidden className="size-5" />
      </div>
      <h1 className="text-sm font-semibold">
        Ticket #{number} lives in {workspaceName}
      </h1>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Tickets stay inside their workspace, and this one belongs to{" "}
        <strong className="font-medium text-foreground">{workspaceName}</strong> — not the
        workspace you&rsquo;re viewing. Switch there to open it.
      </p>
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={() => void switchAndOpen()}
        className="mt-1 h-8 gap-1.5 text-xs"
      >
        {busy ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <ArrowUpRight aria-hidden className="size-3.5" />
        )}
        Switch to {workspaceName} and open it
      </Button>
    </div>
  );
}
