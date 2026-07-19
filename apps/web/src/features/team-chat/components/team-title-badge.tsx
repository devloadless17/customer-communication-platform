"use client";

import { useEffect } from "react";

import { useTeamChannels, useTeamDms } from "@/features/team-chat/contexts/team-chat-data";
import { useLiveTeamName } from "@/hooks/use-live-team-name";

/**
 * Puts the unread count in the browser tab title while you're on /team.
 *
 * Null-rendering, and mounted INSIDE the /team layout on purpose: exactly one
 * component may own `document.title` per route. The inbox owns it on /inbox
 * (inbox-shell.tsx); adding a second app-wide writer would make the two fight
 * over the title on every render.
 *
 * Cross-page awareness is the app rail's job (it carries its own
 * server-seeded mention badge), so there's no need to couple those two.
 */
export function TeamTitleBadge({ teamName }: { teamName: string }) {
  const channels = useTeamChannels();
  const dms = useTeamDms();
  const liveTeamName = useLiveTeamName(teamName);

  // Mentions across channels + anything unread in a DM. A DM is inherently
  // addressed to you, so it counts even without an explicit @-mention —
  // that's the whole difference between a DM and a busy channel.
  const mentionCount = channels.reduce((sum, c) => sum + c.unreadMentionCount, 0);
  const dmCount = dms.reduce(
    (sum, d) => sum + (d.unreadForMe ? 1 : 0) + d.unreadMentionCount,
    0,
  );
  const total = mentionCount + dmCount;

  useEffect(() => {
    const previous = document.title;
    const base = `Team chat · ${liveTeamName}`;
    document.title = total > 0 ? `(${total}) ${base}` : base;
    // Release ownership on unmount. Without this, navigating to a route whose
    // client-side metadata doesn't re-assert a title leaves "(3) Team chat ·
    // Acme" stuck in the tab.
    return () => {
      document.title = previous;
    };
  }, [total, liveTeamName]);

  return null;
}
