"use client";

import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { ContactSelectDialog } from "@/features/contacts/components/contact-select-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";
import type { ForwardResult } from "@ccp/shared/types";

/**
 * "Forward to…" — picks one or more contacts (reusing the app-wide
 * {@link ContactSelectDialog}) and POSTs the queued message ids to
 * `/api/messages/forward`.
 *
 * Fire-and-forget: the moment the user confirms, the picker closes and the
 * request runs in the background. Success is silent (the messages just
 * appear in their target threads via Socket.io); only errors / partial
 * failures bubble back through `onError` so the thread can surface them.
 * The pre-forward "N messages will be sent" description in the picker is
 * the only confirmation step — no blocking loading state.
 */
export function ForwardDialog({
  open,
  messageIds,
  onClose,
  onError,
}: {
  open: boolean;
  /** Message ids to forward, frozen at open time. */
  messageIds: string[];
  onClose: () => void;
  /** Called only when the forward errors or partially fails. */
  onError: (summary: string) => void;
}) {
  const count = messageIds.length;
  const softRefresh = useSoftRefresh();

  function submit(contactIds: string[]) {
    if (contactIds.length === 0 || messageIds.length === 0) return;
    onClose();
    // I-1: stable per-action idempotency id. A transport-level retry of this
    // request reuses the same body (same id) and is deduped server-side, so a
    // network blip can't re-deliver the forwarded messages to customers.
    const clientTempId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `fwd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void runForward(messageIds, contactIds, count, onError, softRefresh, clientTempId);
  }

  if (!open) return null;

  return (
    <ContactSelectDialog
      open={open}
      onClose={onClose}
      onConfirm={(contactIds) => submit(contactIds)}
      title="Forward to…"
      description={`${count} message${count === 1 ? "" : "s"} will be sent`}
      confirmLabel="Forward"
    />
  );
}

async function runForward(
  messageIds: string[],
  contactIds: string[],
  count: number,
  onError: (summary: string) => void,
  onAnySent: () => void,
  clientTempId: string,
) {
  try {
    const res = await apiFetch("/api/messages/forward", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIds, contactIds, clientTempId }),
    });
    const data = (await res.json().catch(() => null)) as
      | { results?: ForwardResult[]; error?: string; detail?: string }
      | null;

    if (!res.ok || !data?.results) {
      onError(
        data?.detail || data?.error || `Forward failed (HTTP ${res.status})`,
      );
      return;
    }
    // Invalidate Next's client router cache if anything actually went out.
    // Once a user clicks into a thread its RSC payload is cached; without
    // this refresh, navigating back to a forwarded-to thread would render
    // from that stale cache and miss the forwarded message (the realtime
    // message:new fires before the user mounts that thread, so the live
    // append handler doesn't catch it either). The refresh marks every
    // cached route stale → next click re-fetches with the new row.
    if (data.results.some((r) => r.sent > 0)) onAnySent();
    const failed = data.results.filter((r) => !r.ok);
    if (failed.length === 0) {
      // All recipients succeeded — confirm so the agent knows it went out
      // (the forward is otherwise silent; the messages just appear in the
      // target threads via Socket.io).
      const n = data.results.length;
      toast.success(`Forwarded to ${n} contact${n === 1 ? "" : "s"}`);
      return;
    }

    const m = `${count} message${count === 1 ? "" : "s"}`;
    if (failed.length === data.results.length) {
      const reason = failed.find((r) => r.error)?.error;
      onError(reason ? `Couldn't forward — ${reason}` : `Couldn't forward ${m}`);
      return;
    }
    const names = failed.map((r) => r.contactName).slice(0, 2).join(", ");
    const more = failed.length > 2 ? ` +${failed.length - 2} more` : "";
    const okCount = data.results.length - failed.length;
    onError(`Forwarded to ${okCount}/${data.results.length} — failed: ${names}${more}`);
  } catch (err) {
    onError(err instanceof Error ? err.message : "Forward failed");
  }
}
