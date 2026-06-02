"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

interface Options {
  /**
   * Direct ref to the scrolling viewport (the Radix ScrollArea inner
   * `[data-radix-scroll-area-viewport]` element). Pass via the new
   * `ScrollArea` `viewportRef` prop. Replaced the previous
   * `scrollAreaRef + querySelector` indirection so the hook reads scroll
   * state synchronously on the first render after the viewport mounts,
   * with no useLayoutEffect round-trip.
   */
  viewportRef: RefObject<HTMLElement | null>;
  /** The scrollable content wrapper — what the ResizeObserver watches. */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Sentinel above the first message; the "load older" trigger. */
  topSentinelRef: RefObject<HTMLDivElement | null>;
  /** Changing this id resets stick-to-bottom and snaps the viewport down. */
  conversationId: string;
  /**
   * A stable key for the most-recent timeline entry. `null` when empty.
   * The hook diff-checks this to detect new-tail events.
   */
  lastEntryKey: string | null;
  /**
   * True when the new tail entry was produced by THIS user's own send
   * (optimistic, locally added). The hook always snaps to the bottom in
   * that case — intent is unambiguous regardless of scroll position.
   */
  isOwnSend: boolean;
  /**
   * True when the new tail entry is an activity-log pill (assignment,
   * status, stage, tag, note-delete) rather than a real message or note.
   * Activity pills are passive context — bumping the "↓ N new messages"
   * pill on them is misleading ("1 new message" but it's actually
   * "Ali assigned to elena"). When true, skip the unread bump AND the
   * snap, so a user scrolled up reading history is undisturbed.
   */
  isActivityTail: boolean;
  /** Whether older history exists to be fetched on top-sentinel entry. */
  hasMoreOlder: boolean;
  /** Fetch + prepend the next older page. Hook wraps the commit in flushSync. */
  loadOlder: (commit: (run: () => void) => void) => Promise<number>;
}

/**
 * Drives a chat thread's scroll behavior the way users expect from any
 * mature chat product (WhatsApp, Slack, iMessage):
 *
 *   - Open a thread → land at the bottom.
 *   - Stuck at the bottom + new content → glide-pin to the bottom.
 *   - Scrolled up reading history + new content → stay put.
 *   - Send a message → snap to the bottom regardless of scroll position.
 *   - Scroll near the top → load older with zero visual shift; pin through
 *     media decode-in for ~1s or until the user scrolls.
 *
 * Strategy: one boolean — "is the user stuck to the bottom?" — is the
 * source of truth. A scroll listener keeps it current. A single
 * ResizeObserver consults it on every content reflow (new bubble,
 * framer-motion entrance, image decode) and pulls the viewport along when
 * true. Special events (conversation change, own send) flip the boolean
 * back to true and snap once; the observer does the rest.
 */
export function useChatScroll({
  viewportRef,
  contentRef,
  topSentinelRef,
  conversationId,
  lastEntryKey,
  isOwnSend,
  isActivityTail,
  hasMoreOlder,
  loadOlder,
}: Options): {
  unreadBelow: number;
  scrollToBottom: () => void;
  markBenignTailUpdate: () => void;
  releaseStickToBottom: () => void;
} {
  const stickyRef = useRef(true);
  const settleStopRef = useRef<(() => void) | null>(null);
  // Set by the consumer before a `lastEntryKey` shift that isn't a real
  // "new message" event (e.g. search-jump replaces the loaded slice with a
  // context window centered on an older match — the new tail is older, but
  // it's not new content). Consumed once by the tail-entry effect to skip
  // the pill bump + the snap.
  const skipNextTailEffectRef = useRef(false);
  // Counter of new tail entries that arrived while the user was scrolled
  // up reading history. Drives the "↓ N new messages" pill — UX pattern
  // borrowed from WhatsApp / Slack / Discord. Clears on conversation
  // change, on own-send (we snapped anyway), and when the user scrolls
  // back to the bottom naturally.
  const [unreadBelow, setUnreadBelow] = useState(0);

  const isAtBottom = useCallback((slack = 80) => {
    const el = viewportRef.current;
    if (!el) return true;
    // column-reverse: scrollTop 0 = the bottom (newest); scrolling up toward
    // older goes NEGATIVE (down to -(scrollHeight-clientHeight)). "At bottom"
    // is therefore within `slack` px of 0. (Measured: positive scrollTop is
    // clamped to 0 in a column-reverse box.)
    return el.scrollTop >= -slack;
  }, [viewportRef]);

  // Timestamp of the most recent programmatic snap. Setting scrollTop in JS
  // fires a scroll event ASYNCHRONOUSLY (queued by the browser to the next
  // frame). Between the snap and the event firing, content can grow
  // (image decode, font swap, framer-motion entrance), which shifts
  // scrollHeight upward without moving our scrollTop — so when the queued
  // event finally fires, isAtBottom() reads "drifted from the bottom" and
  // the listener mistakenly concludes the user scrolled, sets stickyRef=
  // false, and saves the (wrong) scroll position to scrollMemory.
  //
  // Next time the user opens that chat, recallScroll returns the saved
  // position instead of snapping to the bottom — manifests as "chat-to-chat
  // switch doesn't land at the bottom anymore." Ignore scroll events
  // within a short window after every snap so this content-growth race
  // can't poison the stickiness state.
  const lastProgrammaticSnapAtRef = useRef(0);

  const snapToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    lastProgrammaticSnapAtRef.current = Date.now();
    // column-reverse: the bottom (newest) is scrollTop 0, NOT scrollHeight.
    el.scrollTop = 0;
  }, [viewportRef]);

  // Scroll listener — the single arbiter of `stickyRef`. Every other piece
  // of behavior reads from this boolean. Writing it here also means the
  // pin-after-pin re-entry from ResizeObserver's own scrollTop write is
  // self-consistent: after the write we're at the bottom, so we stay sticky.
  // Also clears the unread-below counter on the false→true transition: the
  // user has caught up to the bottom on their own, no need to keep the pill.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      // Ignore scroll events that are echoes of a programmatic snap we
      // just performed. 200ms catches the queued event(s) from the snap
      // + the rAF re-snap chain in the conversationId / tail-entry
      // effects, plus any extra queue produced by ResizeObserver's
      // re-snap on image decode. Real user scrolls happen on a much
      // longer timescale.
      if (Date.now() - lastProgrammaticSnapAtRef.current < 200) return;
      const wasSticky = stickyRef.current;
      const isSticky = isAtBottom();
      stickyRef.current = isSticky;
      if (!wasSticky && isSticky) {
        setUnreadBelow(0);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isAtBottom, viewportRef]);

  // Conversation change (and initial mount) → always snap to the bottom.
  // Matches WhatsApp Web behavior: every chat open lands at the latest
  // message. We previously had a per-chat scroll-position memory (resume
  // where the user left off, Telegram-style), but it produced surprising
  // results in practice — content growth from image-decode or font-swap
  // could poison the saved position with a not-quite-bottom value, and the
  // user would land mid-thread on subsequent visits. Pure snap-to-bottom is
  // both the expected UX and structurally simpler.
  //
  // Double-rAF safety net: bubble heights, image aspect-ratio reservations,
  // and framer-motion entrance reflow can all land on subsequent frames.
  // Re-snap twice so the bottom is reached regardless of which finishes
  // last. Each re-snap is gated by stickyRef so a user who scrolled away
  // within the window isn't yanked back.
  useLayoutEffect(() => {
    settleStopRef.current?.();
    setUnreadBelow(0);
    stickyRef.current = true;
    // column-reverse anchors at the bottom natively on first layout, so a hard
    // refresh needs no JS snap. This snap still matters on a CLIENT chat-switch:
    // the viewport is reused, so its scrollTop carries over from the previous
    // thread and must be reset to 0 (bottom) for the newly-displayed thread.
    snapToBottom();
    requestAnimationFrame(() => {
      if (stickyRef.current) snapToBottom();
      requestAnimationFrame(() => {
        if (stickyRef.current) snapToBottom();
      });
    });
  }, [conversationId, snapToBottom, viewportRef]);

  // Tail-entry change. Three cases:
  //   - Own send: always snap and force sticky=true. The user's intent
  //     is unambiguous — they expect to see what they just sent. Clears
  //     any unread-below count from inbound that landed while typing.
  //   - Inbound / teammate / note while sticky: snap, keep sticky.
  //   - Inbound / teammate / note while NOT sticky: don't snap. Increment
  //     the unread-below counter so the floating pill can offer a one-click
  //     jump-to-latest. WhatsApp / Slack / Discord pattern.
  const lastEntryIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastEntryKey === lastEntryIdRef.current) return;
    const isFirstObservation = lastEntryIdRef.current === null;
    lastEntryIdRef.current = lastEntryKey;
    // First observation per mount is the initial render snapshot, not a
    // "new message" — skip the unread bump that would otherwise show the
    // pill the moment a thread loads.
    if (isFirstObservation) return;
    // Consumer flagged this transition as a benign slice swap (search-jump
    // context window). Advance lastEntryIdRef so subsequent real events
    // diff against the new value, but do NOT bump the pill or snap.
    if (skipNextTailEffectRef.current) {
      skipNextTailEffectRef.current = false;
      return;
    }
    // Activity-log pills (assignment / status / stage / tag / note-delete)
    // are passive context — they must never trigger the "↓ N new messages"
    // pill or yank a reader who's scrolled up. If the user is reading history
    // when an assignment lands, the pill quietly slots into the timeline and
    // the scroll stays put.
    //
    // BUT when the user is already pinned to the bottom, we must snap HERE —
    // in the layout effect, BEFORE paint — exactly like a message. Delegating
    // to the post-paint ResizeObserver (the old behavior) painted the pill one
    // frame at the stale scroll position and scrolled it into view a frame
    // later, which the user reads as the pill "jumping in from below / out of
    // order." A pre-paint snap makes it simply appear at the bottom with zero
    // travel. We still skip the unread bump unconditionally — a log is never
    // "1 new message."
    if (isActivityTail) {
      if (stickyRef.current) {
        snapToBottom();
        requestAnimationFrame(() => {
          if (stickyRef.current) snapToBottom();
          requestAnimationFrame(() => {
            if (stickyRef.current) snapToBottom();
          });
        });
      }
      return;
    }
    if (isOwnSend) {
      // Kill any active load-older settle window — its ResizeObserver would
      // otherwise re-pin to the OLD distance-from-bottom and undo this snap.
      settleStopRef.current?.();
      stickyRef.current = true;
      setUnreadBelow(0);
    } else if (!stickyRef.current) {
      // Reading history → just bump the pill count, do not yank the view.
      setUnreadBelow((n) => n + 1);
      return;
    }
    snapToBottom();
    requestAnimationFrame(() => {
      if (stickyRef.current) snapToBottom();
      requestAnimationFrame(() => {
        if (stickyRef.current) snapToBottom();
      });
    });
  }, [lastEntryKey, isOwnSend, isActivityTail, snapToBottom]);

  // Action exposed to the pill: clicking it jumps to bottom and clears
  // the unread count. Forces sticky=true so subsequent inbound messages
  // resume keeping the view pinned.
  const scrollToBottom = useCallback(() => {
    settleStopRef.current?.();
    stickyRef.current = true;
    setUnreadBelow(0);
    snapToBottom();
    requestAnimationFrame(() => {
      if (stickyRef.current) snapToBottom();
    });
  }, [snapToBottom]);

  // The one ResizeObserver. Any content reflow while sticky → snap. Covers
  // new bubbles mounting, framer-motion entrance reflow, image/video
  // decode-in. When the user is reading history (sticky=false), it's a
  // no-op and the user is undisturbed.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stickyRef.current) snapToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, snapToBottom]);

  // Media decode-in safety net. The ResizeObserver above usually catches
  // the bubble growing when its <img>/<video> finishes loading, but the
  // timing isn't guaranteed across browsers — the image's intrinsic-size
  // reflow can land after a paint, leaving the bubble half-clipped. Listening
  // for `load` events in capture (they don't bubble) gives us a deterministic
  // re-snap the instant the media is ready. Same sticky gate, so reading
  // history is undisturbed.
  //
  // Double-rAF before the snap: in Chromium and Safari, `load` fires before
  // the post-load reflow that resizes the bubble — measuring scrollHeight in
  // the same tick yields the pre-grow value, so the snap lands mid-image and
  // the bubble's meta-row sits below the fold ("image cut in half"). Yielding
  // two frames guarantees layout has settled on the new dimensions.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onMediaLoad = (e: Event) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag !== "IMG" && tag !== "VIDEO") return;
      if (!stickyRef.current) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (stickyRef.current) snapToBottom();
        });
      });
    };
    content.addEventListener("load", onMediaLoad, true);
    content.addEventListener("loadedmetadata", onMediaLoad, true);
    return () => {
      content.removeEventListener("load", onMediaLoad, true);
      content.removeEventListener("loadedmetadata", onMediaLoad, true);
    };
  }, [contentRef, snapToBottom]);

  // Stuck settle window survives unmount-cleanup.
  useEffect(() => () => settleStopRef.current?.(), []);

  // Load older. Prepend in flushSync between a scrollHeight read and a
  // scrollTop write — same tick, no paint of the shifted state. A short
  // settle window re-pins the same anchor as just-prepended media decodes;
  // it bails on the first user-initiated wheel/touch or after 1s.
  const inFlightRef = useRef(false);
  useEffect(() => {
    if (!hasMoreOlder) return;
    const sentinel = topSentinelRef.current;
    const root = viewportRef.current;
    if (!sentinel || !root) return;

    const obs = new IntersectionObserver(
      (entries) => {
        if (inFlightRef.current) return;
        if (!entries.some((e) => e.isIntersecting)) return;
        inFlightRef.current = true;

        void loadOlder((run) => {
          // column-reverse: distance from the bottom (newest) is simply
          // -scrollTop (0 at bottom, growing negative as you scroll up). Older
          // pages are appended at the DOM END (visual top), which a column-
          // reverse box keeps from shifting the current view — so this pin is
          // effectively a no-op, kept only to re-assert position if a late
          // reflow (image decode of the just-loaded older media) nudges it.
          const distanceFromBottom = -root.scrollTop;
          flushSync(run);
          const pin = () => {
            root.scrollTop = -distanceFromBottom;
          };
          pin();

          settleStopRef.current?.();
          let done = false;
          const stop = () => {
            if (done) return;
            done = true;
            ro.disconnect();
            root.removeEventListener("wheel", stop);
            root.removeEventListener("touchmove", stop);
            window.clearTimeout(timer);
            if (settleStopRef.current === stop) settleStopRef.current = null;
          };
          const ro = new ResizeObserver(() => {
            if (!done) pin();
          });
          if (contentRef.current) ro.observe(contentRef.current);
          root.addEventListener("wheel", stop, { passive: true });
          root.addEventListener("touchmove", stop, { passive: true });
          // Settle window length adapts to connection quality. On 3G, image
          // decode can outlast a 1s window — the user scrolls up, history
          // loads, then 1s later the viewport jumps because a late image
          // decode shifted the layout after we stopped pinning. The Network
          // Information API isn't supported on Safari but degrades cleanly
          // to the 4G default. Slow-2g / 2g get the full 3s budget.
          const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
          const eff = conn?.effectiveType ?? "4g";
          const settleMs =
            eff === "slow-2g" || eff === "2g" ? 3_000 : eff === "3g" ? 2_000 : 1_000;
          const timer = window.setTimeout(stop, settleMs);
          settleStopRef.current = stop;
        }).finally(() => {
          inFlightRef.current = false;
        });
      },
      { root, rootMargin: "300px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMoreOlder, loadOlder, contentRef, topSentinelRef, viewportRef]);

  const markBenignTailUpdate = useCallback(() => {
    skipNextTailEffectRef.current = true;
  }, []);

  // Hand scroll control off to a caller doing its own targeted scroll (e.g.
  // the in-thread search jumping to a match). Drops sticky so the
  // ResizeObserver + media-load handlers above don't fire `snapToBottom`
  // mid-animation and fight the caller's `scrollIntoView`. Also stops any
  // in-flight load-older settle window for the same reason. Sticky re-arms
  // naturally the next time the user scrolls back to the bottom (the scroll
  // listener flips it on the false→true transition).
  const releaseStickToBottom = useCallback(() => {
    settleStopRef.current?.();
    stickyRef.current = false;
  }, []);

  return { unreadBelow, scrollToBottom, markBenignTailUpdate, releaseStickToBottom };
}
