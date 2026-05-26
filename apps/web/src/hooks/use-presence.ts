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
      setOnlineUserIds(new Set(payload.onlineUserIds));
    };
    const onAvailabilitySnapshot: Parameters<
      typeof socket.on<"user:availability:snapshot">
    >[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      // Replace wholesale — the snapshot is the authoritative full picture.
      setAvailabilityByUserId(payload.byUserId);
    };
    const onAvailabilityUpdate: Parameters<
      typeof socket.on<"user:availability:updated">
    >[1] = (payload) => {
      if (payload.teamId !== teamId) return;
      setAvailabilityByUserId((prev) => {
        const next = { ...prev };
        // Drop the entry when the new state is the default (available + no
        // note) so the map stays sparse — matches the snapshot rule and keeps
        // consumers' `byUserId[id] ?? default` lookups correct.
        const isDefault =
          payload.status === "available" &&
          (payload.message === null || payload.message === undefined);
        if (isDefault) {
          delete next[payload.userId];
        } else {
          next[payload.userId] = {
            status: payload.status,
            ...(payload.message !== undefined ? { message: payload.message } : {}),
          };
        }
        return next;
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
