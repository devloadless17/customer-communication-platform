"use client";

import { useState } from "react";
import { Archive, Check, ChevronDown, CircleCheck, CircleDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@ccp/shared/utils";
import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import type { ConversationStatus } from "@ccp/shared/types";

import { readError } from "./utils";

export function StatusDropdown({
  teamId,
  conversationId,
  current,
  onAlert,
}: {
  teamId: string;
  conversationId: string;
  current: ConversationStatus;
  onAlert: (title: string, description?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const map: Record<
    ConversationStatus,
    { label: string; icon: typeof CircleCheck; cls: string }
  > = {
    open: { label: "Open", icon: CircleDashed, cls: "text-emerald-600 dark:text-emerald-400" },
    pending: { label: "Pending", icon: CircleDashed, cls: "text-amber-600 dark:text-amber-400" },
    closed: { label: "Closed", icon: Archive, cls: "text-muted-foreground" },
  };
  const Icon = map[current].icon;

  const setStatus = async (status: ConversationStatus) => {
    if (status === current || pending) return;
    setPending(true);
    // Optimistic: fan the same socket frame the server will broadcast so
    // sidebar status badges, the row, and the right-rail mirror flip
    // instantly instead of waiting on PATCH → bus → socket round-trip.
    dispatchLocalSocketEvent("conversation:status", {
      teamId,
      conversationId,
      status,
    });
    try {
      const res = await fetch(`/api/conversations/${conversationId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        // Roll back so the chip reflects truth.
        dispatchLocalSocketEvent("conversation:status", {
          teamId,
          conversationId,
          status: current,
        });
        await onAlert("Couldn't change status", await readError(res));
      }
    } catch (err) {
      dispatchLocalSocketEvent("conversation:status", {
        teamId,
        conversationId,
        status: current,
      });
      await onAlert(
        "Couldn't change status",
        err instanceof Error ? err.message : "Network error",
      );
    } finally {
      setPending(false);
    }
  };

  const items: { value: ConversationStatus; icon: typeof CircleCheck; cls: string }[] = [
    { value: "open", icon: CircleDashed, cls: "text-emerald-600" },
    { value: "pending", icon: CircleDashed, cls: "text-amber-600" },
    { value: "closed", icon: CircleCheck, cls: "text-muted-foreground" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending}>
          <Icon className={cn("size-3.5", map[current].cls)} />
          <span className="font-normal">{map[current].label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(({ value, icon: ItemIcon, cls }) => (
          <DropdownMenuItem key={value} onSelect={() => void setStatus(value)}>
            {value === current ? (
              <Check className="size-3.5" />
            ) : (
              <ItemIcon className={cn("size-3.5", cls)} />
            )}
            {map[value].label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
