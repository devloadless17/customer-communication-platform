"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { cn } from "@ccp/shared/utils";
import {
  ALL_AVAILABILITY_STATUSES,
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
} from "@ccp/shared/presence";
import type { User, UserAvailabilityStatus } from "@ccp/shared/types";
import type { AvailabilitySource } from "@ccp/shared/work-hours";

/**
 * Availability picker rendered inside the AppRail user menu.
 *
 * Three concerns:
 *   1. Seed the displayed status + note from the LIVE availability the AppRail
 *      tracks (`seedStatus` / `seedMessage`), NOT the frozen session
 *      `currentUser`. The dropdown unmounts this picker on close, so it re-seeds
 *      on every reopen — seeding from `currentUser` (which never updates after a
 *      PATCH) showed the pre-save value until a full refresh. The AppRail's live
 *      mirror is updated by this picker's own local dispatch + cross-device
 *      frames, so it's always the freshest known value.
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
  seedStatus,
  seedMessage,
  seedSource,
  seedUntil,
}: {
  currentUser: User;
  disabled: boolean;
  /** Live status/note from the AppRail mirror — survives a menu reopen because
   *  it reflects the last saved value, unlike the frozen session `currentUser`. */
  seedStatus: UserAvailabilityStatus;
  seedMessage: string | null;
  /** Who decided the current status — drives the schedule context line. */
  seedSource?: AvailabilitySource;
  /** ISO instant a manual pick hands back to the schedule. */
  seedUntil?: string | null;
}) {
  const initialMessage = seedMessage ?? "";
  const [status, setStatus] = useState<UserAvailabilityStatus>(seedStatus);
  // Schedule context. `source` tells the user WHY they look the way they do —
  // an unexplained grey dot after a shift ends is the confusing part, not the
  // dot itself.
  const [source, setSource] = useState<AvailabilitySource>(seedSource ?? "manual");
  const [until, setUntil] = useState<string | null>(seedUntil ?? null);
  const [resetting, setResetting] = useState(false);
  // The EFFECTIVE note (what teammates see) — distinct from `message` below,
  // which is the user's own pick. While off shift these differ: teammates see
  // "Outside working hours · back Mon 09:00", the user still owns "back at 3pm".
  const [effectiveMessage, setEffectiveMessage] = useState<string | null>(seedMessage);
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
  const statusRef = useRef(status);
  const savingRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  messageRef.current = message;
  committedRef.current = committedMessage;
  disabledRef.current = disabled;
  statusRef.current = status;

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
      if (payload.source !== undefined) setSource(payload.source);
      if (payload.until !== undefined) setUntil(payload.until);
      if (payload.message !== undefined) setEffectiveMessage(payload.message);
      // The NOTE INPUT tracks the manual pair, never the effective one: the
      // top-level message is what teammates see, so an off-shift frame would
      // otherwise drop "Outside working hours · back Mon 09:00" into this
      // user's own note box — and the next save would persist the schedule's
      // text as their personal note.
      //
      // The selected STATUS stays effective (set above) so the picker always
      // agrees with the dot everyone else is looking at; the context line
      // underneath explains when that isn't what they picked.
      if (payload.manual) {
        const incoming = payload.manual.message ?? "";
        setMessage((curr) => (curr === committedRef.current ? incoming : curr));
        setCommittedMessage(incoming);
        committedRef.current = incoming;
        return;
      }
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
        // Fan the flushed note locally too — otherwise a close-without-explicit-
        // save persists server-side but the AppRail mirror (and the next menu
        // reopen's seed) stays stale until a refresh. Optimistic: the PATCH is
        // fire-and-forget here because the component is unmounting.
        dispatchLocalSocketEvent("user:availability:updated", {
          teamId: currentUser.teamId,
          userId: currentUser.id,
          status: statusRef.current,
          message: latest === "" ? null : latest,
        });
        void apiFetch("/api/users/me/availability", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: latest === "" ? null : latest }),
        }).catch(() => {});
      }
    };
    // currentUser.id / .teamId are stable for the session, so this effectively
    // runs the flush only on unmount; listing them keeps exhaustive-deps honest.
  }, [currentUser.id, currentUser.teamId]);

  // Set the live input + committed baseline + their refs together. Used by the
  // "going available clears the note" path so the displayed value, the dirty
  // check, AND the unmount-flush refs all move in lockstep.
  function setNoteValue(value: string): void {
    setMessage(value);
    setCommittedMessage(value);
    messageRef.current = value;
    committedRef.current = value;
  }

  async function commitStatus(next: UserAvailabilityStatus): Promise<void> {
    if (disabled || next === status) return;
    setError(null);
    const prev = status;
    // A status note is context for being unavailable; coming back to "available"
    // drops it ("I was eating, now I'm back"). Clear it locally too so (a) the
    // input empties instantly, and (b) the unmount-flush can't re-save the old
    // note when the menu closes. `prevNote` restores it if the PATCH fails.
    const clearsNote = next === "available";
    const prevNote = committedRef.current;
    if (clearsNote && savedTimerRef.current !== null) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    // Optimistic local state + dispatch — sidebar, viewer pill, user menu all
    // flip in the same frame as the click. Server fanout lands moments later
    // with the same payload; reducers' identity-bail keeps the echo invisible.
    setStatus(next);
    if (clearsNote) {
      setNoteState("idle");
      setNoteValue("");
    }
    dispatchLocalSocketEvent("user:availability:updated", {
      teamId: currentUser.teamId,
      userId: currentUser.id,
      status: next,
      // null = "cleared" (drop the note everywhere); undefined = "unchanged".
      message: clearsNote ? null : undefined,
    });
    const rollback = () => {
      setStatus(prev);
      if (clearsNote) setNoteValue(prevNote);
      dispatchLocalSocketEvent("user:availability:updated", {
        teamId: currentUser.teamId,
        userId: currentUser.id,
        status: prev,
        message: clearsNote ? (prevNote === "" ? null : prevNote) : undefined,
      });
    };
    try {
      const res = await apiFetch("/api/users/me/availability", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Send message:null on the available switch so the server clears it even
        // if its own rule ever changes — belt and suspenders, single intent.
        body: JSON.stringify(clearsNote ? { status: next, message: null } : { status: next }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        setError(res.status === 403 ? "Not allowed" : detail || "Couldn't update");
        rollback();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      rollback();
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

  /**
   * "Follow my schedule" — drop the override so working hours take over right
   * now instead of at the next boundary. Not optimistic: the resulting status
   * depends on whether the schedule is currently open, which only the server
   * knows, and guessing wrong would flash the wrong dot to the whole team.
   */
  async function followSchedule(): Promise<void> {
    if (disabled || resetting) return;
    setResetting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/users/me/availability", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ followSchedule: true }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        setError(res.status === 403 ? "Not allowed" : detail || "Couldn't reset");
      }
      // On success the server's own `user:availability:updated` frame lands and
      // the subscriber above syncs status/source/until — no local guess needed.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setResetting(false);
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
      <div className="px-2 pb-1.5 pt-0.5 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                // Re-key the active dot on the selected status so it remounts
                // and replays the one-shot spring-pop — a brief, reduced-motion-
                // safe "registered" cue on each pick. Inactive dots share a
                // stable key so they don't animate on unrelated selections.
                key={active ? `active-${status}` : s}
                className={cn(
                  "size-2.5 shrink-0 rounded-full ring-2 ring-background transition-shadow",
                  AVAILABILITY_DOT_CLASSES[s],
                  active && "ring-accent/80 animate-badge-pop",
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
      {/* Schedule context — only rendered once working hours actually apply, so
          a team that never configured them sees the picker exactly as before. */}
      {(source === "schedule" || source === "admin" || until) && (
        <div className="mt-1.5 flex items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5">
          <span className="text-3xs leading-snug text-muted-foreground">
            {source === "schedule"
              ? status === "available"
                ? "Following your working hours"
                : (effectiveMessage ?? "Outside working hours")
              : source === "admin"
                ? "Set by an admin"
                : null}
            {until && (
              <>
                {source === "admin" || source === "manual" ? " · until " : " · "}
                <LocalTime iso={until} format="messageTime" />
              </>
            )}
          </span>
          {until && !disabled && (
            <button
              type="button"
              onClick={() => void followSchedule()}
              disabled={resetting}
              className="shrink-0 cursor-pointer text-3xs font-medium text-foreground/80 underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-60"
            >
              {resetting ? "Resetting…" : "Follow schedule"}
            </button>
          )}
        </div>
      )}
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
            "h-8 w-full rounded-md border border-border/60 bg-muted/30 px-2.5 text-xs outline-none transition-colors",
            "placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:bg-background",
            disabled && "cursor-not-allowed opacity-60",
          )}
        />
        {/* Fixed height so toggling between the char count and the Save button
            never re-lays-out the dropdown. */}
        <div className="mt-1 flex h-6 items-center justify-between gap-2 px-1">
          <span className="text-3xs tabular-nums text-muted-foreground/60">
            {message.length > 0 ? `${message.length}/100` : ""}
          </span>
          <div className="flex items-center text-3xs">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : noteState === "saving" ? (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Saving…
              </span>
            ) : noteState === "saved" ? (
              <span className="flex items-center gap-1 text-success-fg">
                <Check className="size-3" />
                Saved
              </span>
            ) : dirty && !disabled ? (
              <button
                type="button"
                onClick={() => void saveNote()}
                className="inline-flex h-6 cursor-pointer items-center rounded-md bg-foreground px-2.5 text-2xs font-medium text-background outline-none transition-colors hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring"
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
