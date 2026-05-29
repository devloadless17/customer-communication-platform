"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { cn } from "@ccp/shared/utils";
import {
  ALL_AVAILABILITY_STATUSES,
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
  resolveAvailabilityStatus,
} from "@ccp/shared/presence";
import type { User, UserAvailabilityStatus } from "@ccp/shared/types";

/**
 * Availability picker rendered inside the AppRail user menu.
 *
 * Three concerns:
 *   1. Seed the displayed status + note from the session-provided `currentUser`
 *      so the first paint is correct without a fetch.
 *   2. Mutate via PATCH /api/users/me/availability. Fully optimistic — the UI
 *      flips immediately on click and the local socket dispatch fans the
 *      change to every open surface; the server PATCH is fire-and-forget at
 *      the UI layer (rollback fires another local frame on failure). No
 *      "Saving…" affordance, no disabled buttons mid-flight; that produced
 *      a visible dropdown re-layout / jump on every click.
 *   3. Subscribe to `user:availability:updated` for THIS user so a change made
 *      on another device / tab keeps every open client in sync without a
 *      page reload.
 *
 * Capability gating happens at the parent — when `disabled` is true the picker
 * renders read-only (status visible, no controls). The server endpoint also
 * gates with `@RequireCapability("availability:manage")` so a tampered UI
 * can't bypass it.
 */
export function AvailabilityPicker({
  currentUser,
  disabled,
}: {
  currentUser: User;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<UserAvailabilityStatus>(
    resolveAvailabilityStatus(currentUser.availabilityStatus),
  );
  const [message, setMessage] = useState<string>(currentUser.availabilityMessage ?? "");
  const [error, setError] = useState<string | null>(null);
  // Debounce the message PATCH so a typing burst doesn't fire one POST per
  // keystroke; the status buttons commit immediately.
  const messageCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last server-known message so we only PATCH when something
  // actually changed (otherwise tabbing through the input fires a no-op req).
  const lastCommittedMessageRef = useRef<string>(currentUser.availabilityMessage ?? "");

  // Cross-device sync: when our own user's availability changes elsewhere,
  // mirror it here so the picker doesn't drift.
  useEffect(() => {
    const socket = getClientSocket();
    const handler: Parameters<
      typeof socket.on<"user:availability:updated">
    >[1] = (payload) => {
      if (payload.userId !== currentUser.id) return;
      setStatus(payload.status);
      if (payload.message === null) {
        setMessage("");
        lastCommittedMessageRef.current = "";
      } else if (typeof payload.message === "string") {
        setMessage(payload.message);
        lastCommittedMessageRef.current = payload.message;
      }
    };
    socket.on("user:availability:updated", handler);
    return () => {
      socket.off("user:availability:updated", handler);
    };
  }, [currentUser.id]);

  // Cancel any pending debounced commit on unmount.
  useEffect(() => {
    return () => {
      if (messageCommitRef.current !== null) {
        clearTimeout(messageCommitRef.current);
      }
    };
  }, []);

  async function commit(
    nextStatus: UserAvailabilityStatus | undefined,
    nextMessage: string | null | undefined,
  ): Promise<void> {
    if (disabled) return;
    setError(null);
    const prevStatus = status;
    const prevMessage = lastCommittedMessageRef.current;
    // Optimistic local state + dispatch — sidebar, viewer pill, user menu
    // all flip in the same frame as the click. Server fanout will land
    // moments later with the same payload; reducers' identity-bail keeps
    // the second pass invisible.
    if (nextStatus !== undefined) setStatus(nextStatus);
    if (nextMessage !== undefined) {
      const committed = nextMessage === null ? "" : nextMessage;
      setMessage(committed);
      lastCommittedMessageRef.current = committed;
    }
    if (nextStatus !== undefined || nextMessage !== undefined) {
      const effectiveStatus = nextStatus ?? prevStatus;
      const effectiveMessage =
        nextMessage === undefined ? prevMessage : nextMessage ?? "";
      dispatchLocalSocketEvent("user:availability:updated", {
        teamId: currentUser.teamId,
        userId: currentUser.id,
        status: effectiveStatus,
        message: nextMessage === undefined ? undefined : effectiveMessage || null,
      });
    }
    try {
      const body: Record<string, unknown> = {};
      if (nextStatus !== undefined) body.status = nextStatus;
      if (nextMessage !== undefined) {
        body.message = nextMessage === null || nextMessage === "" ? null : nextMessage;
      }
      const res = await apiFetch("/api/users/me/availability", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        setError(res.status === 403 ? "Not allowed" : detail || "Couldn't update");
        // Roll back the optimistic state + dispatch.
        setStatus(prevStatus);
        setMessage(prevMessage);
        lastCommittedMessageRef.current = prevMessage;
        dispatchLocalSocketEvent("user:availability:updated", {
          teamId: currentUser.teamId,
          userId: currentUser.id,
          status: prevStatus,
          message: prevMessage || null,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setStatus(prevStatus);
      setMessage(prevMessage);
      lastCommittedMessageRef.current = prevMessage;
      dispatchLocalSocketEvent("user:availability:updated", {
        teamId: currentUser.teamId,
        userId: currentUser.id,
        status: prevStatus,
        message: prevMessage || null,
      });
    }
  }

  function onPickStatus(next: UserAvailabilityStatus): void {
    if (next === status) return;
    void commit(next, undefined);
  }

  function onMessageChange(value: string): void {
    setMessage(value);
    if (messageCommitRef.current !== null) clearTimeout(messageCommitRef.current);
    messageCommitRef.current = setTimeout(() => {
      messageCommitRef.current = null;
      if (value === lastCommittedMessageRef.current) return;
      void commit(undefined, value || null);
    }, 600);
  }

  return (
    <div className="flex flex-col px-1 py-1">
      <div className="px-2 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
        Availability
      </div>
      <div className="flex flex-col gap-0.5">
        {ALL_AVAILABILITY_STATUSES.map((s) => {
          const active = s === status;
          return (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => onPickStatus(s)}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-[background-color,color] duration-150",
                active
                  ? "bg-accent/80 text-foreground"
                  : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
                disabled && "cursor-not-allowed opacity-60",
                !disabled && "cursor-pointer focus-visible:bg-accent/60",
              )}
              aria-pressed={active}
            >
              <span
                className={cn(
                  "size-2.5 shrink-0 rounded-full ring-2 ring-background transition-shadow",
                  AVAILABILITY_DOT_CLASSES[s],
                  active && "ring-accent/80",
                )}
              />
              <span className="flex-1 font-medium">{AVAILABILITY_LABELS[s]}</span>
              <Check
                className={cn(
                  "size-3.5 text-foreground/70 transition-opacity duration-150",
                  active ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 px-1">
        <input
          type="text"
          value={message}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Add a status note (optional)"
          className={cn(
            "h-8 w-full rounded-md border border-border/60 bg-muted/30 px-2.5 text-[12px] outline-none transition-colors",
            "placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:bg-background",
            disabled && "cursor-not-allowed opacity-60",
          )}
        />
        <div className="mt-1 flex h-3.5 items-center justify-between px-1 text-[10px] text-muted-foreground/60">
          <span>{message.length > 0 ? `${message.length}/100` : ""}</span>
          {error ? <span className="text-destructive">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
