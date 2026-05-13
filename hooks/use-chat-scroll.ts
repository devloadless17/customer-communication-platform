"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
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
}: Options) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const stickyRef = useRef(true);
  const settleStopRef = useRef<(() => void) | null>(null);

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
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      stickyRef.current = isAtBottom();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isAtBottom]);

  // Conversation change → hard reset to the bottom of the new thread.
  useLayoutEffect(() => {
    settleStopRef.current?.();
    stickyRef.current = true;
    snapToBottom();
  }, [conversationId, snapToBottom]);

  // Tail-entry change. We only act when the new tail is THIS user's send;
  // the global ResizeObserver below handles every other "content grew"
  // case (inbound, teammate's send, note) gated by stickiness.
  const lastEntryIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastEntryKey === lastEntryIdRef.current) return;
    lastEntryIdRef.current = lastEntryKey;
    if (!isOwnSend) return;
    // Kill any active load-older settle window — its ResizeObserver would
    // otherwise re-pin to the OLD distance-from-bottom and undo this snap.
    settleStopRef.current?.();
    stickyRef.current = true;
    snapToBottom();
  }, [lastEntryKey, isOwnSend, snapToBottom]);

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
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onMediaLoad = (e: Event) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag !== "IMG" && tag !== "VIDEO") return;
      if (stickyRef.current) snapToBottom();
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
}
