"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { UserAvailabilityStatus } from "@ccp/shared/types";

export interface TeammateAvailability {
  status: UserAvailabilityStatus;
  message?: string | null;
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
        // Drop the entry when the new state is the default (available + no
        // note) so the map stays sparse — matches the snapshot rule and keeps
        // consumers' `byUserId[id] ?? default` lookups correct.
        const isDefault =
          payload.status === "available" &&
          (payload.message === null || payload.message === undefined);
        if (isDefault) {
          if (!(payload.userId in prev)) return prev;
          const next = { ...prev };
          delete next[payload.userId];
          return next;
        }
        const existing = prev[payload.userId];
        const nextEntry: TeammateAvailability = {
          status: payload.status,
          ...(payload.message !== undefined ? { message: payload.message } : {}),
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
    const requestSnapshot = (): void => {
      socket.emit("presence:request");
    };

    socket.on("presence:update", onUpdate);
    socket.on("user:availability:snapshot", onAvailabilitySnapshot);
    socket.on("user:availability:updated", onAvailabilityUpdate);
    socket.on("connect", requestSnapshot);
    if (socket.connected) requestSnapshot();

    return () => {
      socket.off("presence:update", onUpdate);
      socket.off("user:availability:snapshot", onAvailabilitySnapshot);
      socket.off("user:availability:updated", onAvailabilityUpdate);
      socket.off("connect", requestSnapshot);
    };
  }, [teamId]);

  return { onlineUserIds, availabilityByUserId };
}
