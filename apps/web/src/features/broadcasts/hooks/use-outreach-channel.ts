"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Which channel the Outreach section is scoped to.
 *
 * A campaign targets exactly ONE channel, and each channel carries different
 * assets — WhatsApp has a template catalogue and Meta's template library, the
 * social channels have neither. Scoping the section to a channel is what stops
 * "Templates" from silently meaning "WhatsApp templates" in a nav that also
 * lists Messenger and Instagram work.
 *
 * Held in `localStorage` rather than a route segment or a cookie:
 *   - a route segment would move every broadcast URL, breaking shared links;
 *   - a cookie would make the SERVER render a channel-specific page, which is
 *     wrong for a purely navigational preference (and would need invalidating).
 * It is a per-browser preference for where you left off, nothing more — every
 * page still reads its real scope from its own state or query string.
 */

export type OutreachChannel = "whatsapp" | "messenger" | "instagram";

export const OUTREACH_CHANNEL_LABEL: Record<OutreachChannel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

const STORAGE_KEY = "ccp.outreach.channel";
const ORDER: OutreachChannel[] = ["whatsapp", "messenger", "instagram"];

function readStored(): OutreachChannel | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return ORDER.includes(v as OutreachChannel) ? (v as OutreachChannel) : null;
  } catch {
    // Private mode / storage disabled — fall back to the default, don't throw.
    return null;
  }
}

export function useOutreachChannel(): {
  channel: OutreachChannel;
  setChannel: (c: OutreachChannel) => void;
  /** Channels this workspace has actually connected, in a stable order. */
  available: OutreachChannel[];
} {
  // Always starts at the SSR-safe default so the first client render matches the
  // server's; the stored preference is applied in an effect. Reading
  // localStorage during render would hydration-mismatch.
  const [channel, setChannelState] = useState<OutreachChannel>("whatsapp");
  const [available, setAvailable] = useState<OutreachChannel[]>(["whatsapp"]);

  useEffect(() => {
    const stored = readStored();
    if (stored) setChannelState(stored);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/channel-accounts");
        if (!res.ok) return;
        const data = (await res.json()) as {
          accounts?: Array<{ channel: string; isActive: boolean }>;
        };
        const live = ORDER.filter((c) =>
          (data.accounts ?? []).some((a) => a.channel === c && a.isActive),
        );
        if (cancelled) return;
        // Never render an EMPTY switcher: a workspace mid-onboarding has no
        // connected channel yet, and an empty select is worse than showing
        // WhatsApp (where the connect flow lives).
        setAvailable(live.length > 0 ? live : ["whatsapp"]);
        // A stored preference for a channel that has since been disconnected
        // would scope the section to a dead end.
        setChannelState((cur) => (live.length > 0 && !live.includes(cur) ? live[0]! : cur));
      } catch {
        // Leave the default — the nav must render regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setChannel = useCallback((next: OutreachChannel) => {
    setChannelState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference just won't persist; the selection still applies this session.
    }
  }, []);

  return { channel, setChannel, available };
}
