"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { User } from "@ccp/shared/types";

/**
 * WHO IS LOOKING AT WHAT, for the whole workspace, in one place.
 *
 * The whole point of a shared inbox is that two agents don't answer the same
 * customer twice — so "someone else is reading this" has to be visible BEFORE
 * you open the chat, not only after. That means the same signal on two
 * surfaces (the list row and the thread header), which means ONE store: two
 * independent subscriptions would drift the moment one of them missed a frame.
 *
 * Server contract (apps/api/src/realtime/realtime.gateway.ts):
 *   - `conversation:viewers` — a DELTA for one conversation, emitted on the
 *     user-level 0↔1 transition to both the thread room and the workspace room
 *     (`emitViewers`). Multi-tab is one viewer, so a second tab never blinks
 *     the eye on and off.
 *   - `conversation:viewers_snapshot` — the standing state for every
 *     conversation with a viewer, pushed on connect and on `viewers:request`.
 *     Without it a tab that connects mid-shift sees nothing until a teammate
 *     next opens or closes a thread.
 *
 * The local user is filtered out on arrival: the eye means "SOMEONE ELSE is
 * here", and your own presence on a chat you have open is not news.
 *
 * Identity discipline: an entry is replaced only when its viewer ids actually
 * change, so a frame about conversation A leaves conversation B's array
 * referentially identical and B's memoized row bails out of re-rendering.
 */

export interface ConversationViewer {
  id: string;
  /** Display name, or a neutral fallback if the roster hasn't got them yet. */
  name: string;
  avatarUrl: string | null;
}

/** Shared empty array so "no viewers" is one stable reference forever. */
const NO_VIEWERS: ConversationViewer[] = [];

type ViewersMap = ReadonlyMap<string, ConversationViewer[]>;

const ConversationViewersContext = createContext<ViewersMap>(new Map());

function sameIds(current: ConversationViewer[], ids: string[]): boolean {
  return (
    current.length === ids.length && current.every((v, i) => v.id === ids[i])
  );
}

function resolve(
  ids: string[],
  byId: Map<string, User>,
): ConversationViewer[] {
  return ids.map((id) => {
    const u = byId.get(id);
    return {
      id,
      // A viewer missing from the roster (just-invited teammate, roster not yet
      // refetched) still counts — dropping them would under-report a collision,
      // which is the one thing this signal exists to prevent.
      name: u?.name ?? "A teammate",
      avatarUrl: u?.avatarUrl ?? null,
    };
  });
}

export function ConversationViewersProvider({
  workspaceId,
  currentUserId,
  teamMembers,
  children,
}: {
  workspaceId: string;
  currentUserId: string;
  /** Roster used to name viewers. Changes rarely (member add / rename). */
  teamMembers: User[];
  children: ReactNode;
}) {
  const [byConversation, setByConversation] = useState<
    ReadonlyMap<string, ConversationViewer[]>
  >(() => new Map());

  const byId = useMemo(
    () => new Map(teamMembers.map((u) => [u.id, u])),
    [teamMembers],
  );
  // Read inside socket handlers without re-binding them on every roster change
  // (re-binding would drop and re-add listeners, and briefly miss frames).
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  useEffect(() => {
    const socket = getClientSocket();

    const applyOne = (conversationId: string, rawIds: string[]) => {
      const ids = rawIds.filter((id) => id !== currentUserId);
      setByConversation((prev) => {
        const existing = prev.get(conversationId);
        if (ids.length === 0) {
          if (!existing) return prev;
          const next = new Map(prev);
          next.delete(conversationId);
          return next;
        }
        if (existing && sameIds(existing, ids)) return prev;
        const next = new Map(prev);
        next.set(conversationId, resolve(ids, byIdRef.current));
        return next;
      });
    };

    const onViewers: Parameters<typeof socket.on<"conversation:viewers">>[1] = (
      payload,
    ) => {
      applyOne(payload.conversationId, payload.viewerUserIds);
    };

    const onSnapshot: Parameters<
      typeof socket.on<"conversation:viewers_snapshot">
    >[1] = (payload) => {
      if (payload.workspaceId !== workspaceId) return;
      // Authoritative full picture — replace rather than merge, so a
      // conversation whose viewers left while this tab was asleep is dropped.
      setByConversation((prev) => {
        const next = new Map<string, ConversationViewer[]>();
        for (const entry of payload.viewers) {
          const ids = entry.viewerUserIds.filter((id) => id !== currentUserId);
          if (ids.length === 0) continue;
          const existing = prev.get(entry.conversationId);
          next.set(
            entry.conversationId,
            existing && sameIds(existing, ids)
              ? existing
              : resolve(ids, byIdRef.current),
          );
        }
        // A snapshot identical to what we already hold (the common reconnect
        // case) must not hand every row a new array.
        if (next.size === prev.size) {
          let same = true;
          for (const [cid, viewers] of next) {
            if (prev.get(cid) !== viewers) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
    };

    const requestSnapshot = () => {
      socket.emit("viewers:request");
    };

    socket.on("conversation:viewers", onViewers);
    socket.on("conversation:viewers_snapshot", onSnapshot);
    // The connect-time push lands before this listener exists, and a reconnect
    // past the recovery window can have missed any number of deltas — so ask
    // on mount and on every reconnect. Mirrors usePresence's presence:request.
    socket.on("connect", requestSnapshot);
    if (socket.connected) requestSnapshot();

    return () => {
      socket.off("conversation:viewers", onViewers);
      socket.off("conversation:viewers_snapshot", onSnapshot);
      socket.off("connect", requestSnapshot);
    };
  }, [workspaceId, currentUserId]);

  // Re-name viewers when the roster changes (a rename, or a member who wasn't
  // in the roster when their frame arrived). Ids are unchanged, so this is the
  // one path allowed to rebuild entries without a frame.
  useEffect(() => {
    setByConversation((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map<string, ConversationViewer[]>();
      for (const [cid, viewers] of prev) {
        const resolved = resolve(
          viewers.map((v) => v.id),
          byId,
        );
        const same = resolved.every(
          (v, i) =>
            v.name === viewers[i]!.name && v.avatarUrl === viewers[i]!.avatarUrl,
        );
        if (same) {
          next.set(cid, viewers);
        } else {
          next.set(cid, resolved);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [byId]);

  return (
    <ConversationViewersContext.Provider value={byConversation}>
      {children}
    </ConversationViewersContext.Provider>
  );
}

/** The whole map — for the inbox list, which paints one eye per row. */
export function useConversationViewersMap(): ViewersMap {
  return useContext(ConversationViewersContext);
}

/** Other teammates viewing ONE conversation. Stable reference when unchanged. */
export function useConversationViewers(
  conversationId: string,
): ConversationViewer[] {
  return useContext(ConversationViewersContext).get(conversationId) ?? NO_VIEWERS;
}
