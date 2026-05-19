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
  /** The Radix `ScrollArea` container. We resolve its inner viewport from it. */
  scrollAreaRef: RefObject<HTMLDivElement | null>;
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
  scrollAreaRef,
  contentRef,
  topSentinelRef,
  conversationId,
  lastEntryKey,
  isOwnSend,
  hasMoreOlder,
  loadOlder,
}: Options): {
  unreadBelow: number;
  scrollToBottom: () => void;
  markBenignTailUpdate: () => void;
} {
  const viewportRef = useRef<HTMLElement | null>(null);
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

  // Resolve Radix's viewport once. Querying its data attribute is more
  // reliable than walking up by `overflow` — Radix keeps the viewport's
  // overflow `hidden` until content actually exceeds the container.
  useLayoutEffect(() => {
    viewportRef.current =
      scrollAreaRef.current?.querySelector<HTMLElement>(
        "[data-radix-scroll-area-viewport]",
      ) ?? null;
  }, [scrollAreaRef]);

  const isAtBottom = useCallback((slack = 80) => {
    const el = viewportRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  }, []);

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
    el.scrollTop = el.scrollHeight;
  }, []);

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
  }, [isAtBottom]);

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
    snapToBottom();
    requestAnimationFrame(() => {
      if (stickyRef.current) snapToBottom();
      requestAnimationFrame(() => {
        if (stickyRef.current) snapToBottom();
      });
    });
  }, [conversationId, snapToBottom]);

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
  }, [lastEntryKey, isOwnSend, snapToBottom]);

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
          const distanceFromBottom = root.scrollHeight - root.scrollTop;
          flushSync(run);
          const pin = () => {
            root.scrollTop = root.scrollHeight - distanceFromBottom;
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
  }, [hasMoreOlder, loadOlder, contentRef, topSentinelRef]);

  const markBenignTailUpdate = useCallback(() => {
    skipNextTailEffectRef.current = true;
  }, []);

  return { unreadBelow, scrollToBottom, markBenignTailUpdate };
}
