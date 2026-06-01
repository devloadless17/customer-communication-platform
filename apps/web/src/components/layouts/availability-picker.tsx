"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

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
 *   2. Mutate via PATCH /api/users/me/availability.
 *      - Status is optimistic: the UI flips immediately on click and a local
 *        socket dispatch fans the change to every open surface; the PATCH is
 *        fire-and-forget (rollback fires another local frame on failure). No
 *        disabled-mid-flight buttons — that produced a dropdown re-layout jump.
 *      - The note is EXPLICITLY saved (Save button / Enter / blur), with a
 *        visible Saving…→Saved cue. The old silent 600ms debounce dropped the
 *        write whenever the dropdown closed inside the window (it unmounts and
 *        the timer was cancelled) — i.e. the normal "type then click away"
 *        flow never saved, with no affordance telling the user how. An explicit
 *        save fixes both the lost write and the discoverability.
 *   3. Subscribe to `user:availability:updated` for THIS user so a change made
 *      on another device / tab keeps every open client in sync without reload.
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
  const initialMessage = currentUser.availabilityMessage ?? "";
  const [status, setStatus] = useState<UserAvailabilityStatus>(
    resolveAvailabilityStatus(currentUser.availabilityStatus),
  );
  // `message` is the live input; `committedMessage` is the last server-known
  // value. `dirty` (their inequality) drives the Save affordance.
  const [message, setMessage] = useState<string>(initialMessage);
  const [committedMessage, setCommittedMessage] = useState<string>(initialMessage);
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const dirty = message !== committedMessage;

  // Refs mirror state for the unmount flush (the cleanup closes over stale
  // state otherwise) and for synchronous reads inside async handlers.
  const messageRef = useRef(message);
  const committedRef = useRef(committedMessage);
  const disabledRef = useRef(disabled);
  const savingRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  messageRef.current = message;
  committedRef.current = committedMessage;
  disabledRef.current = disabled;

  // Cross-device sync: when our own user's availability changes elsewhere,
  // mirror it here so the picker doesn't drift. Never clobber an unsaved local
  // edit — only adopt the incoming text into the live input when the user
  // isn't mid-edit; always update the committed baseline so `dirty` is correct.
  useEffect(() => {
    const socket = getClientSocket();
    const handler: Parameters<
      typeof socket.on<"user:availability:updated">
    >[1] = (payload) => {
      if (payload.userId !== currentUser.id) return;
      setStatus(payload.status);
      if (payload.message === null || typeof payload.message === "string") {
        const incoming = payload.message ?? "";
        setMessage((curr) => (curr === committedRef.current ? incoming : curr));
        setCommittedMessage(incoming);
        committedRef.current = incoming;
      }
    };
    socket.on("user:availability:updated", handler);
    return () => {
      socket.off("user:availability:updated", handler);
    };
  }, [currentUser.id]);

  // Unmount flush — the menu can close before an explicit save (the dropdown
  // unmounts this component). If the note is still unsaved and no save is
  // already in flight, persist it fire-and-forget so typing is never lost; the
  // server fans the change back to every open surface.
  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      const latest = messageRef.current;
      if (!disabledRef.current && !savingRef.current && latest !== committedRef.current) {
        void apiFetch("/api/users/me/availability", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: latest === "" ? null : latest }),
        }).catch(() => {});
      }
    };
  }, []);

  async function commitStatus(next: UserAvailabilityStatus): Promise<void> {
    if (disabled || next === status) return;
    setError(null);
    const prev = status;
    // Optimistic local state + dispatch — sidebar, viewer pill, user menu all
    // flip in the same frame as the click. Server fanout lands moments later
    // with the same payload; reducers' identity-bail keeps the echo invisible.
    setStatus(next);
    dispatchLocalSocketEvent("user:availability:updated", {
      teamId: currentUser.teamId,
      userId: currentUser.id,
      status: next,
      message: undefined,
    });
    try {
      const res = await apiFetch("/api/users/me/availability", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        setError(res.status === 403 ? "Not allowed" : detail || "Couldn't update");
        setStatus(prev);
        dispatchLocalSocketEvent("user:availability:updated", {
          teamId: currentUser.teamId,
          userId: currentUser.id,
          status: prev,
          message: undefined,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setStatus(prev);
      dispatchLocalSocketEvent("user:availability:updated", {
        teamId: currentUser.teamId,
        userId: currentUser.id,
        status: prev,
        message: undefined,
      });
    }
  }

  async function saveNote(): Promise<void> {
    // Bail when there's nothing to save or a save is already running — so the
    // blur backstop + a Save-button click (blur fires first) don't double-PATCH.
    if (disabled || savingRef.current || messageRef.current === committedRef.current) {
      return;
    }
    const target = messageRef.current;
    savingRef.current = true;
    setError(null);
    setNoteState("saving");
    try {
      const res = await apiFetch("/api/users/me/availability", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: target === "" ? null : target }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        setError(res.status === 403 ? "Not allowed" : detail || "Couldn't save");
        setNoteState("idle");
        return;
      }
      setCommittedMessage(target);
      committedRef.current = target;
      dispatchLocalSocketEvent("user:availability:updated", {
        teamId: currentUser.teamId,
        userId: currentUser.id,
        status,
        message: target === "" ? null : target,
      });
      setNoteState("saved");
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        setNoteState("idle");
      }, 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setNoteState("idle");
    } finally {
      savingRef.current = false;
    }
  }

  function onMessageChange(value: string): void {
    setMessage(value);
    // Editing after a save should re-reveal the Save button immediately rather
    // than keep showing the lingering "Saved" tick.
    if (noteState !== "idle") {
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      setNoteState("idle");
    }
    if (error) setError(null);
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
              onClick={() => void commitStatus(s)}
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
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void saveNote();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              // Revert to the last saved value, then drop focus.
              setMessage(committedMessage);
              if (error) setError(null);
              e.currentTarget.blur();
            }
          }}
          // Backstop: saving on blur means clicking away from the input (or
          // closing the menu, which blurs first) persists the note. saveNote()
          // is a no-op when nothing changed.
          onBlur={() => void saveNote()}
          placeholder="Add a status note (optional)"
          className={cn(
            "h-8 w-full rounded-md border border-border/60 bg-muted/30 px-2.5 text-[12px] outline-none transition-colors",
            "placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:bg-background",
            disabled && "cursor-not-allowed opacity-60",
          )}
        />
        {/* Fixed height so toggling between the char count and the Save button
            never re-lays-out the dropdown. */}
        <div className="mt-1 flex h-6 items-center justify-between gap-2 px-1">
          <span className="text-[10px] tabular-nums text-muted-foreground/60">
            {message.length > 0 ? `${message.length}/100` : ""}
          </span>
          <div className="flex items-center text-[10px]">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : noteState === "saving" ? (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Saving…
              </span>
            ) : noteState === "saved" ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-500">
                <Check className="size-3" />
                Saved
              </span>
            ) : dirty && !disabled ? (
              <button
                type="button"
                onClick={() => void saveNote()}
                className="inline-flex h-6 cursor-pointer items-center rounded-md bg-foreground px-2.5 text-[11px] font-medium text-background outline-none transition-colors hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                Save
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
