"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { getClientSocket } from "@/lib/socket-client";
import {
  notificationSound,
  type SoundCategory,
  type SoundPrefs,
} from "@/lib/notifications/notification-sound";

/**
 * Wires the (framework-agnostic) notification-sound engine into React:
 *   1. seeds prefs from localStorage and re-syncs across tabs (`storage`);
 *   2. unlocks audio on the first user gesture (browser autoplay policy);
 *   3. subscribes to `message:new` APP-WIDE so a new inbound message dings on
 *      every page — not just the inbox — deduped against connection-state-
 *      recovery replays and suppressed for the thread you're actively viewing;
 *   4. exposes prefs + a preview to the settings UI (the user-menu picker).
 *
 * The call RING is NOT driven here — it lives in the inbox IncomingCallToast,
 * the only place an agent can actually answer. A ring implies an Answer button;
 * a message ding is fire-and-forget. See the approved plan.
 *
 * Mounted once in the authenticated shell ((app)/layout.tsx), wrapping AppRail
 * so the picker can read this context.
 */

interface NotificationSoundContextValue {
  prefs: SoundPrefs;
  setPref: (category: SoundCategory, enabled: boolean) => void;
  /** Play a one-shot sample (used by the picker when a category is enabled). */
  preview: (category: SoundCategory) => void;
}

const NotificationSoundContext = createContext<NotificationSoundContextValue | null>(null);

export function useNotificationSounds(): NotificationSoundContextValue {
  const ctx = useContext(NotificationSoundContext);
  if (!ctx) {
    throw new Error("useNotificationSounds must be used within NotificationSoundProvider");
  }
  return ctx;
}

/** Bounded dedupe of message ids we've already dinged for. */
const DEDUP_CAP = 200;

export function NotificationSoundProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<SoundPrefs>(() => notificationSound.getPrefs());

  // Bounded FIFO set so Socket.io connection-state-recovery replays of a
  // `message:new` don't re-ding the same message.
  const seenRef = useRef<{ set: Set<string>; queue: string[] }>({
    set: new Set(),
    queue: [],
  });

  // Seed from localStorage on mount (client-only value).
  useEffect(() => {
    setPrefs(notificationSound.loadPrefs());
  }, []);

  // Unlock audio on the first user gesture anywhere in the app. `once` removes
  // the listeners after the first fire; capture so we see it even if something
  // stops propagation.
  useEffect(() => {
    const unlock = () => notificationSound.unlock();
    const opts: AddEventListenerOptions = { once: true, capture: true };
    window.addEventListener("pointerdown", unlock, opts);
    window.addEventListener("keydown", unlock, opts);
    return () => {
      window.removeEventListener("pointerdown", unlock, opts);
      window.removeEventListener("keydown", unlock, opts);
    };
  }, []);

  // App-wide new-message ding.
  useEffect(() => {
    const socket = getClientSocket();
    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (payload) => {
      // Only inbound customer messages — never the agent's own or a teammate's
      // outbound send.
      if (payload.message.direction !== "in") return;

      const id = payload.message.id || `${payload.conversationId}:${payload.lastMessageAt}`;
      const seen = seenRef.current;
      if (seen.set.has(id)) return;
      seen.set.add(id);
      seen.queue.push(id);
      if (seen.queue.length > DEDUP_CAP) {
        const evicted = seen.queue.shift();
        if (evicted !== undefined) seen.set.delete(evicted);
      }

      // Suppress for the conversation you're already looking at in a focused
      // tab — you can see it land. A hidden tab always dings (you're not
      // looking), and any other conversation always dings.
      const visible =
        typeof document === "undefined" || document.visibilityState === "visible";
      if (visible && notificationSound.getActiveThread() === payload.conversationId) {
        return;
      }

      notificationSound.playMessageTone();
    };
    socket.on("message:new", onMessageNew);
    return () => {
      socket.off("message:new", onMessageNew);
    };
  }, []);

  // Cross-tab pref sync: a toggle in another tab fires a `storage` event here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // key === null on storage.clear(); otherwise only react to our key.
      if (e.key !== null && e.key !== "ccp.sound.prefs") return;
      setPrefs(notificationSound.reloadPrefs());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Kill any ring if the shell unmounts (e.g. sign-out).
  useEffect(() => {
    return () => notificationSound.stopAllCallRings();
  }, []);

  const setPref = useCallback((category: SoundCategory, enabled: boolean) => {
    setPrefs(notificationSound.setPrefs({ [category]: enabled }));
  }, []);

  const preview = useCallback((category: SoundCategory) => {
    // Toggling is itself a user gesture, so unlock here too (covers the case
    // where this is the very first interaction).
    notificationSound.unlock();
    if (category === "messages") notificationSound.previewMessage();
    else notificationSound.playCallSample();
  }, []);

  return (
    <NotificationSoundContext.Provider value={{ prefs, setPref, preview }}>
      {children}
    </NotificationSoundContext.Provider>
  );
}
