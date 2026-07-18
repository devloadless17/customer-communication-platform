"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";
import { notificationSound } from "@/lib/notifications/notification-sound";
import { toast } from "@/lib/toast";

/**
 * App-wide alerts for team chat: an @-mention or a DM should reach you on any
 * page, not just /team.
 *
 * Null-rendering — mounted beside NotificationSoundProvider in the (app)
 * layout, modelled on it (same bounded-dedupe and visible-and-on-surface
 * suppression rules).
 *
 * IMPORTANT — the toast carries NO message preview, by design.
 * `team:channel:activity` deliberately omits the message body because it fans
 * out to the TEAM room, which includes people who aren't members of the
 * channel the message was posted in. Putting a preview in this toast would
 * mean putting the body on that frame, which would leak private-channel
 * content to non-members. This looks like an oversight; it isn't. Don't
 * "improve" it by enriching the payload.
 */

/** Bounded FIFO of message ids already alerted on, so a Socket.io
 *  connection-state-recovery replay can't re-toast the same mention. */
const DEDUP_CAP = 200;

/**
 * DMs this tab just opened itself. `team:dm:created` fans to BOTH participants
 * and carries no author, so this is how the starter avoids being notified
 * about their own action. Entries expire — the frame arrives within ms.
 */
const recentlyOpenedDmIds = new Set<string>();
export function markDmOpenedLocally(channelId: string): void {
  recentlyOpenedDmIds.add(channelId);
  setTimeout(() => recentlyOpenedDmIds.delete(channelId), 15_000);
}

export function TeamChatNotificationsProvider({
  currentUserId,
  dmChannelIds,
}: {
  currentUserId: string;
  /**
   * Channel ids that are DMs for this viewer. A DM is inherently addressed to
   * you, so ANY message in one alerts — there's no @-mention to wait for.
   * Seeded server-side and kept live by the /team layout; empty elsewhere,
   * which only costs a missed DM ding until the first visit to /team.
   */
  dmChannelIds: ReadonlySet<string>;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // Refs so the socket effect binds once and still reads current values.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const dmIdsRef = useRef(dmChannelIds);
  dmIdsRef.current = dmChannelIds;

  const seenRef = useRef<{ set: Set<string>; queue: string[] }>({
    set: new Set(),
    queue: [],
  });

  useEffect(() => {
    const socket = getClientSocket();

    const onActivity: Parameters<typeof socket.on<"team:channel:activity">>[1] = (
      payload,
    ) => {
      // Never alert on your own send.
      if (payload.authorUserId === currentUserId) return;
      // Alert on an @-mention in a channel, OR on any message in a DM.
      // `mentionedUserIds` is strictly parsed @-mentions, and a DM carries no
      // implicit mention — so without the DM branch every message after the
      // first in a conversation was completely silent.
      const isDm = dmIdsRef.current.has(payload.channelId);
      if (!isDm && !payload.mentionedUserIds.includes(currentUserId)) return;

      // The activity frame is content-lean and carries no messageId, so the
      // dedupe key is (channel, lastMessageAt) — unique per top-level message.
      //
      // Thread replies send `lastMessageAt: null`, which gives no usable key,
      // so they skip dedupe entirely and lean on playTeamTone's throttle. That
      // errs toward alerting twice rather than swallowing a real mention,
      // which is the right way to be wrong here.
      if (payload.lastMessageAt) {
        const id = `${payload.channelId}:${payload.lastMessageAt}`;
        const seen = seenRef.current;
        if (seen.set.has(id)) return;
        seen.set.add(id);
        seen.queue.push(id);
        if (seen.queue.length > DEDUP_CAP) {
          const evicted = seen.queue.shift();
          if (evicted !== undefined) seen.set.delete(evicted);
        }
      }

      // Suppress when you're demonstrably already looking at that channel in a
      // focused tab — you can see it arrive. A hidden tab always alerts.
      const visible =
        typeof document === "undefined" || document.visibilityState === "visible";
      if (visible && pathnameRef.current === `/team/${payload.channelId}`) return;

      notificationSound.playTeamTone();
      toast(isDm ? "New direct message" : "You were mentioned in team chat", {
        description: "Open team chat to read it.",
        action: {
          label: "Open",
          onClick: () => router.push(`/team/${payload.channelId}`),
        },
      });
    };

    // A brand-new DM is itself the signal — there's no message yet to mention
    // you. Note this frame goes to BOTH participants (it carries no author to
    // filter on), so the starter would otherwise toast themselves: suppress by
    // recognising the id we ourselves just navigated to, and dedupe so a
    // connection-state-recovery replay can't re-fire it.
    const onDmCreated: Parameters<typeof socket.on<"team:dm:created">>[1] = (payload) => {
      const id = `dm:${payload.channelId}`;
      const seen = seenRef.current;
      if (seen.set.has(id)) return;
      seen.set.add(id);
      seen.queue.push(id);
      if (seen.queue.length > DEDUP_CAP) {
        const evicted = seen.queue.shift();
        if (evicted !== undefined) seen.set.delete(evicted);
      }

      // The starter is mid-navigation when this lands, so a pathname check
      // alone misses them. `justOpenedDmRef` is stamped by the New-DM dialog
      // via the module-level helper below.
      if (recentlyOpenedDmIds.has(payload.channelId)) return;

      const visible =
        typeof document === "undefined" || document.visibilityState === "visible";
      if (visible && pathnameRef.current === `/team/${payload.channelId}`) return;

      notificationSound.playTeamTone();
      toast("New direct message", {
        action: {
          label: "Open",
          onClick: () => router.push(`/team/${payload.channelId}`),
        },
      });
    };

    socket.on("team:channel:activity", onActivity);
    socket.on("team:dm:created", onDmCreated);
    return () => {
      socket.off("team:channel:activity", onActivity);
      socket.off("team:dm:created", onDmCreated);
    };
  }, [currentUserId, router]);

  return null;
}
