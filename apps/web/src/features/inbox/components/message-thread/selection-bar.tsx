"use client";

import { Forward, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Selection bar — replaces the composer while the thread is in multi-select
 * mode. Mirrors the ReplyBox footer chrome so the swap doesn't jump.
 */
export function SelectionBar({
  count,
  onForward,
  onCancel,
}: {
  count: number;
  onForward: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border-t-2 border-primary/30 bg-accent/20">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{count}</span>{" "}
          {count === 1 ? "message" : "messages"} selected
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1.5">
            <X className="size-3.5" />
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onForward}
            disabled={count === 0}
            title={count === 0 ? "Tick at least one message first" : undefined}
            className="gap-1.5"
          >
            <Forward className="size-3.5" />
            Forward
          </Button>
        </div>
      </div>
    </div>
  );
}
