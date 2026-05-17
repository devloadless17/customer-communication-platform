"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, initials } from "@ccp/shared/utils";
import type { User } from "@ccp/shared/types";

import { readError } from "./utils";

export function AssignmentDropdown({
  conversationId,
  currentId,
  currentName,
  teamMembers,
  onAlert,
}: {
  conversationId: string;
  currentId: string | null;
  currentName: string | null;
  teamMembers: User[];
  onAlert: (title: string, description?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const assign = async (assignedUserId: string | null) => {
    if (assignedUserId === currentId || pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId }),
      });
      if (!res.ok) {
        // The optimistic UI nothing — without surfacing this the user thinks
        // the click worked until they notice the dropdown didn't change.
        await onAlert("Couldn't update assignment", await readError(res));
      }
    } catch (err) {
      await onAlert(
        "Couldn't update assignment",
        err instanceof Error ? err.message : "Network error",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending}>
          {currentName ? (
            <>
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-secondary text-[9px] font-medium">
                {initials(currentName)}
              </span>
              <span className="font-normal">{currentName.split(" ")[0]}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Assign to…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void assign(null)}>
          {currentId === null && <Check className="size-3.5" />}
          <span className={cn("text-muted-foreground", currentId === null && "ml-1")}>
            Unassigned
          </span>
        </DropdownMenuItem>
        {teamMembers.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => void assign(u.id)}>
            {currentId === u.id ? (
              <Check className="size-3.5" />
            ) : (
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium">
                {initials(u.name)}
              </span>
            )}
            <span>{u.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
