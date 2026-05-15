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
}: Options): { unreadBelow: number; scrollToBottom: () => void } {
  const viewportRef = useRef<HTMLElement | null>(null);
  const stickyRef = useRef(true);
  const settleStopRef = useRef<(() => void) | null>(null);
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

  const snapToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
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

  // Conversation change (and initial mount) → hard reset to the bottom of
  // the new thread. Same double-rAF safety net as the own-send snap: the
  // bubble heights, the `scrollReady` re-render that reveals the area, and
  // image aspect-ratio reservations dropping as bytes decode can all land
  // on subsequent frames. Re-snap twice so the bottom is reached regardless
  // of which one finishes last. Also clears any pending unread count from
  // the previous thread — the pill should never linger across navigation.
  useLayoutEffect(() => {
    settleStopRef.current?.();
    stickyRef.current = true;
    setUnreadBelow(0);
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
          const timer = window.setTimeout(stop, 1000);
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

  return { unreadBelow, scrollToBottom };
}
