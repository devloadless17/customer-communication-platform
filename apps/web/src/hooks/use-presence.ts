"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { UserAvailabilityStatus } from "@ccp/shared/types";

export interface TeammateAvailability {
  status: UserAvailabilityStatus;
  message?: string | null;
}

// Module-scoped dedup of the reconnect presence:request. Every usePresence
// instance (inbox sub-sidebar, assignment dropdown, team-channel sidebar, …)
// would otherwise register its own `connect` listener, so a single reconnect
// fires N duplicate presence:request emits — each costing 2 Postgres reads + 2
// redundant snapshot frames server-side, and burning N of the per-socket
// presence-request tokens. The server broadcasts the response to the whole
// socket, so one request seeds every mounted consumer. Refcount a single
// shared connect-listener so N consumers produce exactly one presence:request
// per reconnect. (The per-instance immediate seed below is kept: a consumer
// mounting mid-session must request its own snapshot after its own data
// listeners are attached.)
let presenceConnectRefCount = 0;
let sharedConnectListener: (() => void) | null = null;

function acquireSharedConnectListener(): void {
  presenceConnectRefCount += 1;
  if (sharedConnectListener) return;
  sharedConnectListener = () => {
    getClientSocket().emit("presence:request");
  };
  getClientSocket().on("connect", sharedConnectListener);
}

function releaseSharedConnectListener(): void {
  presenceConnectRefCount -= 1;
  if (presenceConnectRefCount > 0 || !sharedConnectListener) return;
  getClientSocket().off("connect", sharedConnectListener);
  sharedConnectListener = null;
}

/**
 * Realtime online-teammate + availability state for a team.
 *
 * Two orthogonal signals delivered in one hook because every UI surface that
 * paints a teammate dot needs both:
 *   - `onlineUserIds` — users with ≥1 connected socket AND not "Appear
 *     offline". Filtered server-side via `buildVisibleOnlineSnapshot` so the
 *     client never has to second-guess; a user who toggled offline isn't in
 *     this set even though their socket is still up.
 *   - `availabilityByUserId` — per-user status badge (busy / away / etc.) +
 *     optional free-form note. Sparse: a teammate whose row is "available + no
 *     note" is omitted; consumers treat absence as that default.
 *
 * Both seed on socket connect (handshake-time presence:update + a one-shot
 * user:availability:snapshot) and update incrementally via presence:update +
 * user:availability:updated frames. presence:request re-fires both on every
 * reconnect so a long offline doesn't leave stale dots.
 */
export function usePresence(
  teamId: string,
  _userId: string,
): {
  onlineUserIds: Set<string>;
  availabilityByUserId: Record<string, TeammateAvailability>;
} {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set());
  const [availabilityByUserId, setAvailabilityByUserId] = useState<
    Record<string, TeammateAvailability>
  >({});

  useEffect(() => {
    const socket = getClientSocket();

    const onUpdate: Parameters<typeof socket.on<"presence:update">>[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      // Diff before reallocating — a team-wide presence:update fires
      // whenever ANY teammate connects, disconnects, or toggles availability.
      // On a busy team (20+ agents) this can be many events per minute, each
      // historically triggering a fresh Set + identity-change-driven re-render
      // in every consumer (currently 4 separate subtrees: inbox sub-sidebar,
      // contact panel, assignment dropdown, team-channel sidebar). The set
      // membership usually doesn't actually change between events for the
      // viewer; bail when it matches to keep referential identity stable.
      setOnlineUserIds((prev) => {
        if (
          prev.size === payload.onlineUserIds.length &&
          payload.onlineUserIds.every((id) => prev.has(id))
        ) {
          return prev;
        }
        return new Set(payload.onlineUserIds);
      });
    };
    const onAvailabilitySnapshot: Parameters<
      typeof socket.on<"user:availability:snapshot">
    >[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      // Replace wholesale — the snapshot is the authoritative full picture.
      // Diff first so a snapshot identical to current state (common on
      // reconnect) doesn't trigger a wide re-render.
      setAvailabilityByUserId((prev) => {
        const incoming = payload.byUserId;
        const prevKeys = Object.keys(prev);
        const incomingKeys = Object.keys(incoming);
        if (prevKeys.length === incomingKeys.length) {
          let same = true;
          for (const k of incomingKeys) {
            const a = prev[k];
            const b = incoming[k];
            if (
              !a ||
              !b ||
              a.status !== b.status ||
              (a.message ?? null) !== (b.message ?? null)
            ) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return incoming;
      });
    };
    const onAvailabilityUpdate: Parameters<
      typeof socket.on<"user:availability:updated">
    >[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      setAvailabilityByUserId((prev) => {
        const existing = prev[payload.userId];
        // Wire contract: `message === undefined` means UNCHANGED — preserve the
        // teammate's existing note instead of dropping it (mirrors the
        // app-rail / mobile-shell self-avatar consumers). A status-only frame
        // must not silently wipe "brb" off a colleague's badge.
        const nextMessage =
          payload.message === undefined
            ? (existing?.message ?? null)
            : payload.message;
        // Drop the entry when the RESULTING state is the default (available +
        // no note) so the map stays sparse — matches the snapshot rule and
        // keeps consumers' `byUserId[id] ?? default` lookups correct.
        const isDefault = payload.status === "available" && nextMessage === null;
        if (isDefault) {
          if (!(payload.userId in prev)) return prev;
          const next = { ...prev };
          delete next[payload.userId];
          return next;
        }
        const nextEntry: TeammateAvailability = {
          status: payload.status,
          ...(nextMessage !== null ? { message: nextMessage } : {}),
        };
        if (
          existing &&
          existing.status === nextEntry.status &&
          (existing.message ?? null) === (nextEntry.message ?? null)
        ) {
          return prev;
        }
        return { ...prev, [payload.userId]: nextEntry };
      });
    };
    socket.on("presence:update", onUpdate);
    socket.on("user:availability:snapshot", onAvailabilitySnapshot);
    socket.on("user:availability:updated", onAvailabilityUpdate);
    acquireSharedConnectListener();
    // Immediate per-instance seed for a mid-session mount: the shared connect
    // listener won't re-fire while already connected, and this instance's data
    // listeners just attached, so it needs one request to seed itself.
    if (socket.connected) socket.emit("presence:request");

    return () => {
      socket.off("presence:update", onUpdate);
      socket.off("user:availability:snapshot", onAvailabilitySnapshot);
      socket.off("user:availability:updated", onAvailabilityUpdate);
      releaseSharedConnectListener();
    };
  }, [teamId]);

  return { onlineUserIds, availabilityByUserId };
}
