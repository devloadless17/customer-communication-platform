"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, MoreHorizontal, Trash2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiFetch } from "@/lib/api/client-fetch";

/** Operator-readable copy for the block endpoint's typed error codes. */
const BLOCK_ERROR_COPY: Record<string, string> = {
  reengagement_required:
    "WhatsApp only allows blocking people who messaged you in the last 24 hours. " +
    "Wait for their next message, then block them.",
  blocklist_full:
    "This number's blocklist is full — WhatsApp caps it at 64,000 people. " +
    "Unblock someone first.",
  rate_limited: "Too many block requests in a row — try again in a moment.",
  blocking_not_supported: "Blocking isn't available on this channel.",
};

export function ConversationMenu({
  conversationId,
  contactId,
  contactName,
  contactBlockedAt = null,
  canBlock = false,
  canDelete = true,
}: {
  conversationId: string;
  contactId: string;
  contactName: string;
  /** Contact's current block state — flips live via `contact.updated`. */
  contactBlockedAt?: string | null;
  /** Channel capability gate (`blockUsers` — WhatsApp only today). */
  canBlock?: boolean;
  /** Permission gate for the destructive delete action. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const { confirm, alert, confirmDialog } = useConfirm();
  const [pending, setPending] = useState(false);

  // Mark-as-unread was removed 2026-05-19 — operators reported it as
  // not useful in practice (the unread badge is driven by inbound
  // messages, not by manual toggles, and bumping a thread back to
  // "unread" after reading didn't match anyone's workflow). The server
  // route + service were deleted 2026-05-21 (they published no fanout
  // event, so a re-introduction would have silently failed to update
  // other clients). If re-adding: add a `conversation.unread` domain
  // event + fanout rule + optimistic dispatch alongside the endpoint.

  async function deleteConversation() {
    const ok = await confirm({
      title: `Delete this chat with "${contactName}"?`,
      description:
        "Removes all messages and notes from this thread. The contact stays. This can't be undone.",
      confirmLabel: "Delete chat",
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      const res = await apiFetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        await alert("Couldn't delete chat", "Please try again.");
        return;
      }
      router.push("/inbox");
    } finally {
      setPending(false);
    }
  }

  async function toggleBlocked() {
    const blocking = !contactBlockedAt;
    if (blocking) {
      const ok = await confirm({
        title: `Block "${contactName}"?`,
        description:
          "They won't be able to message you or see that you're online, and you " +
          "won't be able to message them until you unblock them. WhatsApp only " +
          "allows blocking people who messaged you in the last 24 hours.",
        confirmLabel: "Block contact",
        destructive: true,
      });
      if (!ok) return;
    }
    setPending(true);
    try {
      const res = await apiFetch(
        `/api/contacts/${contactId}/${blocking ? "block" : "unblock"}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        await alert(
          blocking ? "Couldn't block contact" : "Couldn't unblock contact",
          (body?.error && BLOCK_ERROR_COPY[body.error]) ??
            body?.detail ??
            "Please try again.",
        );
        return;
      }
      // No local state to flip: the server publishes `contact.updated`, and
      // the socket frame updates the thread (reply-box lock) + panel for
      // everyone — including this tab — from one authoritative source.
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 pointer-coarse:size-9"
            aria-label="Conversation actions"
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Chat actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {canBlock && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void toggleBlocked();
              }}
              className={
                contactBlockedAt
                  ? undefined
                  : "text-destructive focus:bg-destructive/10 focus:text-destructive"
              }
            >
              {contactBlockedAt ? (
                <>
                  <Undo2 className="size-3.5" />
                  Unblock contact
                </>
              ) : (
                <>
                  <Ban className="size-3.5" />
                  Block contact
                </>
              )}
            </DropdownMenuItem>
          )}
          {canDelete && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void deleteConversation();
              }}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete chat
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDialog}
    </>
  );
}
