"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Flag, Loader2, RotateCcw, X } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { MessageFlagQueueItem, MessageFlagStatus } from "@ccp/shared/message-flags/types";

/**
 * Every triage flag raised on THIS conversation, open first.
 *
 * The thread already shows a chip under each flagged message, but that only
 * answers "is this message flagged" while you happen to be looking at it. This
 * panel answers the question an agent opening a busy thread actually has:
 * "what is still outstanding here, and has it been dealt with?" — without
 * scrolling a thousand messages to find out.
 *
 * Open items are listed before handled ones regardless of age, because the
 * panel is a worklist first and a record second. Clicking a row jumps the
 * thread to the flagged message.
 */
export function FlagsPanel({
  conversationId,
  onGoToMessage,
}: {
  conversationId: string;
  onGoToMessage: (messageId: string) => void;
}) {
  const [items, setItems] = useState<MessageFlagQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        conversationId,
        // All three states: the handled ones are the answer to "did we deal
        // with it?", which is the whole reason this panel exists.
        status: "open,resolved,dismissed",
        take: "50",
      });
      const res = await apiFetch(`/api/message-flags?${params.toString()}`);
      if (!res.ok) throw new Error("Couldn't load flags");
      const body = (await res.json()) as { items: MessageFlagQueueItem[] };
      setItems(body.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load flags");
      setItems([]);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Converge on every flag mutation — ours, a teammate's, or one made from the
  // bubble chip a few pixels to the left. Filtered to this conversation so an
  // unrelated flag elsewhere in the workspace doesn't refetch the panel.
  useEffect(() => {
    const socket = getClientSocket();
    const onFlag = (payload: { conversationId: string }) => {
      if (payload.conversationId !== conversationId) return;
      void load();
    };
    socket.on("message:flag", onFlag);
    return () => {
      socket.off("message:flag", onFlag);
    };
  }, [conversationId, load]);

  const setStatus = async (flagId: string, status: MessageFlagStatus) => {
    try {
      const res = await apiFetch(`/api/message-flags/${flagId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as {
          detail?: string;
          error?: string;
        };
        throw new Error(d.detail || d.error || "Couldn't update this flag");
      }
      // The row re-renders from the socket frame above — no optimistic splice.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update this flag");
    }
  };

  if (items === null) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-5 my-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <Flag className="size-5 text-muted-foreground/50" />
        <p className="text-sm font-medium">Nothing flagged here</p>
        <p className="text-xs text-muted-foreground">
          Flag a message from its ⋯ menu to track it — a complaint, a refund
          request, anything worth coming back to.
        </p>
      </div>
    );
  }

  // Open first, then most recent. `sort` on a copy — the state array is shared.
  const ordered = [...items].sort((a, b) => {
    const aOpen = a.status === "open" ? 0 : 1;
    const bOpen = b.status === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  return (
    <ul className="flex flex-col gap-1.5 p-3">
      {ordered.map((flag) => {
        const open = flag.status === "open";
        const colors = tagColorClasses(flag.definition.color);
        const footer = [
          flag.note ? `“${flag.note}”` : null,
          flag.assignedToName ? `Owner: ${flag.assignedToName}` : null,
          !open && flag.resolvedByName
            ? `${flag.status === "dismissed" ? "Dismissed" : "Resolved"} by ${flag.resolvedByName}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <li
            key={flag.id}
            className={cn(
              "group relative overflow-hidden rounded-lg border transition-colors",
              open
                ? "border-border bg-card hover:border-foreground/15 hover:bg-accent/40"
                : "border-border/50 bg-muted/30 hover:bg-muted/50",
            )}
          >
            {/* A hairline in the flag's own color — the pill alone left the row
                with no anchor, so a list of flags read as loose text. Handled
                items lose the accent: the color is a "still open" signal. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 left-0 w-0.5",
                open ? colors.swatch : "bg-border",
              )}
            />
            <div className="flex items-start gap-2 py-2.5 pl-3 pr-2">
              <button
                type="button"
                onClick={() => onGoToMessage(flag.messageId)}
                title="Jump to this message"
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 py-0.5 text-2xs leading-tight",
                      open
                        ? colors.pill
                        : "border-border/60 text-muted-foreground line-through",
                    )}
                  >
                    <Flag className="size-2.5 shrink-0" />
                    <span className="truncate">{flag.definition.name}</span>
                  </span>
                  {flag.source === "ai" && (
                    <span className="rounded-sm bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                      AI
                    </span>
                  )}
                  <span className="text-2xs text-muted-foreground">
                    <LocalTime iso={flag.createdAt} format="listTime" />
                  </span>
                </div>

                {/* The excerpt is a QUOTE of someone else's message, so it gets
                    a quote rule — otherwise it read as a stray caption under
                    the pill. */}
                <p
                  dir="auto"
                  className="mt-1.5 line-clamp-2 border-l-2 border-border pl-2 text-xs leading-relaxed text-muted-foreground"
                >
                  {flag.messageExcerpt || (
                    <i className="opacity-60">No text content</i>
                  )}
                </p>

                {footer && (
                  <p className="mt-1 truncate text-2xs text-muted-foreground/80">
                    {footer}
                  </p>
                )}
              </button>

              {/* Actions reveal on hover on pointer devices and stay put on
                  touch — a worklist gets triaged fast, so hunting for a hidden
                  control per row would be the wrong trade. */}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                {open ? (
                  <>
                    <IconAction
                      label="Mark resolved"
                      onClick={() => void setStatus(flag.id, "resolved")}
                      tone="positive"
                    >
                      <Check className="size-3.5" />
                    </IconAction>
                    <IconAction
                      label="Dismiss — this wasn't one"
                      onClick={() => void setStatus(flag.id, "dismissed")}
                    >
                      <X className="size-3.5" />
                    </IconAction>
                  </>
                ) : (
                  <IconAction
                    label="Reopen"
                    onClick={() => void setStatus(flag.id, "open")}
                  >
                    <RotateCcw className="size-3.5" />
                  </IconAction>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function IconAction({
  label,
  onClick,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  /** `positive` tints the resolve action green — the one action you want to hit. */
  tone?: "positive";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        tone === "positive"
          ? "hover:bg-emerald-500/15 hover:text-emerald-600 dark:hover:text-emerald-400"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
