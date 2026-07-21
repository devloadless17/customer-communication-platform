"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";
import { notificationSound } from "@/lib/notifications/notification-sound";
import { toast } from "@/lib/toast";

/**
 * App-wide alerts for team chat: an @-mention or a DM message should reach you
 * on any page, not just /team.
 *
 * NOTE — creating a DM is deliberately SILENT. `team:dm:created` fans to both
 * participants, but an empty DM is not news: the peer's sidebar already grows
 * the row (the DM list refetches on that same frame), and alerting on it meant
 * a toast + ding for a conversation with nothing in it. The first real message
 * alerts through `team:channel:activity` below, like Slack.
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
  // LIVE set, not the server snapshot. `dmChannelIds` is rendered once by the
  // (app) layout, which is a shared segment that does not re-render on client
  // navigation — so a DM started AFTER this tab loaded was never in the set,
  // and every message in it was silently unalerted for the rest of the
  // session. `team:dm:created` (handled below) grows the set.
  const dmIdsRef = useRef<Set<string>>(new Set(dmChannelIds));
  useEffect(() => {
    for (const id of dmChannelIds) dmIdsRef.current.add(id);
  }, [dmChannelIds]);

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

    // Registration only — deliberately silent (see the note at the top of this
    // file). Its job is to teach this tab that the channel is a DM, so the
    // FIRST real message in it alerts through `onActivity` above.
    const onDmCreated: Parameters<typeof socket.on<"team:dm:created">>[1] = (
      payload,
    ) => {
      dmIdsRef.current.add(payload.channelId);
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
