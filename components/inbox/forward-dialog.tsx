"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { ContactSelectDialog } from "@/components/contacts/contact-select-dialog";
import type { ForwardResult } from "@/lib/types";

/**
 * "Forward to…" — picks one or more contacts (reusing the app-wide
 * {@link ContactSelectDialog}) and POSTs the queued message ids to
 * `/api/messages/forward`. Reports a one-line summary back via `onDone` so the
 * thread can flash a toast; leaves the heavy lifting (24h-window failures,
 * conversation creation) to the server.
 */
export function ForwardDialog({
  open,
  messageIds,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Message ids to forward, frozen at open time. */
  messageIds: string[];
  onClose: () => void;
  /** Called once the forward resolves (success or partial failure). */
  onDone: (summary: string, ok: boolean) => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const count = messageIds.length;

  async function submit(contactIds: string[]) {
    if (submitting || contactIds.length === 0 || messageIds.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/messages/forward", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageIds, contactIds }),
      });
      const data = (await res.json().catch(() => null)) as
        | { results?: ForwardResult[]; error?: string; detail?: string }
        | null;

      if (!res.ok || !data?.results) {
        onDone(
          data?.detail || data?.error || `Forward failed (HTTP ${res.status})`,
          false,
        );
        return;
      }
      onDone(summarize(data.results, count), data.results.every((r) => r.ok));
    } catch (err) {
      onDone(err instanceof Error ? err.message : "Forward failed", false);
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  if (!open) return null;

  return (
    <>
      <ContactSelectDialog
        open={open}
        onClose={onClose}
        onConfirm={(contactIds) => void submit(contactIds)}
        title="Forward to…"
        description={`${count} message${count === 1 ? "" : "s"} will be sent`}
        confirmLabel="Forward"
      />
      {submitting && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            Forwarding…
          </div>
        </div>
      )}
    </>
  );
}

function summarize(results: ForwardResult[], messageCount: number): string {
  const okCount = results.filter((r) => r.ok).length;
  const m = `${messageCount} message${messageCount === 1 ? "" : "s"}`;

  if (okCount === results.length) {
    return `Forwarded ${m} to ${results.length} contact${
      results.length === 1 ? "" : "s"
    }`;
  }
  if (okCount === 0) {
    // Surface the first contact's reason — usually the 24h window.
    const reason = results.find((r) => r.error)?.error;
    return reason
      ? `Couldn't forward — ${reason}`
      : `Couldn't forward ${m} to any contact`;
  }
  const failing = results.filter((r) => !r.ok);
  const names = failing.map((r) => r.contactName).slice(0, 2).join(", ");
  const more = failing.length > 2 ? ` +${failing.length - 2} more` : "";
  return `Forwarded to ${okCount}/${results.length} — failed: ${names}${more}`;
}
