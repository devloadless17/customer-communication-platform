"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2, MoreHorizontal, Trash2 } from "lucide-react";

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

export function ConversationMenu({
  conversationId,
  contactName,
}: {
  conversationId: string;
  contactName: string;
}) {
  const router = useRouter();
  const { confirm, alert, confirmDialog } = useConfirm();
  const [pending, setPending] = useState(false);

  async function markUnread() {
    setPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/unread`, {
        method: "POST",
      });
      if (!res.ok) {
        await alert("Couldn't mark as unread", "Please try again.");
        return;
      }
      // Pull fresh data through the server component so the conversation list
      // re-renders with the bumped unreadCount. The conversation list reflects
      // the change on next SSR pass; meanwhile the user has navigated away.
      router.push("/inbox");
    } finally {
      setPending(false);
    }
  }

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
      const res = await fetch(`/api/conversations/${conversationId}`, {
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
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
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              void markUnread();
            }}
          >
            <CheckCheck className="size-3.5" />
            Mark as unread
          </DropdownMenuItem>
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
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDialog}
    </>
  );
}
